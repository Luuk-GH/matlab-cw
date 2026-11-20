// Session core + real backend code (LsBackend) against the FAKE MATLAB language server (test/fake/fakeLanguageServer.js).
// No VS Code, no MATLAB. Runs the whole suite once per fake variant, so that both answers to the open questions about
// event order (see the fake's header) are covered. Run: npm run test:fake
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LsBackend } from '../src/backend/lsBackend';
import { MatlabSession } from '../src/matlabSession';

const root = path.resolve(__dirname, '..');
const fake = path.join(root, 'test', 'fake', 'fakeLanguageServer.js');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Captured { text: string; events: { t: number; text: string; stream: string }[] }

async function withSession(env: Record<string, string>, fn: (s: MatlabSession, cap: Captured) => Promise<void>): Promise<void> {
  const backend = new LsBackend({ serverPath: fake, execPath: process.execPath, env: { MCW_FAKE_STARTUP_MS: '50', ...env }, cwd: path.join(root, 'test', 'workspace') });
  const logs: string[] = [];
  const s = new MatlabSession(backend, m => logs.push(m));
  const cap: Captured = { text: '', events: [] };
  s.on('output', (text, stream) => { cap.text += text; cap.events.push({ t: Date.now(), text, stream }); });
  try {
    await s.start();
    await fn(s, cap);
  } catch (e) {
    console.error(logs.slice(-30).join('\n'));
    throw e;
  } finally {
    s.dispose();
  }
}

async function suite(variant: string, env: Record<string, string>): Promise<void> {
  const t0 = Date.now();
  await withSession(env, async (s, cap) => {
    assert.strictEqual(s.state, 'idle', 'idle after start');
    assert.strictEqual(s.release, 'R2099z');

    // A command: output, then 'ready'.
    const states: string[] = [];
    s.on('state', st => states.push(st));
    assert.strictEqual(await s.sendLine('x = 6*7'), 'ready');
    assert.match(cap.text, /x =\s+42/);
    assert.ok(states.includes('busy') && states[states.length - 1] === 'idle', `states ${states}`);

    // Errors arrive on stderr; the session survives.
    cap.text = ''; cap.events = [];
    assert.strictEqual(await s.sendLine('y = q + 1'), 'ready');
    assert.ok(cap.events.some(e => e.stream === 'err' && /Unrecognized function or variable 'q'/.test(e.text)), cap.text);
    assert.strictEqual(await s.sendLine('disp(x)'), 'ready');

    // Streaming: output of a slow loop arrives while it runs, not only at the end.
    cap.events = [];
    const startLoop = Date.now();
    const loop = s.sendLine('for k = 1:3, disp(k), pause(0.2), end');
    await loop;
    const ts = cap.events.filter(e => /^\s+\d\n$/.test(e.text)).map(e => e.t - startLoop);
    assert.strictEqual(ts.length, 3, `three outputs, got ${JSON.stringify(cap.events)}`);
    assert.ok(ts[2] - ts[0] >= 300, `outputs spread over time: ${ts}`);

    // Queue: commands sent while busy run in order.
    cap.text = '';
    const a = s.sendLine('pause(0.2); disp(\'first\')');
    const b = s.sendLine('disp(\'second\')');
    assert.strictEqual(s.queuedCount, 2);
    assert.deepStrictEqual(await Promise.all([a, b]), ['ready', 'ready']);
    assert.ok(cap.text.indexOf('first') < cap.text.indexOf('second'), cap.text);

    // Hidden queries: results, no visible output, no visible state change.
    cap.text = '';
    const statesBefore = states.length;
    const vars = await s.query<string[]>('who');
    assert.ok(vars.ok, JSON.stringify(vars));
    assert.ok(vars.outputs[0].includes('x'), JSON.stringify(vars.outputs));
    assert.strictEqual(cap.text, '', 'queries print nothing');
    assert.strictEqual(states.length, statesBefore, `queries do not change the visible state: ${states.slice(statesBefore)}`);
    const bad = await s.query('no_such_function_xyz', []);
    assert.ok(!bad.ok && /Undefined function/.test(bad.error?.message ?? ''), JSON.stringify(bad));
    const help = await s.query<string>('help', ['zeros']);
    assert.match(help.outputs[0], /zeros - Create array of all zeros/);

    // Background queries are refused while a command runs.
    const long = s.sendLine('pause(0.4)');
    await sleep(50);
    assert.strictEqual(s.state, 'busy');
    const refused = await s.query('which', ['zeros'], { background: true });
    assert.ok(refused.skipped, 'background query skipped while busy');
    assert.strictEqual(await s.complete('zer', 3), undefined, 'no completion while busy');
    await long;
    const which = await s.query<string>('which', ['zeros'], { background: true });
    assert.match(which.outputs[0], /built-in/);

    // MATLAB's own completion when idle.
    await s.sendLine('myStruct = struct(\'alpha\', 1, \'beta\', 2);');
    const c1 = await s.complete('mySt', 4);
    assert.ok(c1?.some(c => c.label === 'myStruct' && c.kind === 'v'), JSON.stringify(c1));
    const c2 = await s.complete('myStruct.al', 11);
    assert.ok(c2?.some(c => c.label === 'alpha' && c.kind === 'f'), JSON.stringify(c2));

    // input(): state 'input' with the prompt text; the answer continues the run.
    const inputs: [string, string][] = [];
    s.on('input', (src, p) => inputs.push([src, p]));
    const asking = s.sendLine('n = input(\'How many? \')');
    await waitFor(() => s.state === 'input');
    assert.deepStrictEqual(inputs[inputs.length - 1], ['input', 'How many? ']);
    assert.ok(s.sendInput('5'));
    assert.strictEqual(await asking, 'ready');
    assert.match(cap.text, /n =\s+5/);

    // pause without argument: state 'pause'; Enter (sendInput) continues.
    const pausing = s.sendLine('pause; disp(\'after pause\')');
    await waitFor(() => s.state === 'pause');
    assert.deepStrictEqual(inputs[inputs.length - 1], ['pause', '']);
    assert.ok(s.sendInput(''));
    assert.strictEqual(await pausing, 'ready');
    assert.match(cap.text, /after pause/);

    // keyboard: the run finishes with 'debug' (K>>); commands run in the stopped frame; dbcont resumes.
    cap.text = '';
    const kb = await s.sendLine('z = 1; keyboard; z = 2; disp(\'resumed\')');
    assert.strictEqual(kb, 'debug');
    assert.strictEqual(s.state, 'debug');
    assert.strictEqual(await s.sendLine('z'), 'debug');
    assert.match(cap.text, /z =\s+1/);
    const vdbg = await s.query<string[]>('who', [], { background: true });
    assert.ok(vdbg.ok, 'queries work at K>>');
    assert.strictEqual(await s.sendLine('dbcont'), 'ready');
    assert.match(cap.text, /resumed/);
    assert.strictEqual(s.state, 'idle');

    // dbquit aborts the rest.
    cap.text = '';
    assert.strictEqual(await s.sendLine('keyboard; disp(\'never\')'), 'debug');
    assert.strictEqual(await s.sendLine('dbquit'), 'ready');
    assert.ok(!/never/.test(cap.text), cap.text);

    // Interrupt: a long run stops, queued commands are cancelled, the workspace is kept.
    const slow = s.sendLine('while true, pause(0.05); end');
    const queued = s.sendLine('disp(\'queued\')');
    await sleep(150);
    const t = Date.now();
    s.interrupt();
    assert.strictEqual(await queued, 'cancelled');
    assert.strictEqual(await slow, 'ready');
    assert.ok(Date.now() - t < 2000, 'interrupt is quick');
    assert.strictEqual(s.state, 'idle');
    const xs = await s.query<string[]>('who');
    assert.ok(xs.outputs[0].includes('x'), 'workspace kept');

    // Interrupt while waiting in input().
    const asking2 = s.sendLine('m = input(\'never answered: \')');
    await waitFor(() => s.state === 'input');
    s.interrupt();
    assert.strictEqual(await asking2, 'ready');
    assert.strictEqual(s.state, 'idle');

    // clc
    let cleared = false;
    s.on('clear', () => { cleared = true; });
    await s.sendLine('clc');
    assert.ok(cleared, 'clc event');

    // run() of a script that errors: stack frames name the script and line.
    cap.text = '';
    await s.sendLine(`run('${path.join(root, 'test', 'workspace', 'error_demo.m').replace(/'/g, "''")}')`);
    assert.match(cap.text, /Error in error_demo \(line \d+\)/, cap.text);
    assert.match(cap.text, /Error in run \(line \d+\)/);

    // Multi-line block in one eval.
    cap.text = '';
    assert.strictEqual(await s.sendLine('total = 0;\nfor k = 1:4\n  total = total + k;\nend\ndisp(total)'), 'ready');
    assert.match(cap.text, /10/);
  });

  // Startup failure is reported, not a hang.
  const backend = new LsBackend({ serverPath: fake, execPath: process.execPath, env: { ...env, MCW_FAKE_FAIL_START: '1' } });
  const s = new MatlabSession(backend);
  await assert.rejects(s.start(), /could not be launched/);
  assert.strictEqual(s.state, 'exited');
  assert.strictEqual(await s.sendLine('x = 1'), 'cancelled');

  // The language server dying ends the session; pending work is cancelled.
  await withSession(env, async (s2) => {
    const pending = s2.sendLine('pause(5)');
    await sleep(100);
    (s2 as any).backend.child.kill();
    assert.strictEqual(await pending, 'cancelled');
    await waitFor(() => s2.state === 'exited');
  });
  console.log(`session (fake, ${variant}): all assertions passed in ${Date.now() - t0} ms`);
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) { throw new Error(`timed out waiting for ${cond}`); }
    await sleep(10);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(path.join(os.tmpdir(), 'mcw-test'), { recursive: true });
  await suite('defaults', {});
  await suite('evalResponse before prompt', { MCW_FAKE_RESPONSE_FIRST: '1' });
  await suite('fevals emit prompt changes', { MCW_FAKE_FEVAL_PROMPTS: '1' });
  await suite('input() prints its prompt', { MCW_FAKE_ECHO_INPUT_PROMPT: '1' });
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
