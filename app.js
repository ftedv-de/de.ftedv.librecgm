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
};
