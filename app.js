'use strict';

const Homey = require('homey');

module.exports = class LibreCGM extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('LibreCGM has been initialized');
  }

  isDebugEnabled() {
    return this.homey.settings.get('debug_logging') === true;
  }

  debug(...args) {
    if (this.isDebugEnabled()) {
      this.log('[debug]', ...args);
    }
  }

  getGlucoseDeviceById(deviceId) {
    const driver = this.homey.drivers.getDriver('glucose_person');
    const devices = driver.getDevices();

    if (!deviceId) {
      return devices[0] ?? null;
    }

    return devices.find(device =>
      device.getId?.() === deviceId ||
      device.getData()?.id === deviceId
    ) ?? null;
  }

  async getGlucoseDashboardData(deviceId) {
    const device = this.getGlucoseDeviceById(deviceId);

    if (!device) {
      throw new Error('No LibreView patient device found');
    }

    return device.getDashboardData();
  }
};