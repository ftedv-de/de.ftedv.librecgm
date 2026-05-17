'use strict';

const crypto = require('crypto');

module.exports = class LibreViewClient {
  constructor({
    email,
    password,
    region = 'eu',
    auth = null,
  } = {}) {
    this.email = email;
    this.password = password;
    this.region = region;
    this.auth = auth;
    this.user = null;
  }

  get baseUrl() {
    switch ((this.region || 'eu').toLowerCase()) {
      case 'de':
        return 'https://api-de.libreview.io';
      case 'eu':
        return 'https://api-eu.libreview.io';
      case 'us':
        return 'https://api-us.libreview.io';
      case 'global':
        return 'https://api.libreview.io';
    }
  }

  exportAuth() {
    return this.auth;
  }

  async login() {
    if (!this.email || !this.password) {
      throw new Error('LibreLinkUp email and password are required');
    }

    const res = await this.request('/llu/auth/login', {
      method: 'POST',
      auth: false,
      body: {
        email: this.email,
        password: this.password,
      },
    });

    const ticket = res?.data?.authTicket;
    if (!ticket?.token) {
      throw new Error('LibreLinkUp login did not return an auth token');
    }

    this.auth = {
      token: ticket.token,
      expires: ticket.expires ?? null,
      duration: ticket.duration ?? null,
      accountId: res.data.user.id
    };

    this.user = res.data.user ?? null;

    return true;
  }

  async getConnections() {
    const res = await this.request('/llu/connections', {
      method: 'GET',
      auth: true,
    });

    const connections = Array.isArray(res?.data) ? res.data : [];

    return connections.map(connection => ({
      id: connection.patientId || connection.id,
      connectionId: connection.id,
      patientId: connection.patientId,
      name: [connection.firstName, connection.lastName].filter(Boolean).join(' ') || 'LibreView Patient',
      country: connection.country,
      unit: this.uomToUnit(connection.uom),
      targetLowMgDl: connection.targetLow ?? connection.alarmRules?.l?.th ?? 70,
      targetHighMgDl: connection.targetHigh ?? connection.alarmRules?.h?.th ?? 180,
      raw: connection,
    }));
  }

  async getConnectionReading(patientId, options = {}) {
    if (!patientId) {
      throw new Error('Missing patientId');
    }

    const res = await this.request(`/llu/connections/${encodeURIComponent(patientId)}/graph`, {
      method: 'GET',
      auth: true,
    });

    if (res?.ticket?.token) {
      this.auth = {
        ...this.auth,
        token: res.ticket.token,
        expires: res.ticket.expires ?? this.auth?.expires ?? null,
        duration: res.ticket.duration ?? this.auth?.duration ?? null
      };
    }

    const data = res?.data;
    const connection = data?.connection;
    const measurement = connection?.glucoseMeasurement || connection?.glucoseItem;

    if (!measurement) {
      throw new Error('No glucose measurement available');
    }

    return LibreViewClient.normalizeReading({
      measurement,
      connection,
      graphData: data?.graphData,
      activeSensors: data?.activeSensors,
      sensorLifetimeDays: options.sensorLifetimeDays ?? 16
    });
  }

  async request(path, { method = 'GET', auth = true, body = undefined } = {}) {
    if (auth && !this.auth?.token) {
      await this.login();
    }

    const headers = {
      product: 'llu.android',
      version: '4.17.0',
      accept: 'application/json',
      'content-type': 'application/json',
    };

    if (auth) {
      headers.Authorization = `Bearer ${this.auth.token}`;

      if (this.auth.accountId) {
        headers['Account-Id'] = crypto
          .createHash('sha256')
          .update(this.auth.accountId)
          .digest('hex');
      }
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let json;

    try {
      json = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error(`LibreLinkUp returned invalid JSON: HTTP ${response.status}`);
    }

    if (!response.ok || json.status !== 0) {
      const message = json?.error?.message || json?.message || `HTTP ${response.status}`;
      throw new Error(`LibreLinkUp request failed: ${message}`);
    }

    return json;
  }

  static normalizeReading({
    measurement,
    connection,
    graphData = [],
    activeSensors = [],
    sensorLifetimeDays = 16
  }) {
    const valueMgDl = Number(measurement.ValueInMgPerDl);
    const unit = LibreViewClient.uomToUnitStatic(measurement.GlucoseUnits ?? connection?.uom);

    const valueMmol = LibreViewClient.mgDlToMmol(valueMgDl);

    const previous = Array.isArray(graphData) && graphData.length > 0
      ? graphData[graphData.length - 1]
      : null;

    const previousMgDl = previous?.ValueInMgPerDl != null
      ? Number(previous.ValueInMgPerDl)
      : null;

    const deltaMgDl = previousMgDl != null
      ? valueMgDl - previousMgDl
      : 0;

    const targetLowMgDl = connection?.targetLow ?? connection?.alarmRules?.l?.th ?? 70;
    const targetHighMgDl = connection?.targetHigh ?? connection?.alarmRules?.h?.th ?? 180;

    return {
      value: unit === 'mmol/L' ? valueMmol : valueMgDl,
      unit,

      valueMgDl,
      valueMmol,

      deltaMgDl,
      deltaMmol: LibreViewClient.mgDlToMmol(deltaMgDl),

      targetLowMgDl,
      targetHighMgDl,

      trend: LibreViewClient.trendArrowToText(measurement.TrendArrow),
      trendArrow: measurement.TrendArrow ?? null,

      timestamp: measurement.Timestamp ?? measurement.FactoryTimestamp ?? new Date().toISOString(),

      isHigh: measurement.isHigh ?? valueMgDl > targetHighMgDl,
      isLow: measurement.isLow ?? valueMgDl < targetLowMgDl,

      sensorExpiryHours: LibreViewClient.calculateSensorExpiryHours(
        connection?.sensor,
        activeSensors,
        sensorLifetimeDays
      ),
    };
  }

  static calculateSensorExpiryHours(sensor, activeSensors = [], sensorLifetimeDays = 16) {
    const sensors = [
      sensor,
      ...(Array.isArray(activeSensors)
        ? activeSensors.map(x => x.sensor)
        : [])
    ].filter(Boolean);

    const s = sensors.find(x => x?.a);
    if (!s) return null;

    const activatedAtSeconds = Number(s.a);
    if (!Number.isFinite(activatedAtSeconds)) return null;

    const expiresAtMs =
      activatedAtSeconds * 1000 +
      sensorLifetimeDays * 24 * 60 * 60 * 1000;

    return Math.max(0, Math.round((expiresAtMs - Date.now()) / 3600000));
  }

  static parseLibreDate(value) {
    if (!value) return null;

    if (typeof value === 'number') {
      const ms = value > 9999999999 ? value : value * 1000;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    if (typeof value === 'string') {
      const normalized = value.includes('T')
        ? value
        : value.replace(' ', 'T');

      const date = new Date(normalized);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
  }

  isAuthError(err) {
  const msg = String(err?.message || err);
  return msg.includes('401') ||
         msg.includes('Unauthorized') ||
         msg.includes('invalid_token') ||
         msg.includes('TokenExpired');
}

  uomToUnit(uom) {
    return LibreViewClient.uomToUnitStatic(uom);
  }

  static uomToUnitStatic(uom) {
    const value = String(uom ?? '1');
    return value === '2' ? 'mmol/L' : 'mg/dL';
  }

  static mgDlToMmol(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
    return Math.round((Number(value) / 18.0182) * 10) / 10;
  }

  static mmolToMgDl(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
    return Math.round(Number(value) * 18.0182);
  }

  static trendArrowToText(value) {
    switch (Number(value)) {
      case 1:
        return 'falling_quickly';
      case 2:
        return 'falling';
      case 3:
        return 'flat';
      case 4:
        return 'rising';
      case 5:
        return 'rising_quickly';
      default:
        return 'unknown';
    }
  }
};