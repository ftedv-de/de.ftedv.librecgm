'use strict';

module.exports = {
  async getGlucoseHistory({ homey, query }) {
    return homey.app.getGlucoseDashboardData(query?.deviceId);
  },
};