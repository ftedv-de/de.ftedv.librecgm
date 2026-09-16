'use strict';

module.exports = {
  async getGlucoseSummary({ homey, query }) {
    return homey.app.getGlucoseSummaryData(query?.deviceId, query?.rangeDays);
  },
};
