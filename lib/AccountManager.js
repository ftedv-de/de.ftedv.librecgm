'use strict';

const crypto = require('crypto');
const LibreViewClient = require('./LibreViewClient');

const STORE_KEY = 'libreLinkUpAccounts';
const POLL_INTERVAL_MS = 60 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

module.exports = class AccountManager {
  constructor({ homey, debug = () => {} }) {
    this.homey = homey;
    this.debug = debug;
    this.accounts = new Map();
    this.registrationPromises = new Map();
  }

  async init() {
    const storedAccounts = this.homey.settings.get(STORE_KEY);

    for (const stored of Array.isArray(storedAccounts) ? storedAccounts : []) {
      if (!stored?.id || !stored?.credentials) continue;
      this.accounts.set(stored.id, this.createAccount(stored));
    }
  }

  createAccount(stored) {
    return {
      ...stored,
      client: new LibreViewClient({
        ...stored.credentials,
        auth: stored.auth ?? null,
      }),
      subscribers: new Map(),
      cache: new Map(),
      timer: null,
      polling: false,
      failures: 0,
    };
  }

  accountKey(credentials) {
    const region = String(credentials?.region || 'eu').toLowerCase();
    const email = String(credentials?.email || '').trim().toLowerCase();
    return `${region}:${email}`;
  }

  accountId(credentials, auth) {
    const identity = auth?.accountId || this.accountKey(credentials);
    return crypto.createHash('sha256')
      .update(`${String(credentials?.region || 'eu').toLowerCase()}:${identity}`)
      .digest('hex');
  }

  async registerAccount({
    credentials,
    auth = null,
    connections = null,
    patientId = null,
  }) {
    if (!credentials?.email || !credentials?.password) {
      throw new Error('LibreLinkUp email and password are required');
    }

    const key = this.accountKey(credentials);
    let registration = this.registrationPromises.get(key);

    if (!registration) {
      registration = this.registerAccountOnce({
        credentials,
        auth,
        connections,
      }).finally(() => this.registrationPromises.delete(key));

      this.registrationPromises.set(key, registration);
    }

    const result = await registration;
    if (!patientId) return result;

    if (!result.connections.some((connection) => (connection.patientId || connection.id) === patientId)) {
      throw new Error('LibreLinkUp patient is no longer shared with this account');
    }

    const account = this.accounts.get(result.accountId);
    const reading = await this.fetchReading(account, patientId);
    account.cache.set(patientId, reading);
    await this.persist();

    return {
      ...result,
      reading,
    };
  }

  async registerAccountOnce({ credentials, auth, connections }) {
    const normalizedCredentials = {
      email: String(credentials.email).trim(),
      password: credentials.password,
      region: String(credentials.region || 'eu').toLowerCase(),
    };

    let account = [...this.accounts.values()].find((item) => this.accountKey(item.credentials) === this.accountKey(normalizedCredentials));

    const client = account?.client ?? new LibreViewClient({
      ...normalizedCredentials,
      auth,
    });

    client.email = normalizedCredentials.email;
    client.password = normalizedCredentials.password;
    client.region = normalizedCredentials.region;

    let verifiedConnections = connections;
    try {
      verifiedConnections = verifiedConnections ?? await client.getConnections();
    } catch (err) {
      if (!client.isAuthError(err)) throw err;
      await client.login();
      verifiedConnections = await client.getConnections();
    }

    const exportedAuth = client.exportAuth();
    const id = account?.id ?? this.accountId(normalizedCredentials, exportedAuth);

    if (!account) {
      account = this.createAccount({
        id,
        credentials: normalizedCredentials,
        auth: exportedAuth,
      });
      account.client = client;
      this.accounts.set(id, account);
    } else {
      account.credentials = normalizedCredentials;
      account.auth = exportedAuth;
      account.client = client;
    }

    await this.persist();

    return {
      accountId: account.id,
      connections: verifiedConnections,
    };
  }

  async fetchReading(account, patientId, sensorLifetimeDays = 15) {
    try {
      const reading = await account.client.getConnectionReading(patientId, {
        sensorLifetimeDays,
      });
      account.auth = account.client.exportAuth();
      return reading;
    } catch (err) {
      if (!account.client.isAuthError(err)) throw err;

      this.debug(`Re-authenticating LibreLinkUp account ${account.id}`);
      await account.client.login();
      account.auth = account.client.exportAuth();
      const reading = await account.client.getConnectionReading(patientId, {
        sensorLifetimeDays,
      });
      account.auth = account.client.exportAuth();
      return reading;
    }
  }

  subscribe(accountId, patientId, subscriber) {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error('LibreLinkUp account is not registered');

    if (!account.subscribers.has(patientId)) {
      account.subscribers.set(patientId, new Set());
    }

    account.subscribers.get(patientId).add(subscriber);

    const cached = account.cache.get(patientId);
    if (cached) {
      Promise.resolve(subscriber.onReading(cached)).catch((err) => this.homey.app.error('Delivering cached glucose reading failed:', err));
    }

    this.schedule(account, 0);

    return () => {
      const subscribers = account.subscribers.get(patientId);
      subscribers?.delete(subscriber);
      if (subscribers?.size === 0) account.subscribers.delete(patientId);

      if (account.subscribers.size === 0 && account.timer) {
        this.homey.clearTimeout(account.timer);
        account.timer = null;
      }
    };
  }

  schedule(account, delay) {
    if (account.timer || account.polling || account.subscribers.size === 0) return;

    account.timer = this.homey.setTimeout(() => {
      account.timer = null;
      this.poll(account).catch((err) => this.homey.app.error('Account polling failed:', err));
    }, delay);
  }

  async poll(account) {
    if (account.polling || account.subscribers.size === 0) return;
    account.polling = true;
    let nextDelay = POLL_INTERVAL_MS;

    try {
      for (const [patientId, subscribers] of account.subscribers) {
        const sensorLifetimeDays = [...subscribers]
          .map((item) => item.sensorLifetimeDays)
          .find(Number.isFinite) ?? 15;
        const reading = await this.fetchReading(account, patientId, sensorLifetimeDays);
        account.cache.set(patientId, reading);

        await Promise.all([...subscribers].map((subscriber) => subscriber.onReading(reading)));
      }

      account.failures = 0;
      await this.persist();
    } catch (err) {
      account.failures += 1;
      nextDelay = Math.min(
        POLL_INTERVAL_MS * (2 ** Math.min(account.failures - 1, 4)),
        MAX_BACKOFF_MS,
      );

      for (const subscribers of account.subscribers.values()) {
        for (const subscriber of subscribers) {
          Promise.resolve(subscriber.onError?.(err)).catch((error) => this.homey.app.error('Delivering polling error failed:', error));
        }
      }

      throw err;
    } finally {
      account.polling = false;
      this.schedule(account, nextDelay);
    }
  }

  async persist() {
    const accounts = [...this.accounts.values()].map((account) => ({
      id: account.id,
      credentials: account.credentials,
      auth: account.client.exportAuth() ?? account.auth,
    }));

    this.homey.settings.set(STORE_KEY, accounts);
  }

  destroy() {
    for (const account of this.accounts.values()) {
      if (account.timer) this.homey.clearTimeout(account.timer);
    }
  }
};
