'use strict';

module.exports = {
  async getPeople({ homey, query }) {
    const deviceIds = String(query?.deviceIds || '').split(',').filter(Boolean);
    return homey.app.getGlucosePeopleData(deviceIds);
  },
};
