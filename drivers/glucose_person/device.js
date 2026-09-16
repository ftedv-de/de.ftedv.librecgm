'use strict';

const Homey = require('homey');

module.exports = class LibreViewDevice extends Homey.Device {

  async onInit() {
    this.homey.app.debug(`LibreView device initialized: ${this.getName()}`);

    if (!this.hasCapability('sensor_serial_number')) {
      await this.addCapability('sensor_serial_number');
    }

    const { patientId } = this.getData();
    if (!patientId) throw new Error('Missing patientId');

    const sensorLifetimeDays = this.getSetting('sensor_lifetime_days') ?? 15;
    let accountId = this.getStoreValue('accountId');

    if (!accountId) {
      accountId = await this.migrateLegacyAccount(patientId);
    }

    this.unsubscribeAccount = this.homey.app.accountManager.subscribe(
      accountId,
      patientId,
      {
        sensorLifetimeDays,
        onReading: (reading) => this.applyReading(reading),
        onError: (err) => this.applyConnectionError(err),
      },
    );
  }

  async migrateLegacyAccount(patientId) {
    const credentials = this.getStoreValue('credentials');
    const auth = this.getStoreValue('auth');

    if (!credentials) {
      throw new Error('Missing LibreLinkUp account reference and legacy credentials');
    }

    const registration = await this.homey.app.accountManager.registerAccount({
      credentials,
      auth,
      patientId,
    });

    if (registration.reading) {
      await this.applyReading(registration.reading);
    }

    await this.setStoreValue('accountId', registration.accountId);

    // Credentials are removed only after the account, patient and first poll were verified.
    await this.unsetStoreValue('credentials');
    await this.unsetStoreValue('auth');
    this.homey.app.debug(
      `Migrated LibreView device ${this.getName()} to account ${registration.accountId}`,
    );

    return registration.accountId;
  }

  async applyConnectionError(err) {
    const message = err?.message || String(err);
    await this.setStoreValue('connectionError', message);
    await this.setUnavailable(message);
  }

  async applyReading(reading) {
    this.homey.app.debug('Reading: ', reading);

    const previousReading = this.getStoreValue('lastReading');
    const previousTimestamp = new Date(previousReading?.timestamp).getTime();
    const timestamp = new Date(reading.timestamp).getTime();
    const isNewReading = !Number.isFinite(previousTimestamp) || previousTimestamp !== timestamp;
    const previousHigh = this.getCapabilityValue('alarm_glucose_high');
    const previousLow = this.getCapabilityValue('alarm_glucose_low');
    const targetRange = this.getEffectiveTargetRange(reading);
    const isHigh = reading.valueMgDl > targetRange.highMgDl;
    const isLow = reading.valueMgDl < targetRange.lowMgDl;

    await this.setCapabilityValue('measure_glucose_mgdl', reading.valueMgDl);
    await this.setCapabilityValue('measure_glucose_mmol', reading.valueMmol);
    await this.setCapabilityValue('measure_glucose_delta_mgdl', reading.deltaMgDl);
    await this.setCapabilityValue('measure_glucose_delta_mmol', reading.deltaMmol);
    await this.setCapabilityValue('glucose_trend', reading.trend);

    if (reading.sensorSerialNumber !== null) {
      await this.setCapabilityValue('sensor_serial_number', reading.sensorSerialNumber);
    }

    if (reading.sensorExpiryHours !== null) {
      await this.setCapabilityValue('sensor_expiry_hours', reading.sensorExpiryHours);
    }

    const previousSensorExpiringSoon = this.getStoreValue('sensorExpiringSoon') === true;
    const sensorExpiringSoon = reading.sensorExpiryHours !== null && reading.sensorExpiryHours <= 24;

    await this.setStoreValue('sensorExpiringSoon', sensorExpiringSoon);
    await this.setCapabilityValue('alarm_sensor_expiry', sensorExpiringSoon);
    await this.setCapabilityValue('alarm_glucose_high', isHigh);
    await this.setCapabilityValue('alarm_glucose_low', isLow);

    const lastReading = {
      timestamp: reading.timestamp,
      valueMgDl: reading.valueMgDl,
      valueMmol: reading.valueMmol,
      trend: reading.trend,
      trendArrow: reading.trendArrow,
    };

    await this.mergeGlucoseHistory([
      ...(Array.isArray(reading.history) ? reading.history : []),
      lastReading,
    ]);
    await this.setStoreValue('lastSuccessfulPoll', new Date().toISOString());
    await this.setStoreValue('connectionError', null);
    await this.setStoreValue('targetRange', targetRange);
    await this.setAvailable();

    if (!isNewReading) return;

    await this.setStoreValue('lastReading', lastReading);

    if (!previousSensorExpiringSoon && sensorExpiringSoon) {
      await this.homey.flow.getDeviceTriggerCard('sensor_expiring_soon').trigger(this, {
        hours_remaining: reading.sensorExpiryHours,
      });
    }

    if (!previousHigh && isHigh) {
      await this.homey.flow.getDeviceTriggerCard('glucose_high').trigger(this, {
        glucose_mgdl: reading.valueMgDl,
        glucose_mmol: reading.valueMmol,
      });
    }

    if (!previousLow && isLow) {
      await this.homey.flow.getDeviceTriggerCard('glucose_low').trigger(this, {
        glucose_mgdl: reading.valueMgDl,
        glucose_mmol: reading.valueMmol,
      });
    }

    const trendTokens = {
      glucose_mgdl: reading.valueMgDl,
      glucose_mmol: reading.valueMmol,
      delta_mgdl: reading.deltaMgDl,
      delta_mmol: reading.deltaMmol,
    };

    if (reading.trend === 'rising_quickly'
      && previousReading?.trend !== 'rising_quickly') {
      await this.homey.flow
        .getDeviceTriggerCard('glucose_rising_quickly')
        .trigger(this, trendTokens);
    }

    if (reading.trend === 'falling_quickly'
      && previousReading?.trend !== 'falling_quickly') {
      await this.homey.flow
        .getDeviceTriggerCard('glucose_falling_quickly')
        .trigger(this, trendTokens);
    }

    await this.homey.flow.getDeviceTriggerCard('glucose_updated').trigger(this, {
      glucose_mgdl: reading.valueMgDl,
      glucose_mmol: reading.valueMmol,
      trend: reading.trend,
    });

    this.homey.app.debug(
      `Updated glucose value: ${reading.valueMgDl} mg/dL (${reading.valueMmol} mmol/L)`,
    );
  }

  async mergeGlucoseHistory(entries) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const history = Array.isArray(this.getStoreValue('glucoseHistory24h'))
      ? this.getStoreValue('glucoseHistory24h')
      : [];
    const merged = new Map();
    const current = entries.at(-1);
    const imported = entries.slice(0, -1);

    // Imported graph data fills gaps; existing local samples remain authoritative.
    for (const item of [...imported, ...history, current]) {
      const timestamp = new Date(item?.timestamp).getTime();
      if (Number.isFinite(timestamp) && timestamp >= cutoff) {
        merged.set(timestamp, item);
      }
    }

    const result = [...merged.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    await this.setStoreValue('glucoseHistory24h', result);
  }

  getEffectiveTargetRange(reading = null) {
    const stored = this.getStoreValue('targetRange');
    const accountLow = Number(reading?.targetLowMgDl ?? stored?.accountLowMgDl);
    const accountHigh = Number(reading?.targetHighMgDl ?? stored?.accountHighMgDl);
    const customLow = Number(this.getSetting('target_low_mgdl'));
    const customHigh = Number(this.getSetting('target_high_mgdl'));
    const useCustom = this.getSetting('target_range_source') === 'custom'
      && Number.isFinite(customLow) && Number.isFinite(customHigh)
      && customLow < customHigh;
    let lowMgDl = Number.isFinite(accountLow) ? accountLow : 70;
    let highMgDl = Number.isFinite(accountHigh) ? accountHigh : 180;

    if (useCustom) {
      lowMgDl = customLow;
      highMgDl = customHigh;
    }

    return {
      lowMgDl,
      highMgDl,
      lowMmol: Math.round((lowMgDl / 18.0182) * 10) / 10,
      highMmol: Math.round((highMgDl / 18.0182) * 10) / 10,
      source: useCustom ? 'custom' : 'account',
      accountLowMgDl: Number.isFinite(accountLow) ? accountLow : 70,
      accountHighMgDl: Number.isFinite(accountHigh) ? accountHigh : 180,
    };
  }

  calculateTimeInRange(points, targetRange) {
    const durations = {
      low: 0, inRange: 0, high: 0, gap: 0,
    };
    const maxIntervalMs = 15 * 60 * 1000;
    const addDuration = (point, duration) => {
      const value = Number(point?.valueMgDl);
      if (!Number.isFinite(value) || duration <= 0) return;
      if (duration > maxIntervalMs) {
        durations.gap += duration;
      } else if (value < targetRange.lowMgDl) {
        durations.low += duration;
      } else if (value > targetRange.highMgDl) {
        durations.high += duration;
      } else {
        durations.inRange += duration;
      }
    };

    for (let index = 0; index < points.length - 1; index += 1) {
      const point = points[index];
      const start = new Date(point.timestamp).getTime();
      const end = new Date(points[index + 1].timestamp).getTime();
      if (Number.isFinite(start) && Number.isFinite(end)) {
        addDuration(point, end - start);
      }
    }

    const lastPoint = points.at(-1);
    const lastTimestamp = new Date(lastPoint?.timestamp).getTime();
    if (Number.isFinite(lastTimestamp)) {
      addDuration(lastPoint, Date.now() - lastTimestamp);
    }

    const covered = durations.low + durations.inRange + durations.high;
    const percentage = (value) => {
      return covered ? Math.round((value / covered) * 100) : null;
    };

    return {
      lowPercent: percentage(durations.low),
      inRangePercent: percentage(durations.inRange),
      highPercent: percentage(durations.high),
      coveredMinutes: Math.round(covered / 60000),
      gapMinutes: Math.round(durations.gap / 60000),
    };
  }

  getDashboardData() {
    const history = Array.isArray(this.getStoreValue('glucoseHistory24h'))
      ? this.getStoreValue('glucoseHistory24h')
      : [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const points = history
      .filter((item) => {
        const timestamp = new Date(item.timestamp).getTime();
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      })
      .map((item) => ({
        timestamp: item.timestamp,
        valueMgDl: item.valueMgDl,
        valueMmol: item.valueMmol,
        trend: item.trend,
        trendArrow: item.trendArrow,
      }));
    const valuesMgDl = points.map((item) => item.valueMgDl).filter(Number.isFinite);
    const valuesMmol = points.map((item) => item.valueMmol).filter(Number.isFinite);
    const lastReading = this.getStoreValue('lastReading') ?? points.at(-1) ?? null;
    const targetRange = this.getEffectiveTargetRange();

    return {
      deviceName: this.getName(),
      current: lastReading,
      history: points,
      targetRange,
      timeInRange: this.calculateTimeInRange(points, targetRange),
      stats: {
        minMgDl: valuesMgDl.length ? Math.min(...valuesMgDl) : null,
        maxMgDl: valuesMgDl.length ? Math.max(...valuesMgDl) : null,
        avgMgDl: valuesMgDl.length
          ? Math.round(valuesMgDl.reduce((sum, value) => sum + value, 0) / valuesMgDl.length)
          : null,
        minMmol: valuesMmol.length ? Math.min(...valuesMmol) : null,
        maxMmol: valuesMmol.length ? Math.max(...valuesMmol) : null,
        avgMmol: valuesMmol.length
          ? Math.round((valuesMmol.reduce((sum, value) => sum + value, 0)
            / valuesMmol.length) * 10) / 10
          : null,
      },
      status: {
        lastSuccessfulPoll: this.getStoreValue('lastSuccessfulPoll') ?? null,
        connectionError: this.getStoreValue('connectionError') ?? null,
      },
    };
  }

  async onSettings({ newSettings, changedKeys }) {
    if (newSettings.target_range_source === 'custom'
      && Number(newSettings.target_low_mgdl) >= Number(newSettings.target_high_mgdl)) {
      throw new Error('The lower target limit must be below the upper target limit');
    }

    if (changedKeys.includes('glucose_unit')) {
      this.homey.app.debug(
        `Glucose display unit changed to: ${newSettings.glucose_unit}`,
      );
    }

    return true;
  }

  async onDeleted() {
    this.homey.app.debug(`LibreView device deleted: ${this.getName()}`);
    this.unsubscribeAccount?.();
    this.unsubscribeAccount = null;
  }

};
