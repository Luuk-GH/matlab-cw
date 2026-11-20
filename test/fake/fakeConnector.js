#!/usr/bin/env node
// FAKE MATLAB web connector (what shareMATLABSession() exposes): an HTTPS server on localhost with a self-signed
// certificate that only answers requests carrying the right `mwapikey` header, on <basePath>/messageservice/async.
//   [code]  the language server talks Faye/Bayeux to https://localhost:<port>/messageservice/async with header
//           mwapikey and the connector certificate as CA (MatlabCommunicationManager.js, v1.3.16)
//   [guess] the exact Bayeux replies; the fake only answers a handshake and echoes WebSocket bytes, which is all the
//           fake language server checks. The real one speaks full Bayeux to MATLAB.
//
// Used two ways:
//   require('./fakeConnector').start({ apiKey }) -> { port, close(), requests }      (unit tests)
//   node fakeConnector.js <sessionDetails.json> [apiKey]   writes the session file like shareMATLABSession() and
//                                                          keeps running until killed       (integration tests)
'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');

const fixtures = path.join(__dirname, '..', 'fixtures');
const cert = path.join(fixtures, 'connector-test.pem');
const key = path.join(fixtures, 'connector-test.key');

function start({ apiKey = 'test-api-key', basePath = '', port = 0 } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
    requests.push({ method: req.method, url: req.url, apikey: req.headers.mwapikey, origin: req.headers.origin });
    if (req.headers.mwapikey !== apiKey) { res.writeHead(401).end('bad api key'); return; }
    if (req.url !== `${basePath}/messageservice/async`) { res.writeHead(404).end('not found'); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let msgs = [];
      try { msgs = [].concat(JSON.parse(body || '[]')); } catch { /* ignore */ }
      const replies = msgs.map(m => ({ channel: m.channel, id: m.id, successful: true, clientId: 'fake-client', version: '1.0', supportedConnectionTypes: ['websocket', 'long-polling'] }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(replies));
    });
  });
  server.on('upgrade', (req, socket) => {
    requests.push({ method: 'UPGRADE', url: req.url, apikey: req.headers.mwapikey });
    if (req.headers.mwapikey !== apiKey || req.url !== `${basePath}/messageservice/async`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    sockets.add(socket);
    socket.on('data', d => socket.write(d));   // echo
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port, requests, certificate: cert, apiKey, basePath,
      close: () => new Promise(r => { for (const s of sockets) { s.destroy(); } server.close(() => r()); }),
    }));
  });
}

module.exports = { start, cert };

if (require.main === module) {
  const file = process.argv[2];
  const apiKey = process.argv[3] || 'integration-api-key';
  start({ apiKey }).then(c => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Same fields as shareMATLABSession() writes ([code] +mcpserver/+internal/shareMATLABSession.m).
    fs.writeFileSync(file, JSON.stringify({ port: c.port, certificate: c.certificate, apiKey, pid: process.pid, basePath: '' }, null, 2));
    console.log(`fake connector on 127.0.0.1:${c.port}, session file ${file}`);
  });
}
