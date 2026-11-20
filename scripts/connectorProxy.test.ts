// The relay between the language server and MATLAB's connector, against the fake HTTPS connector
// (test/fake/fakeConnector.js, self-signed test certificate). Run: npm run test:unit
import * as assert from 'assert';
import * as http from 'http';
import { startConnectorProxy } from '../src/backend/connectorProxy';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fakeConnector = require('../test/fake/fakeConnector.js');

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function upgradeEcho(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
    req.on('upgrade', (_res, socket) => {
      socket.once('data', d => { resolve(String(d)); socket.destroy(); });
      socket.write('hello through the relay');
    });
    req.on('response', r => resolve(`refused ${r.statusCode}`));
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  for (const basePath of ['', '/connector-base']) {
    const conn = await fakeConnector.start({ apiKey: 'secret-key', basePath });
    const proxy = await startConnectorProxy({ port: conn.port, certificate: conn.certificate, apiKey: 'secret-key', basePath: basePath + '/' });
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/messageservice\/async$/);

    // HTTP (Bayeux long polling): reaches the connector with the API key added and the origin removed.
    const r = await post(proxy.url, JSON.stringify([{ channel: '/meta/handshake', id: '1' }]), { Origin: 'http://evil.example' });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.text, /"successful":true/);
    const last = conn.requests[conn.requests.length - 1];
    assert.strictEqual(last.apikey, 'secret-key');
    assert.strictEqual(last.origin, undefined, 'origin header removed');
    assert.strictEqual(last.url, `${basePath}/messageservice/async`, 'secret prefix replaced by the connector base path');

    // WebSocket upgrade: bytes flow both ways.
    assert.strictEqual(await upgradeEcho(proxy.url), 'hello through the relay');
    assert.strictEqual(conn.requests[conn.requests.length - 1].apikey, 'secret-key');

    // Requests without the secret prefix are refused (other local programs cannot use the relay).
    const port = proxy.port;
    assert.strictEqual((await post(`http://127.0.0.1:${port}/messageservice/async`, '[]')).status, 404);
    assert.strictEqual(await upgradeEcho(`http://127.0.0.1:${port}/messageservice/async`), 'refused 404');

    // Connector gone: 502, not a hang.
    await conn.close();
    assert.strictEqual((await post(proxy.url, '[]')).status, 502);
    await proxy.close();
  }

  // A wrong API key is passed through as the connector's refusal.
  const conn = await fakeConnector.start({ apiKey: 'right' });
  const proxy = await startConnectorProxy({ port: conn.port, certificate: conn.certificate, apiKey: 'wrong' });
  assert.strictEqual((await post(proxy.url, '[]')).status, 401);
  await proxy.close();
  await conn.close();

  console.log('connectorProxy: all assertions passed');
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
