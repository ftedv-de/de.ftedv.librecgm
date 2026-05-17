'use strict';

const Homey = require('homey');
const LibreViewClient = require('../../lib/LibreViewClient');

module.exports = class LibreViewDriver extends Homey.Driver {

  async onInit() {
    this.homey.app.debug('LibreView driver initialized');
    this.pairSession = null;
  }

  onPair(session) {
    session.setHandler('login', async credentials => {
      const client = new LibreViewClient(credentials);

      await client.login();
      const connections = await client.getConnections();

      this.pairSession = {
        credentials,
        auth: client.exportAuth(),
        connections
      };

      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!this.pairSession) {
        throw new Error('Not logged in');
      }

      return this.pairSession.connections.map(connection => ({
        name: connection.name,
        data: {
          id: connection.id,
          patientId: connection.patientId || connection.id
        },
        store: {
          credentials: this.pairSession.credentials,
          auth: this.pairSession.auth,
          patientName: connection.name
        },
        settings: {
          glucose_unit: 'account'
        }
      }));
    });
  }

};