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

    // ###############################
    // ### Measurements
    // ###############################
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

    

    // ###############################
    // ### Sensor Expiry
    // ###############################
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

    // ###############################
    // ### Glucose high / low
    // ###############################
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

    await this.setStoreValue('lastReading', {
      timestamp: reading.timestamp,
      valueMgDl: reading.valueMgDl,
      valueMmol: reading.valueMmol,
      trend: reading.trend,
    });

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