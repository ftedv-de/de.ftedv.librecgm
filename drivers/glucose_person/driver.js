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
      const registration = await this.homey.app.accountManager.registerAccount({
        credentials,
        auth: client.exportAuth(),
        connections,
      });

      this.pairSession = {
        accountId: registration.accountId,
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
          accountId: this.pairSession.accountId,
          patientName: connection.name
        },
        settings: {
          glucose_unit: 'account'
        }
      }));
    });
  }

};
