// The whole attach chain without VS Code: session core -> LsBackend (attach) -> relay -> fake language server
// (--matlabUrl) -> fake connector. Run: npm run test:fake
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LsBackend } from '../src/backend/lsBackend';
import { MatlabSession } from '../src/matlabSession';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fakeConnector = require('../test/fake/fakeConnector.js');

const root = path.resolve(__dirname, '..');
const fake = path.join(root, 'test', 'fake', 'fakeLanguageServer.js');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const conn = await fakeConnector.start({ apiKey: 'k1' });
  const target = { port: conn.port, certificate: conn.certificate, apiKey: 'k1', basePath: '' };

  // Attach and run commands.
  const s = new MatlabSession(new LsBackend({ serverPath: fake, execPath: process.execPath, attach: target, startTimeoutMs: 10000 }));
  let out = '';
  s.on('output', t => { out += t; });
  await s.start();
  assert.strictEqual(s.release, 'R2099z', 'real release read from version(), not the loader placeholder');
  assert.strictEqual(s.state, 'idle');
  assert.ok(conn.requests.some((r: any) => r.method === 'POST' && r.apikey === 'k1'), 'handshake reached the connector');
  assert.ok(conn.requests.some((r: any) => r.method === 'UPGRADE' && r.apikey === 'k1'), 'websocket reached the connector');
  assert.strictEqual(await s.sendLine('x = 3 + 4'), 'ready');
  assert.match(out, /x =\s+7/);

  // Disconnecting does not touch the shared MATLAB: the connector keeps serving.
  s.dispose();
  await sleep(300);
  const s2 = new MatlabSession(new LsBackend({ serverPath: fake, execPath: process.execPath, attach: target, startTimeoutMs: 10000 }));
  await s2.start();
  assert.strictEqual(await s2.sendLine('disp(1)'), 'ready', 'reconnect after disconnect');

  // MATLAB going away (connector closes) ends the session.
  const exited = new Promise<string>(res => s2.on('exit', res));
  await conn.close();
  const reason = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
  assert.notStrictEqual(reason, 'timeout', 'session ends when MATLAB disappears');
  assert.strictEqual(s2.state, 'exited');

  // An ignored interrupt (seen once on R2026b) is sent again while the same command still runs.
  const conn3 = await fakeConnector.start({ apiKey: 'k3' });
  const stubborn = new MatlabSession(new LsBackend({ serverPath: fake, execPath: process.execPath,
    attach: { ...target, port: conn3.port, apiKey: 'k3' }, startTimeoutMs: 10000,
    env: { MCW_FAKE_IGNORE_FIRST_INTERRUPT: '1' } }));
  await stubborn.start();
  const longRun = stubborn.sendLine('pause(20)');
  await sleep(300);
  const tStop = Date.now();
  stubborn.interrupt();
  assert.strictEqual(await longRun, 'ready');
  assert.ok(Date.now() - tStop < 4000, `stopped by the re-sent interrupt (${Date.now() - tStop} ms)`);
  stubborn.dispose();
  await sleep(500);
  await conn3.close();

  // Wrong API key / nothing listening: a clear failure, not a hang.
  const conn2 = await fakeConnector.start({ apiKey: 'right' });
  const bad = new MatlabSession(new LsBackend({ serverPath: fake, execPath: process.execPath, attach: { ...target, port: conn2.port, apiKey: 'wrong' }, startTimeoutMs: 10000 }));
  await assert.rejects(bad.start(), /Could not connect to the shared MATLAB/);
  await conn2.close();
  const none = new MatlabSession(new LsBackend({ serverPath: fake, execPath: process.execPath, attach: { ...target, port: conn2.port }, startTimeoutMs: 10000 }));
  await assert.rejects(none.start(), /Could not connect to the shared MATLAB/);

  // A language server whose code the loader cannot patch (another extension version): fail fast, clearly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-unpatchable-'));
  const unpatchable = path.join(tmp, 'index.js');
  fs.writeFileSync(unpatchable, fs.readFileSync(fake, 'utf8').replace(/class RemoteMatlabSession extends/, 'class RemoteSession extends')
    .replace('new RemoteMatlabSession()', 'new RemoteSession()'));
  const t0 = Date.now();
  const old = new MatlabSession(new LsBackend({ serverPath: unpatchable, execPath: process.execPath, attach: target, startTimeoutMs: 10000 }));
  await assert.rejects(old.start(), /version of the MATLAB extension is not supported/);
  assert.ok(Date.now() - t0 < 5000, 'unsupported server detected quickly');
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('attach (fake connector): all assertions passed');
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
