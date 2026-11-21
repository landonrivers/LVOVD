'use strict';

const { once } = require('node:events');

async function listenLoopback(server) {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return server.address().port;
}

module.exports = { listenLoopback };
