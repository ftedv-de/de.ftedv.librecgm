'use strict';

const Homey = require('homey');
const AccountManager = require('./lib/AccountManager');

module.exports = class LibreCGM extends Homey.App {

  async onInit() {
    this.accountManager = new AccountManager({
      homey: this.homey,
      debug: (...args) => this.debug(...args),
    });
    await this.accountManager.init();
    this.log('LibreCGM has been initialized');
  }

  async onUninit() {
    this.accountManager?.destroy();
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

    return devices.find((device) => device.getId?.() === deviceId
      || device.getData()?.id === deviceId) ?? null;
  }

  async getGlucoseDashboardData(deviceId) {
    const device = this.getGlucoseDeviceById(deviceId);

    if (!device) {
      throw new Error('No LibreView patient device found');
    }

    return device.getDashboardData();
  }

  async getGlucoseSummaryData(deviceId, rangeDays) {
    const device = this.getGlucoseDeviceById(deviceId);

    if (!device) {
      throw new Error('No LibreView patient device found');
    }

    return {
      deviceName: device.getName(),
      ...device.getLongTermSummary(rangeDays),
    };
  }

  async getGlucosePeopleData(deviceIds = []) {
    const driver = this.homey.drivers.getDriver('glucose_person');
    const selectedIds = new Set(Array.isArray(deviceIds) ? deviceIds : []);
    const devices = driver.getDevices().filter((device) => selectedIds.has(device.getId?.())
      || selectedIds.has(device.getData()?.id));

    return {
      people: devices.map((device) => ({
        deviceId: device.getId?.() ?? device.getData()?.id,
        ...device.getDashboardData(),
      })),
    };
  }

};
