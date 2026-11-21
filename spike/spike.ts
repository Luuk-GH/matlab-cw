// SPIKE: answers the open questions about attaching a Command Window to the MATLAB that the official MATLAB
// extension runs (RESEARCH.md), on a PC with MATLAB. Bundled to spike/matlab-spike.js (plain Node).
//
//   1. In VS Code, open a .m file so the MATLAB extension starts MATLAB; in its MATLAB terminal run shareMATLABSession()
//   2. node spike/matlab-spike.js [--server <...\server\out\index.js>] [--no-figure] [--no-manual]
//
// It attaches exactly like the extension does (relay + our own language server instance with --matlabUrl), records
// EVERY protocol message with a timestamp, runs a list of probes, and writes spike/results/spike-<time>.md (+ .json).
// Nothing is sent anywhere. Check IDs (S1, S2, ...) are referenced by test/fake/fakeLanguageServer.js and
// TESTING-WITH-MATLAB.md.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LsBackend } from '../src/backend/lsBackend';
import { processAlive, readSharedSession, sessionFilePath } from '../src/backend/sharedSession';
import { MatlabSession } from '../src/matlabSession';

interface TraceEntry { t: number; dir: '->' | '<-' | '##'; msg: any; }
interface Result { id: string; title: string; ok: boolean | null; finding: string; events?: string[]; data?: unknown; }

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const T0 = Date.now();
const trace: TraceEntry[] = [];
const results: Result[] = [];
const lsLog: string[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now() - T0;

function say(m: string): void { console.log(`[${(now() / 1000).toFixed(1)}s] ${m}`); }

function findServer(): string | undefined {
  const explicit = opt('--server');
  if (explicit) { return path.resolve(explicit); }
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].map(d => path.join(os.homedir(), d, 'extensions'));
  const found: { p: string; v: number[] }[] = [];
  for (const r of roots) {
    let names: string[] = [];
    try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names) {
      const m = /^mathworks\.language-matlab-(\d+)\.(\d+)\.(\d+)/i.exec(n);
      const p = path.join(r, n, 'server', 'out', 'index.js');
      if (m && fs.existsSync(p)) { found.push({ p, v: m.slice(1).map(Number) }); }
    }
  }
  found.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return found[0]?.p;
}

// ---- trace helpers ----
const mark = (label: string) => { trace.push({ t: now(), dir: '##', msg: label }); return trace.length; };
const received = (from: number) => trace.slice(from).filter(e => e.dir === '<-');
function short(e: TraceEntry): string {
  const m = e.msg ?? {};
  const p = m.params;
  let detail: string;
  switch (m.method) {
    case 'text': detail = `stream=${p?.stream} ${JSON.stringify(p?.text)}`; break;
    case 'mvmPromptChange': detail = `${p?.state} isIdle=${p?.isIdle}`; break;
    case 'evalResponse': case 'evalRequest': detail = `id=${p?.requestId}${p?.command !== undefined ? ' ' + JSON.stringify(p.command) : ''}`; break;
    case 'fevalResponse': detail = `id=${p?.requestId} result=${JSON.stringify(p?.result).slice(0, 400)}`; break;
    case 'fevalRequest': detail = `id=${p?.requestId} ${p?.functionName}(${JSON.stringify(p?.args).slice(0, 200)}) nargout=${p?.nargout}`; break;
    default: detail = JSON.stringify(p ?? m.result ?? m.error ?? '').slice(0, 300);
  }
  return `${String(e.t).padStart(7)}ms ${e.dir} ${m.method ?? (m.id !== undefined ? `response#${m.id}` : '?')} ${detail}`;
}
const eventsFrom = (from: number) => trace.slice(from).filter(e => e.dir !== '##' && !/telemetry|logMessage|connection\/update/.test(e.msg?.method ?? '')).map(short);
async function waitMsg(from: number, pred: (m: any) => boolean, ms: number): Promise<any | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = received(from).find(e => pred(e.msg));
    if (hit) { return hit.msg; }
    if (Date.now() > end) { return undefined; }
    await sleep(20);
  }
}
const isPrompt = (state?: string) => (m: any) => m.method === 'mvmPromptChange' && (!state || m.params?.state === state);
const isIdlePrompt = (m: any) => m.method === 'mvmPromptChange' && m.params?.isIdle === true;
const lastEvalId = (from: number) => [...trace.slice(from)].reverse().find(e => e.dir === '->' && e.msg?.method === 'evalRequest')?.msg.params.requestId;
const texts = (from: number) => received(from).filter(e => e.msg.method === 'text').map(e => e.msg.params.text).join('');

function record(id: string, title: string, ok: boolean | null, finding: string, from?: number, data?: unknown): void {
  results.push({ id, title, ok, finding, events: from !== undefined ? eventsFrom(from) : undefined, data });
  say(`${id} ${ok === true ? 'OK  ' : ok === false ? 'FAIL' : 'INFO'} ${title}: ${finding}`);
}

async function probe(id: string, title: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { record(id, title, false, `probe crashed: ${(e as Error).stack ?? e}`); }
}

// ---- the spike ----
async function main(): Promise<void> {
  const server = findServer();
  if (!server) {
    console.error('Could not find the MATLAB extension\'s language server. Install the MATLAB extension (MathWorks.language-matlab) in VS Code, or pass --server <path to server\\out\\index.js>.');
    process.exit(2);
  }
  const lookup = readSharedSession();
  if (!lookup.ok) {
    console.error(`${lookup.message} (looked in ${lookup.file})\n` +
      'In VS Code, open a .m file so the MATLAB extension starts MATLAB, then in its MATLAB terminal run:  shareMATLABSession()\n' +
      '(It comes with MathWorks\' MATLAB MCP Server Toolbox, installed by the MATLAB Agentic Toolkit or "matlab-mcp-server --setup-matlab".)');
    process.exit(2);
  }
  const shared = lookup.session;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-spike-'));
  writeProbeFiles(work);
  say(`language server: ${server}`);
  say(`shared MATLAB: process ${shared.pid}, connector port ${shared.port}, base path ${JSON.stringify(shared.basePath)} (${sessionFilePath()})`);
  say(`work folder (added to the MATLAB path during the spike): ${work}`);
  sharedPid = shared.pid;

  const backend = new LsBackend({
    serverPath: server, attach: shared, cwd: work, execPath: process.execPath,
    startTimeoutMs: 20000, trace: (dir, msg) => trace.push({ t: now(), dir, msg }),
  });
  backend.on('log', m => lsLog.push(`${now()}ms ${m}`));
  const session = new MatlabSession(backend, m => lsLog.push(`${now()}ms [session] ${m}`));
  running = { server, work, session };

  // S1 startup
  let from = mark('S1');
  say('Attaching to the shared MATLAB…');
  const t1 = Date.now();
  try {
    await session.start();
  } catch (e) {
    record('S1', 'attach to the shared MATLAB (relay + language server with --matlabUrl)', false, (e as Error).message, from);
    return finish(server, work);
  }
  record('S1', 'attach to the shared MATLAB (relay + language server with --matlabUrl)', true,
    `connected after ${((Date.now() - t1) / 1000).toFixed(1)} s, release ${session.release}`, from, { ms: Date.now() - t1, release: session.release });
  await sleep(1500);   // let the language server's own startup fevals (startupHelper, graphics prewarm) finish
  results[results.length - 1].events = eventsFrom(from);
  await backend.feval('addpath', 0, [work]).catch(e => say(`addpath failed: ${e}`));

  if (!argv.includes('--no-manual')) {
    await probe('A1', 'output of commands typed in the MATLAB extension\'s terminal reaches our window', async () => {
      from = mark('A1');
      say('>>> NOW: in VS Code\'s MATLAB terminal (the MATLAB extension\'s), type   disp(\'hello from the official terminal\')   and press Enter. Waiting 30 s…');
      const got = await waitMsg(from, m => m.method === 'text' && /hello from the official terminal/.test(m.params?.text ?? ''), 30000);
      const prompts = received(from).map(e => e.msg).filter(isPrompt()).map(m => m.params.state);
      record('A1', 'output of commands typed in the MATLAB extension\'s terminal reaches our window', got ? true : null,
        got ? 'yes, the text arrived here too' : 'no text arrived here within 30 s (either not typed, or each client only gets its own output)',
        from, { promptsSeen: prompts });
    });
  }

  await probe('S2', 'prompt states and output for a simple command', async () => {
    from = mark('S2');
    void backend.eval('spikeX = 1 + 1');
    const resp = await waitMsg(from, m => m.method === 'evalResponse', 8000);
    await sleep(500);
    const ev = received(from).map(e => e.msg);
    const states = ev.filter(isPrompt()).map(m => `${m.params.state}/${m.params.isIdle}`);
    record('S2', 'prompt states and output for a simple command', !!resp && /spikeX\s*=\s*\n*\s*2/.test(texts(from)),
      `prompt changes: ${states.join(' -> ') || '(none)'}; output ${JSON.stringify(texts(from))}`, from);
  });

  await probe('S3', 'order of evalResponse and the final idle prompt', async () => {
    from = mark('S3');
    void backend.eval('pause(0.5)');
    await waitMsg(from, m => m.method === 'evalResponse', 8000);
    await sleep(500);
    const order = received(from).map(e => e.msg).filter(m => m.method === 'evalResponse' || isIdlePrompt(m)).map(m => m.method === 'evalResponse' ? 'evalResponse' : `prompt ${m.params.state}`);
    record('S3', 'order of evalResponse and the final idle prompt', null, order.join(' then ') || '(no events)', from);
  });

  await probe('S4', 'do hidden fevals change the prompt state?', async () => {
    from = mark('S4');
    const r = await backend.feval('pwd', 1, []);
    await sleep(300);
    const prompts = received(from).map(e => e.msg).filter(isPrompt());
    record('S4', 'do hidden fevals change the prompt state?', null,
      prompts.length ? `yes: ${prompts.map(m => m.params.state).join(' -> ')}` : 'no prompt changes', from, r);
  });

  await probe('S5', 'feval result and error shapes (pwd, who, an error)', async () => {
    from = mark('S5');
    const raw = (name: string) => received(from).filter(e => e.msg.method === 'fevalResponse').map(e => e.msg.params.result).slice(-1)[0];
    const pwd = await backend.feval('pwd', 1, []).catch(e => e);
    const pwdRaw = raw('pwd');
    const err = await backend.feval('mcw_no_such_function', 1, []).catch(e => e);
    const errRaw = raw('err');
    const who = await backend.feval('who', 1, []).catch(e => e);
    const whoRaw = raw('who');
    const ok = Array.isArray(pwd) && typeof pwd[0] === 'string' && err instanceof Error && Array.isArray(who);
    record('S5', 'feval result and error shapes (pwd, who, an error)', ok,
      `pwd raw result ${JSON.stringify(pwdRaw)}; who raw ${JSON.stringify(whoRaw).slice(0, 300)}; error raw ${JSON.stringify(errRaw)}`,
      from, { pwdRaw, errRaw, whoRaw });
  });

  await probe('S6', 'keyboard / K>>: states, DebuggingStateChange, when evalResponses come', async () => {
    from = mark('S6');
    void backend.eval(`spike_keyboard_fn()`);
    const dbg = await waitMsg(from, isPrompt('DEBUG'), 8000);
    const kbId = lastEvalId(from);
    await sleep(300);
    const mid = mark('S6 at K>>');
    void backend.eval('spikeInDebug = localVar * 2');
    await waitMsg(mid, m => m.method === 'evalResponse', 10000);
    await sleep(300);
    const cont = mark('S6 dbcont');
    void backend.eval('dbcont');
    await waitMsg(cont, isPrompt('READY'), 8000);
    await sleep(500);
    const kbResp = received(from).some(e => e.msg.method === 'evalResponse' && e.msg.params.requestId === kbId);
    record('S6', 'keyboard / K>>: states, DebuggingStateChange, when evalResponses come', !!dbg,
      `DEBUG prompt: ${!!dbg}; command at K>> output ${JSON.stringify(texts(mid).slice(0, 200))}; original eval's evalResponse received after dbcont: ${kbResp}`, from);
  });

  await probe('S7', 'input(): prompt string, INPUT state, answering with evalRequest', async () => {
    from = mark('S7');
    void backend.eval("spikeAnswer = input('Spike asks: ')");
    const inputPrompt = await waitMsg(from, m => m.method === 'mvmInputPrompt', 10000);
    const inState = await waitMsg(from, isPrompt('INPUT'), 10000);
    await sleep(300);
    const printedPrompt = texts(from).includes('Spike asks');
    const ans = mark('S7 answer');
    void backend.eval('41 + 1');
    await waitMsg(ans, isPrompt('READY'), 10000);
    await sleep(500);
    const v = await backend.feval('evalc', 1, ['disp(spikeAnswer)']).catch(e => e);
    record('S7', 'input(): prompt string, INPUT state, answering with evalRequest', !!inState && /42/.test(String(v)),
      `mvmInputPrompt ${JSON.stringify(inputPrompt?.params)}; INPUT state: ${!!inState}; value after answer: ${JSON.stringify(String(v)).slice(0, 80)}`, from);
    record('S8', 'does MATLAB also print input()\'s prompt as output text?', null, printedPrompt ? 'yes (text event contains it)' : 'no', from);
  });

  await probe('S9', 'error text of a failing script run with run(): frames, hyperlinks, stream', async () => {
    from = mark('S9');
    void backend.eval(`run('${path.join(work, 'spike_error_demo.m').replace(/'/g, "''")}')`);
    await waitMsg(from, isPrompt('READY'), 8000);
    await sleep(500);
    const errText = received(from).filter(e => e.msg.method === 'text').map(e => `[stream ${e.msg.params.stream}] ${e.msg.params.text}`).join('');
    record('S9', 'error text of a failing script run with run(): frames, hyperlinks, stream', null,
      `${/<a href/.test(errText) ? 'CONTAINS <a href> hyperlinks' : 'plain text (no hyperlinks)'}; ${/Error in spike_error_demo \(line 3\)/.test(errText.replace(/<[^>]+>/g, '')) ? '"Error in spike_error_demo (line 3)" present' : 'frame text differs'}`,
      from, errText);
  });

  await probe('S10', 'help text through feval (format for the help tooltip)', async () => {
    from = mark('S10');
    const one = (v: any) => String(Array.isArray(v) ? v[0] : v);
    const zh = one(await backend.feval('help', 1, ['zeros']).catch(e => e));
    const zw = one(await backend.feval('which', 1, ['zeros']).catch(e => e));
    const uh = one(await backend.feval('help', 1, ['spike_documented']).catch(e => e));
    const uw = one(await backend.feval('which', 1, ['spike_documented']).catch(e => e));
    record('S10', 'help text through feval (format for the help tooltip)', zh.length > 20,
      `zeros which=${JSON.stringify(zw)}; first lines ${JSON.stringify(zh.split('\n').slice(0, 8).join('\n'))}; user function which=${JSON.stringify(uw)} help ${JSON.stringify(uh.slice(0, 120))}`,
      from, { zerosHelp: zh, zerosWhich: zw, userHelp: uh, userWhich: uw });
  });

  await probe('S11', 'warnings and default display formatting', async () => {
    from = mark('S11');
    void backend.eval("warning('spike warning'); spikeM = magic(3), spikeS = struct('a', 1, 'b', 'text'), spikeStr = \"hello\"");
    await waitMsg(from, isPrompt('READY'), 8000);
    await sleep(500);
    record('S11', 'warnings and default display formatting', null, 'see raw events', from);
  });

  await probe('S12', 'interrupt: pause(30) and a busy loop', async () => {
    from = mark('S12');
    void backend.eval('pause(30)');
    await waitMsg(from, isPrompt('BUSY'), 5000);
    await sleep(1500);
    let t = Date.now();
    backend.interrupt();
    const r1 = await waitMsg(from, isPrompt('READY'), 8000);
    const pauseMs = Date.now() - t;
    const from2 = mark('S12 loop');
    void backend.eval('spikeN = 0; while true, spikeN = spikeN + 1; end');
    await sleep(2000);
    t = Date.now();
    backend.interrupt();
    const r2 = await waitMsg(from2, isPrompt('READY'), 8000);
    const loopMs = Date.now() - t;
    await sleep(500);
    record('S12', 'interrupt: pause(30) and a busy loop', !!r1 && !!r2,
      `pause: ${r1 ? `READY after ${pauseMs} ms` : 'NO READY within 15 s'}; loop: ${r2 ? `READY after ${loopMs} ms` : 'NO READY within 15 s'}; printed ${JSON.stringify(texts(from)).slice(0, 200)}`, from);
  });

  await probe('S13', 'fevals at K>> see the stopped frame (Workspace view while debugging)', async () => {
    from = mark('S13');
    void backend.eval('spike_keyboard_fn()');
    await waitMsg(from, isPrompt('DEBUG'), 8000);
    await sleep(300);
    const v = await backend.feval('who', 1, []).catch(e => e);
    const listed = JSON.stringify(v);
    const ev = await backend.feval('evalc', 1, ['localVar']).catch(e => e);
    void backend.eval('dbquit');
    await waitMsg(mark('S13 quit'), isPrompt('READY'), 8000);
    record('S13', 'fevals at K>> see the stopped frame (completion/help while debugging)', /localVar/.test(listed),
      `who at K>> ${/localVar/.test(listed) ? 'lists the function\'s localVar' : 'does NOT list localVar (it sees another workspace)'}; evalc('localVar') -> ${JSON.stringify(String(ev)).slice(0, 120)}`, from, listed);
  });

  await probe('S14', 'MATLAB\'s own completion (TerminalCompletionRequest)', async () => {
    from = mark('S14');
    await backend.eval("spikeStruct = struct('alpha', 1, 'beta', 2);");
    await sleep(300);
    const a = await backend.complete('spikeSt', 7);
    const b = await backend.complete('spikeStruct.al', 14);
    const c = await backend.complete('zer', 3);
    const raw = received(from).filter(e => e.msg.method === 'TerminalCompletionResponse').map(e => e.msg.params);
    record('S14', 'MATLAB\'s own completion (TerminalCompletionRequest)', !!a?.some(x => x.label === 'spikeStruct') && !!c?.some(x => x.label === 'zeros'),
      `variables: ${JSON.stringify(a?.slice(0, 5))}; fields: ${JSON.stringify(b?.slice(0, 5))}; functions: ${JSON.stringify(c?.slice(0, 5))}`, from, raw);
  });

  await probe('S15', 'streaming: output arrives while a command runs', async () => {
    from = mark('S15');
    const t = now();
    void backend.eval('for spikeK = 1:4, disp(spikeK), pause(0.5), end');
    await waitMsg(from, m => m.method === 'evalResponse', 8000);
    const times = received(from).filter(e => e.msg.method === 'text').map(e => e.t - t);
    const spread = times.length >= 4 && times[times.length - 1] - times[0] >= 1000;
    record('S15', 'streaming: output arrives while a command runs', spread, `text event times (ms after send): ${times.join(', ')}`, from);
  });

  await probe('S16', 'pause without argument: PAUSE state and unpauseRequest', async () => {
    from = mark('S16');
    void backend.eval("pause; disp('spike after pause')");
    const p = await waitMsg(from, isPrompt('PAUSE'), 8000);
    await sleep(300);
    backend.unpause();
    const r = await waitMsg(from, isPrompt('READY'), 10000);
    await sleep(300);
    record('S16', 'pause without argument: PAUSE state and unpauseRequest', !!p && !!r && /spike after pause/.test(texts(from)),
      `PAUSE state: ${!!p}; continued: ${/spike after pause/.test(texts(from))}`, from);
    if (!r) { backend.interrupt(); await sleep(1000); }
  });

  await probe('S17', 'multi-line code in one evalRequest', async () => {
    from = mark('S17');
    void backend.eval("spikeA = 0;\nfor spikeK = 1:3\n    spikeA = spikeA + spikeK;\nend\ndisp(spikeA)\n%% a section marker\nfprintf('done %d\\n', spikeA);");
    await waitMsg(from, isPrompt('READY'), 8000);
    await sleep(500);
    record('S17', 'multi-line code in one evalRequest', /6/.test(texts(from)) && /done 6/.test(texts(from)), `output ${JSON.stringify(texts(from))}`, from);
  });

  await probe('S18', 'clc event', async () => {
    from = mark('S18');
    void backend.eval('clc');
    const c = await waitMsg(from, m => m.method === 'clc', 8000);
    await waitMsg(from, isPrompt('READY'), 8000);
    record('S18', 'clc event', !!c, c ? 'clc notification received' : 'no clc notification', from);
  });

  if (!argv.includes('--no-figure')) {
    await probe('S21', 'figures: does plotting work and return to the prompt?', async () => {
      from = mark('S21');
      const t = Date.now();
      void backend.eval("spikeFig = figure('Name', 'MATLAB companion spike'); plot(1:10); drawnow; pause(2); close(spikeFig)");
      const r = await waitMsg(from, isPrompt('READY'), 20000);
      record('S21', 'figures: does plotting work and return to the prompt?', !!r,
        `${r ? `back at READY after ${Date.now() - t} ms` : 'did not return within 60 s'} (watch the screen: a figure window should appear for 2 s)`, from);
    });
  }

  await probe('S22', 'hotlinks setting and edit/which output', async () => {
    from = mark('S22');
    const h = await backend.feval('feature', 1, ['hotlinks']).catch(e => String(e));
    void backend.eval("which zeros, spike_missing_function_xyz");
    await waitMsg(from, isPrompt('READY'), 10000);
    await sleep(300);
    record('S22', 'hotlinks setting and edit/which output', null, `feature('hotlinks') = ${JSON.stringify(h)}`, from);
  });

  // S24: the extension's own session core (src/matlabSession.ts) on the real backend.
  await probe('S24', 'session core end to end (queue, input, keyboard, interrupt, queries)', async () => {
    from = mark('S24');
    const out: string[] = [];
    const sub = (t: string) => out.push(t);
    session.on('output', sub);
    const problems: string[] = [];
    const step = async <T>(name: string, p: Promise<T>, ms = 10000): Promise<T | 'timeout'> => {
      const r = await Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
      if (r === 'timeout') { problems.push(`${name}: no answer within ${ms / 1000} s (state ${session.state})`); }
      return r;
    };
    const k1 = await step('sendLine', session.sendLine('spikeQ = 7'));
    if (k1 !== 'ready') { problems.push(`sendLine -> ${k1}`); }
    const both = await step('queue', Promise.all([session.sendLine("pause(0.3); disp('q-first')"), session.sendLine("disp('q-second')")]));
    const [a, b] = both === 'timeout' ? ['timeout', 'timeout'] : both;
    if (a !== 'ready' || b !== 'ready' || out.join('').indexOf('q-first') > out.join('').indexOf('q-second')) { problems.push('queue order'); }
    const asking = session.sendLine("spikeQ2 = input('session asks: ')");
    for (let i = 0; i < 100 && session.state !== 'input'; i++) { await sleep(50); }
    if (session.state !== 'input') { problems.push(`state ${session.state} instead of input`); } else { session.sendInput('3'); }
    if (await step('input', asking) !== 'ready') { problems.push('input run did not finish ready'); }
    const kb = await step('keyboard', session.sendLine('spike_keyboard_fn()'));
    if (kb !== 'debug') { problems.push(`keyboard -> ${kb}`); }
    const q = await step('query at K>>', session.query<unknown>('who', [], { background: true }));
    if (q === 'timeout' || !q.ok) { problems.push('query at K>> failed'); }
    if (await step('dbcont', session.sendLine('dbcont')) !== 'ready') { problems.push('dbcont did not end ready'); }
    const long = session.sendLine('pause(20)');
    await sleep(1000);
    session.interrupt();
    if (await step('interrupt', long) !== 'ready') { problems.push('interrupt did not end ready'); }
    if (session.state !== 'idle') { session.interrupt(); await sleep(500); }
    if (session.state !== 'idle') { problems.push(`final state ${session.state}`); }
    record('S24', 'session core end to end (queue, input, keyboard, interrupt, queries)', problems.length === 0,
      problems.length ? problems.join('; ') : 'all steps behaved as the extension expects', from);
  });

  return finish(server, work, session);
}

function writeProbeFiles(dir: string): void {
  fs.writeFileSync(path.join(dir, 'spike_error_demo.m'), "% Fails on line 3.\nspikeE = 1;\nspikeE = spike_undefined_thing + spikeE;\n");
  fs.writeFileSync(path.join(dir, 'spike_keyboard_fn.m'), "function spike_keyboard_fn()\n%SPIKE_KEYBOARD_FN  Stops at keyboard with a local variable.\nlocalVar = 21;\nkeyboard\ndisp(localVar)\nend\n");
  fs.writeFileSync(path.join(dir, 'spike_documented.m'), "function y = spike_documented(x)\n%SPIKE_DOCUMENTED  Doubles X.\n%   Y = SPIKE_DOCUMENTED(X) returns 2*X.\ny = 2 * x;\nend\n");
}

let sharedPid = 0;
/** For the watchdog: what finish() needs to clean up (remove the work folder from the path, disconnect). */
let running: { server: string; work: string; session: MatlabSession } | undefined;
let finished = false;

async function finish(server: string, work: string, session?: MatlabSession): Promise<void> {
  if (finished) { return; }
  finished = true;
  if (session && session.state !== 'exited') {
    if (session.state !== 'idle') { session.interrupt(); await sleep(500); }
    // Remove this run's work folder, and any left on the path by an earlier run that was killed.
    const clean = "mcwP = strsplit(path, pathsep); mcwP = mcwP(contains(mcwP, 'mcw-spike-')); if ~isempty(mcwP), rmpath(mcwP{:}); end; clear mcwP";
    await Promise.race([session.query('evalin', ['base', clean], { nargout: 0 }).catch(() => undefined), sleep(3000)]);
  }
  session?.dispose();
  await sleep(1500);
  if (sharedPid) {
    const alive = processAlive(sharedPid);
    results.push({ id: 'A2', title: 'after we disconnect, the shared MATLAB keeps running', ok: alive,
      finding: alive ? `process ${sharedPid} still running — now check that the MATLAB extension's terminal still works (type 1+1 there)` : `process ${sharedPid} is GONE` });
    say(`A2 ${alive ? 'OK  ' : 'FAIL'} after we disconnect, the shared MATLAB keeps running`);
  }
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const env = {
    date: new Date().toISOString(), os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, server,
    extensionVersion: /language-matlab-([\d.]+)/i.exec(server)?.[1] ?? 'unknown', work,
  };
  fs.writeFileSync(path.join(dir, `spike-${stamp}.json`), JSON.stringify({ env, results, trace, lsLog }, null, 1));
  const md: string[] = [
    `# MATLAB companion spike results (${env.date})`, '',
    `- OS: ${env.os}, Node ${env.node}`, `- Language server: ${server} (extension ${env.extensionVersion})`, '',
    '| Check | Result | Finding |', '|---|---|---|',
    ...results.map(r => `| ${r.id} ${r.title} | ${r.ok === true ? 'OK' : r.ok === false ? '**FAIL**' : 'info'} | ${r.finding.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '', '## Raw events per check', '',
  ];
  for (const r of results) {
    md.push(`### ${r.id} ${r.title}`, '', '```', ...(r.events ?? []).slice(0, 120), '```', '');
    if (r.data !== undefined) { md.push('Data:', '```', JSON.stringify(r.data, null, 1).slice(0, 4000), '```', ''); }
  }
  md.push('## Language server log (last 200 lines)', '', '```', ...lsLog.slice(-200), '```', '');
  const mdFile = path.join(dir, `spike-${stamp}.md`);
  fs.writeFileSync(mdFile, md.join('\n'));
  say(`Results written to ${mdFile} (and the raw trace to the .json next to it).`);
  say(`${results.filter(r => r.ok === true).length} OK, ${results.filter(r => r.ok === false).length} FAIL, ${results.filter(r => r.ok === null).length} info.`);
  process.exit(0);
}

process.on('SIGINT', () => { say('Interrupted; writing partial results.'); void finish(findServer() ?? '?', '?'); });
// Never hang for long: after 4 minutes write what we have, clean up and stop.
setTimeout(() => {
  say('The spike is taking longer than 4 minutes: writing partial results.');
  void finish(running?.server ?? findServer() ?? '?', running?.work ?? '?', running?.session).then(() => process.exit(1));
}, 240000).unref();
main().catch(e => { console.error(e); void finish(findServer() ?? '?', '?'); });
