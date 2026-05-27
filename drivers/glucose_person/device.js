'use strict';

const Homey = require('homey');
const LibreViewClient = require('../../lib/LibreViewClient');

module.exports = class LibreViewDevice extends Homey.Device {

  async onInit() {
    this.homey.app.debug(`LibreView device initialized: ${this.getName()}`);

    const credentials = this.getStoreValue('credentials');
    let auth = this.getStoreValue('auth');

    if (!credentials) {
      throw new Error('Missing LibreView credentials');
    }

    this.client = new LibreViewClient({
      ...credentials,
      auth,
    });

    if (!auth?.accountId) {
      this.homey.app.debug('Stored auth is missing accountId, logging in again...');
      await this.client.login();
      auth = this.client.exportAuth();
      await this.setStoreValue('auth', auth);
    }

    this.pollInterval = this.homey.setInterval(() => {
      this.poll().catch(err => {
        this.error('Polling failed:', err);
      });
    }, 60 * 1000);

    await this.poll();
  }

  async poll() {
    try {
      await this.pollOnce();
      await this.setAvailable();
    } catch (err) {
      if (this.client.isAuthError(err)) {
        this.homey.app.debug('Auth error detected, logging in again...');
        await this.client.login();
        await this.setStoreValue('auth', this.client.exportAuth());

        await this.pollOnce();
        await this.setAvailable();
        return;
      }

      await this.setUnavailable(err.message || String(err));
      throw err;
    }
  }

  async pollOnce() {
    const { patientId } = this.getData();

    if (!patientId) {
      throw new Error('Missing patientId');
    }

    const sensorLifetimeDays = this.getSetting('sensor_lifetime_days') ?? 15;
    const reading = await this.client.getConnectionReading(patientId, {
      sensorLifetimeDays
    });

    const previousHigh =
      this.getCapabilityValue('alarm_glucose_high');

    const previousLow =
      this.getCapabilityValue('alarm_glucose_low');

    const isHigh =
      reading.valueMgDl > reading.targetHighMgDl;

    const isLow =
      reading.valueMgDl < reading.targetLowMgDl;

    await this.setCapabilityValue(
      'measure_glucose_mgdl',
      reading.valueMgDl
    );

    await this.setCapabilityValue(
      'measure_glucose_mmol',
      reading.valueMmol
    );

    await this.setCapabilityValue(
      'measure_glucose_delta_mgdl',
      reading.deltaMgDl
    );

    await this.setCapabilityValue(
      'measure_glucose_delta_mmol',
      reading.deltaMmol
    );

    await this.setCapabilityValue(
      'glucose_trend',
      reading.trend
    );

    if (reading.sensorExpiryHours !== null) {
      await this.setCapabilityValue(
        'sensor_expiry_hours',
        reading.sensorExpiryHours
      );
    }

    const previousSensorExpiringSoon =
      this.getStoreValue('sensorExpiringSoon') === true;

    const sensorExpiringSoon =
      reading.sensorExpiryHours !== null &&
      reading.sensorExpiryHours <= 24;

    await this.setStoreValue('sensorExpiringSoon', sensorExpiringSoon);

    await this.setCapabilityValue(
      'alarm_sensor_expiry',
      sensorExpiringSoon
    );

    if (!previousSensorExpiringSoon && sensorExpiringSoon) {
      await this.homey.flow
        .getDeviceTriggerCard('sensor_expiring_soon')
        .trigger(this, {
          hours_remaining: reading.sensorExpiryHours
        });
    }

    await this.setCapabilityValue(
      'alarm_glucose_high',
      isHigh
    );

    await this.setCapabilityValue(
      'alarm_glucose_low',
      isLow
    );

    if (!previousHigh && isHigh) {
      await this.homey.flow
        .getDeviceTriggerCard('glucose_high')
        .trigger(this, {
          glucose_mgdl: reading.valueMgDl,
          glucose_mmol: reading.valueMmol
        });
    }

    if (!previousLow && isLow) {
      await this.homey.flow
        .getDeviceTriggerCard('glucose_low')
        .trigger(this, {
          glucose_mgdl: reading.valueMgDl,
          glucose_mmol: reading.valueMmol
        });
    }

    await this.setStoreValue('auth', this.client.exportAuth());

    const lastReading = {
      timestamp: reading.timestamp,
      valueMgDl: reading.valueMgDl,
      valueMmol: reading.valueMmol,
      trend: reading.trend,
      trendArrow: reading.trendArrow,
    };

    await this.setStoreValue('lastReading', lastReading);

    await this.addGlucoseHistoryEntry(lastReading);

    await this.setAvailable();

    await this.homey.flow
      .getDeviceTriggerCard('glucose_updated')
      .trigger(this, {
        glucose_mgdl: reading.valueMgDl,
        glucose_mmol: reading.valueMmol,
        trend: reading.trend
      });

    this.homey.app.debug(
      `Updated glucose value: ${reading.valueMgDl} mg/dL (${reading.valueMmol} mmol/L)`
    );
  }

  async addGlucoseHistoryEntry(entry) {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;

    const timestamp = new Date(entry.timestamp).getTime();

    if (!Number.isFinite(timestamp)) {
      return;
    }

    const history = Array.isArray(this.getStoreValue('glucoseHistory24h'))
      ? this.getStoreValue('glucoseHistory24h')
      : [];

    const filtered = history
      .filter(item => {
        const t = new Date(item.timestamp).getTime();
        return Number.isFinite(t) && t >= cutoff;
      })
      .filter(item => item.timestamp !== entry.timestamp);

    filtered.push(entry);

    filtered.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    await this.setStoreValue('glucoseHistory24h', filtered);
  }

  getDashboardData() {
    const history = Array.isArray(this.getStoreValue('glucoseHistory24h'))
      ? this.getStoreValue('glucoseHistory24h')
      : [];

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    const points = history
      .filter(item => {
        const t = new Date(item.timestamp).getTime();
        return Number.isFinite(t) && t >= cutoff;
      })
      .map(item => ({
        timestamp: item.timestamp,
        valueMgDl: item.valueMgDl,
        valueMmol: item.valueMmol,
        trend: item.trend,
        trendArrow: item.trendArrow,
      }));

    const values = points
      .map(item => item.valueMgDl)
      .filter(value => Number.isFinite(value));

    const lastReading = this.getStoreValue('lastReading') ?? points.at(-1) ?? null;

    return {
      deviceName: this.getName(),
      current: lastReading,
      history: points,
      stats: {
        minMgDl: values.length ? Math.min(...values) : null,
        maxMgDl: values.length ? Math.max(...values) : null,
        avgMgDl: values.length
          ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
          : null,
      },
    };
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('glucose_unit')) {
      this.homey.app.debug(
        `Glucose display unit changed to: ${newSettings.glucose_unit}`
      );
    }

    return true;
  }

  async onDeleted() {
    this.homey.app.debug(`LibreView device deleted: ${this.getName()}`);

    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

};