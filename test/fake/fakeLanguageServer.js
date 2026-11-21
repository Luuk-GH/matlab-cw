#!/usr/bin/env node
// FAKE MATLAB, seen through a fake MathWorks MATLAB language server.
//
// The extension's real backend (src/backend/lsBackend.ts) runs the MathWorks language server with `--node-ipc` and
// talks to it with JSON-RPC notifications. This script speaks the same protocol, so the automated tests exercise the
// real backend code, the session core, the views and the MCP server. Only this file's imitation of MATLAB and of the
// language server is unverified.
//
// EVERY BEHAVIOUR BELOW IS AN ASSUMPTION. Each one is tagged with where it comes from and how sure we are:
//   [code]  read from mathworks/MATLAB-language-server or MATLAB-extension-for-vscode v1.3.16 source: fairly sure
//   [docs]  MATLAB documentation / long-standing MATLAB behaviour: fairly sure about MATLAB, not about the LS path
//   [guess] not documented anywhere we could read: must be checked by the spike (check IDs refer to spike/spike.ts)
//
// Environment knobs (tests use them to try both answers to open questions):
//   MCW_FAKE_STARTUP_MS     delay before attaching to the (fake) connector (default 0)
//   MCW_FAKE_RESPONSE_FIRST=1  send evalResponse BEFORE the final idle prompt change (default: after)   [guess, S3]
//   MCW_FAKE_FEVAL_PROMPTS=1   hidden fevals also emit BUSY/READY prompt changes (default: they don't)  [guess, S4]
//   MCW_FAKE_ECHO_INPUT_PROMPT=1  input() also prints its prompt as output text (default: it doesn't)   [guess, S8]
//   MCW_FAKE_LOG=<file>     append every received/sent message to this file
'use strict';
const fs = require('fs');
const path = require('path');

const env = process.env;
const STARTUP_MS = Number(env.MCW_FAKE_STARTUP_MS ?? 0);
const RELEASE = 'R2099z';
const logFile = env.MCW_FAKE_LOG;
const trace = (dir, m) => { if (logFile) { try { fs.appendFileSync(logFile, `${dir} ${JSON.stringify(m)}\n`); } catch { /* ignore */ } } };

// ---------------------------------------------------------------------------------------------------------------
// Transport: JSON-RPC over Node IPC, one object per message ([code] vscode-languageserver --node-ipc).
if (!process.send) { console.error('fakeLanguageServer.js must be started with --node-ipc via child_process.fork'); process.exit(2); }
const send = m => { trace('->', m); process.send(m); };
const notify = (method, params) => send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
// The real server logs to stdout/stderr; the backend copies that into its log.
const log = m => process.stdout.write(`[fake-ls] ${m}\n`);

// ---------------------------------------------------------------------------------------------------------------
// Session state

/** Prompt states, [code] MVMInterface.d.ts PromptState. */
let prompt = 'INITIALIZING';
let connected = false;
let cwd = process.cwd();
const base = new Map();               // the base workspace
let running = null;                   // { cancel(reason), cancelled } for the eval that is executing
let inputWaiter = null;               // resolve(answer) while input() waits
let pauseWaiter = null;               // resolve() while `pause` (no argument) waits
let debugFrame = null;                // { ws, resume(action) } while stopped at K>> inside running code

/** [code] mvmPromptChange {state, isIdle}; isIdle true for READY and DEBUG ([guess] exact isIdle values, S2). */
function setPrompt(state) {
  prompt = state;
  notify('mvmPromptChange', { state, isIdle: state === 'READY' || state === 'DEBUG' });
}
/** [code] `text` {text, stream}: 0 = stdout, 1 = stderr. */
const out = text => notify('text', { text, stream: 0 });
const err = text => notify('text', { text, stream: 1 });
/** [code] warnings arrive on stream 0 wrapped in [\b ... ]\b (CommandWindow.ts WARNING_SENTINAL_REGEX). [guess] the exact wrapping/line breaks, S11. */
const warn = text => notify('text', { text: `[\x08Warning: ${text}\n]\x08`, stream: 0 });

// ---------------------------------------------------------------------------------------------------------------
// Messages

process.on('message', msg => {
  trace('<-', msg);
  if (!msg || typeof msg !== 'object') { return; }
  const { id, method, params } = msg;
  if (method === undefined) { return; }   // a response to something we never send
  if (id !== undefined) { return onRequest(id, method, params); }
  onNotification(method, params ?? {});
});
process.on('disconnect', () => process.exit(0));

function onRequest(id, method, params) {
  switch (method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id, result: { capabilities: { completionProvider: {} }, serverInfo: { name: 'fake-matlab-ls' } } });
    case 'shutdown':
      // [code] onShutdown disconnects from MATLAB.
      send({ jsonrpc: '2.0', id, result: null });
      connected = false;
      return;
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `fake: no ${method}` } });
  }
}

function onNotification(method, p) {
  switch (method) {
    case 'initialized': return;
    case 'exit': return process.exit(0);
    case 'matlab/request': return startMatlab();
    case 'evalRequest': return onEval(p);
    case 'fevalRequest': return onFeval(p);
    case 'interruptRequest': return onInterrupt();
    case 'unpauseRequest': if (pauseWaiter) { const w = pauseWaiter; pauseWaiter = null; w(); } return;
    case 'TerminalCompletionRequest': return onCompletion(p);
    default: return;   // telemetry, configuration changes, ...
  }
}

const matlabUrl = (process.argv.find(a => a.startsWith('--matlabUrl=')) ?? '').slice('--matlabUrl='.length);

/**
 * --matlabUrl: attach to an existing MATLAB instead of launching one ([code] RemoteMatlabSession: a Faye client on
 * the URL). The fake proves the route works end to end: a Bayeux handshake POST and a WebSocket upgrade through the
 * URL (our relay) must reach the fake connector with the right API key. When that socket closes, MATLAB is "gone".
 */
/**
 * Mirrors the real server's bug in --matlabUrl mode ([code] verified on R2026b with extension 1.3.16): the remote
 * session never sets matlabRelease, so the MVM layer silently never becomes ready. src/backend/lsLoader.ts patches
 * this exact text in memory; without that patch the fake, like the real server, never reports the engine ready.
 */
class AbstractMatlabSession { constructor() { this.matlabRelease = null; } }
class RemoteMatlabSession extends AbstractMatlabSession {
  initialize(matlabConnection) {
    this.matlabConnection = matlabConnection;
  }
}

function attachMatlab() {
  const http = require('http');
  notify('matlab/connection/update/server', { connectionStatus: 'connecting' });
  const failed = why => {
    log(`attach failed: ${why}`);
    notify('matlab/connection/update/server', { connectionStatus: 'disconnected' });   // [code] DISCONNECTED on failure
  };
  const body = JSON.stringify([{ channel: '/meta/handshake', version: '1.0', supportedConnectionTypes: ['websocket', 'long-polling'], id: '1' }]);
  const req = http.request(matlabUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => {
      if (res.statusCode !== 200 || !/"successful":true/.test(text)) { return failed(`handshake ${res.statusCode} ${text.slice(0, 100)}`); }
      const up = http.request(matlabUrl, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'ZmFrZWtleWZha2VrZXkxMg==' } });
      up.on('upgrade', (_res, socket) => {
        socket.once('data', d => {
          if (String(d) !== 'ping') { return failed('websocket echo mismatch'); }
          notify('matlab/connection/update/server', { connectionStatus: 'connected' });
          const session = new RemoteMatlabSession();
          session.initialize(socket);
          if (!session.matlabRelease) { log('attached, but no MATLAB release known: the MVM never becomes ready'); return; }
          connected = true;
          notify('mvmStateChange', { state: 'connected', release: session.matlabRelease });
          setPrompt('READY');
          log('attached to shared MATLAB');
        });
        socket.write('ping');
        socket.on('close', () => {
          if (!connected) { return; }
          connected = false;
          notify('matlab/connection/update/server', { connectionStatus: 'disconnected' });
          notify('mvmStateChange', { state: 'disconnected', release: RELEASE });
        });
        socket.on('error', () => undefined);
      });
      up.on('response', r => failed(`websocket upgrade refused (${r.statusCode})`));
      up.on('error', e => failed(e.message));
      up.end();
    });
  });
  req.on('error', e => failed(e.message));
  req.end(body);
}

function startMatlab() {
  if (connected) { return; }
  if (!matlabUrl) { log('the Command Window always attaches: --matlabUrl is required'); process.exit(2); }
  setTimeout(attachMatlab, STARTUP_MS);
}

// ---------------------------------------------------------------------------------------------------------------
// eval

async function onEval({ requestId, command }) {
  const respond = () => notify('evalResponse', { requestId });
  if (prompt === 'INPUT' && inputWaiter) {
    // [code] the official terminal answers input() by sending the typed line as an evalRequest.
    // [guess] the answer's own evalResponse comes at once (S7).
    const w = inputWaiter; inputWaiter = null;
    respond();
    w(command);
    return;
  }
  if (prompt === 'PAUSE') { respond(); return; }   // [guess] typed text during pause is dropped; unpauseRequest continues
  if (debugFrame && prompt === 'DEBUG') {
    // At K>>: debugger commands resume the stopped code; anything else runs in the stopped frame.
    const cmd = command.trim().replace(/;$/, '');
    if (/^db(cont|quit|step)\b/.test(cmd)) {
      respond();   // [guess] when dbcont's own evalResponse arrives (S6)
      const f = debugFrame; debugFrame = null;
      f.resume(cmd);
      return;
    }
    setPrompt('BUSY');
    await runCode(command, debugFrame.ws, null).catch(e => reportError(e));
    finishEval(respond, 'DEBUG');
    return;
  }
  // [code] user evals report BUSY while running. [guess] BUSY comes before any output (S2).
  setPrompt('BUSY');
  const ctx = { cancelled: false, reason: '' };
  running = { ctx, cancel: reason => { ctx.cancelled = true; ctx.reason = reason; wake(); } };
  try {
    await runCode(command, base, ctx);
  } catch (e) {
    reportError(e);
  } finally {
    running = null;
  }
  finishEval(respond, 'READY');
}

function finishEval(respond, state) {
  if (env.MCW_FAKE_RESPONSE_FIRST === '1') { respond(); setPrompt(state); } else { setPrompt(state); respond(); }
}

let interruptsToIgnore = env.MCW_FAKE_IGNORE_FIRST_INTERRUPT === '1' ? 1 : 0;
function onInterrupt() {
  // [code] interruptRequest -> mvm.interrupt(). [docs] Ctrl+C aborts the running statement, the workspace is kept.
  if (!running) { return; }
  // [verified once on R2026b] MATLAB sometimes ignores an interrupt; a second one works.
  if (interruptsToIgnore > 0) { interruptsToIgnore--; log('ignoring this interrupt'); return; }
  running.cancel('interrupt');
  if (inputWaiter) { const w = inputWaiter; inputWaiter = null; w(null); }
  if (pauseWaiter) { const w = pauseWaiter; pauseWaiter = null; w(); }
  if (debugFrame) { const f = debugFrame; debugFrame = null; f.resume('dbquit'); }
}

let wakers = [];
function wake() { const w = wakers; wakers = []; w.forEach(f => f()); }
function sleep(ms, ctx) {
  return new Promise(res => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wakers = wakers.filter(f => f !== done); res(); }
    wakers.push(done);
  }).then(() => { if (ctx?.cancelled) { throw new Interrupt(); } });
}

class Interrupt { }
class Quit { }
class MatlabErr {
  constructor(msg, id = '') { this.msg = msg; this.id = id; this.stack = []; }
}

/**
 * [docs] how MATLAB reports an uncaught error in the Command Window, on stderr ([guess] stream 1 for errors, S11):
 *   at the prompt:  "<message>\n"
 *   in a script/function (R2023a-ish layout, [guess] exact blank lines, S9):
 *     "<message>\n\nError in <name> (line <n>)\n<code line>\n"   (one block per frame, innermost first)
 *   `Error using <fn>` is printed first when error() is called with a function on the stack.
 */
function reportError(e) {
  if (e instanceof Interrupt) {
    // [guess] what Ctrl+C prints (S12): MATLAB usually prints "Operation terminated by user during <fn>".
    err('Operation terminated by user during pause\n');
    return;
  }
  if (e instanceof Quit) { return; }
  if (!(e instanceof MatlabErr)) { err(`Internal fake error: ${e && e.stack || e}\n`); return; }
  // [verified, R2026b] wrapped in {\b ... }\b; each frame is followed by its code line and a ^^^ line:
  //   "{\b<message>\n\nError in <name> (line <n>)\n<code>\n^^^^\nError in run (line 100)\n...\n}\b \n"
  let text = '{\x08';
  if (e.using) { text += `Error using ${e.using}\n`; }
  text += `${e.msg}\n`;
  if (e.stack.length) { text += '\n'; }
  for (const f of e.stack) { text += `Error in ${f.name} (line ${f.line})\n${f.code}\n${'^'.repeat(Math.max(1, f.code.trim().length))}\n`; }
  err(`${text}}\x08 \n`);
}

// ---------------------------------------------------------------------------------------------------------------
// A tiny MATLAB interpreter: enough for the tests (assignments, display, disp/fprintf, for/while/if, input,
// keyboard, pause, error, warning, clc, clear, run, struct/cell/matrix values). Not a real MATLAB.

/** Split code into statements: {text, line, quiet} with line = 1-based source line. */
function statements(code) {
  const res = [];
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  let blockComment = false;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (t === '%{') { blockComment = true; return; }
    if (t === '%}') { blockComment = false; return; }
    if (blockComment) { return; }
    let depth = 0, cur = '', inStr = null;
    for (let k = 0; k < raw.length; k++) {
      const c = raw[k];
      const prev = cur.trimEnd().slice(-1);
      if (inStr) { cur += c; if (c === inStr) { if (raw[k + 1] === inStr) { cur += raw[++k]; } else { inStr = null; } } continue; }
      if (c === '%') { break; }
      if (c === '"' || (c === "'" && !/[\w)\]}'.]/.test(prev))) { inStr = c; cur += c; continue; }
      if ('([{'.includes(c)) { depth++; }
      if (')]}'.includes(c)) { depth--; }
      if ((c === ';' || c === ',') && depth === 0) {
        if (cur.trim()) { res.push({ text: cur.trim(), line: i + 1, quiet: c === ';', src: raw.trim() }); }
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) { res.push({ text: cur.trim(), line: i + 1, quiet: false, src: raw.trim() }); }
  });
  return res;
}

/** Group statements into blocks: for/while/if ... end. */
function parseBlock(stmts, pos, stopAt) {
  const body = [];
  while (pos.i < stmts.length) {
    const s = stmts[pos.i];
    const kw = /^(\w+)/.exec(s.text)?.[1];
    if (stopAt.includes(kw)) { return body; }
    pos.i++;
    if (kw === 'for' || kw === 'while') {
      const inner = parseBlock(stmts, pos, ['end']);
      pos.i++;
      body.push({ ...s, kind: kw, body: inner });
    } else if (kw === 'if') {
      const node = { ...s, kind: 'if', branches: [{ cond: s.text.replace(/^if\s*/, ''), body: [] }] };
      for (;;) {
        node.branches[node.branches.length - 1].body = parseBlock(stmts, pos, ['elseif', 'else', 'end']);
        const t = stmts[pos.i]; pos.i++;
        if (!t || /^end\b/.test(t.text)) { break; }
        node.branches.push({ cond: /^else\b/.test(t.text) && !/^elseif/.test(t.text) ? 'true' : t.text.replace(/^elseif\s*/, ''), body: [] });
      }
      body.push(node);
    } else {
      body.push({ ...s, kind: 'stmt' });
    }
  }
  return body;
}

/** Run code in workspace `ws`. `frame` names the script for error stacks (undefined at the prompt). */
async function runCode(code, ws, ctx, frame) {
  const stmts = statements(code);
  const tree = parseBlock(stmts, { i: 0 }, []);
  await execBlock(tree, ws, ctx ?? { cancelled: false }, frame);
}

async function execBlock(nodes, ws, ctx, frame) {
  for (const n of nodes) {
    if (ctx.cancelled) { throw new Interrupt(); }
    await new Promise(r => setImmediate(r));   // let IPC messages (interrupt) in
    try {
      await execNode(n, ws, ctx, frame);
    } catch (e) {
      if (e instanceof MatlabErr && frame && !e.framed) { e.stack.push({ name: frame, line: n.line, code: n.src }); e.framed = true; }
      throw e;
    }
  }
}

async function execNode(n, ws, ctx, frame) {
  if (n.kind === 'for') {
    const m = /^for\s+([A-Za-z]\w*)\s*=\s*(.+)$/.exec(n.text);
    if (!m) { throw new MatlabErr('Invalid for statement.'); }
    const range = toArray(evaluate(m[2], ws));
    for (const v of range) { ws.set(m[1], v); await execBlock(n.body, ws, ctx, frame); }
    return;
  }
  if (n.kind === 'while') {
    const cond = n.text.replace(/^while\s*/, '');
    while (truthy(evaluate(cond, ws))) {
      if (ctx.cancelled) { throw new Interrupt(); }
      await execBlock(n.body, ws, ctx, frame);
      await new Promise(r => setImmediate(r));
    }
    return;
  }
  if (n.kind === 'if') {
    for (const b of n.branches) { if (truthy(evaluate(b.cond, ws))) { await execBlock(b.body, ws, ctx, frame); return; } }
    return;
  }
  await execStatement(n.text, n.quiet, ws, ctx, frame);
}

async function execStatement(text, quiet, ws, ctx, frame) {
  // Command syntax first.
  let m;
  if (/^clc$/.test(text)) { notify('clc'); return; }   // [code] the clc shadow publishes a clc event
  if ((m = /^clear(?:\s+(.*))?$/.exec(text))) {
    const names = (m[1] ?? '').split(/\s+/).filter(Boolean);
    if (!names.length || names.includes('all')) { ws.clear(); } else { names.forEach(x => ws.delete(x)); }
    return;
  }
  if ((m = /^clear\((.*)\)$/.exec(text))) { evaluate(`{${m[1]}}`, ws).items.forEach(x => ws.delete(String(x))); return; }
  if (/^keyboard$/.test(text)) { await enterDebugger(ws, ctx); return; }
  if (/^pause$/.test(text)) {
    // [code] PAUSE prompt state; continued with unpauseRequest.
    setPrompt('PAUSE');
    await new Promise(r => { pauseWaiter = r; });
    if (ctx.cancelled) { throw new Interrupt(); }
    setPrompt('BUSY');
    return;
  }
  if ((m = /^pause\((.+)\)$/.exec(text))) { await sleep(Number(evaluate(m[1], ws)) * 1000, ctx); return; }
  if ((m = /^cd\s+(.+)$/.exec(text))) { changeDir(m[1].replace(/^'|'$/g, '')); return; }
  if ((m = /^run\((.+)\)$/.exec(text))) { await runScript(String(evaluate(m[1], ws)), ctx); return; }
  if ((m = /^dbstop\b/.exec(text))) { out(''); return; }
  if (/^db(cont|quit|step)\b/.test(text)) { err('Debug commands only allowed when stopped in debug mode.\n'); return; }   // [docs]
  if ((m = /^(disp|fprintf|error|warning)\((.*)\)$/.exec(text))) { return callStatement(m[1], m[2], ws); }

  // Assignment or expression.
  const asg = /^([A-Za-z]\w*(?:\.[A-Za-z]\w*)*)\s*=(?!=)\s*(.+)$/.exec(text);
  if (asg) {
    const value = await evaluateAsync(asg[2], ws, ctx);
    assign(ws, asg[1], value);
    if (!quiet) { out(display(asg[1].split('.')[0], ws.get(asg[1].split('.')[0]))); }
    return;
  }
  const value = await evaluateAsync(text, ws, ctx);
  if (value === undefined) { return; }
  if (/^[A-Za-z]\w*$/.test(text) && ws.has(text)) { if (!quiet) { out(display(text, value)); } return; }
  ws.set('ans', value);
  if (!quiet) { out(display('ans', value)); }
}

async function evaluateAsync(expr, ws, ctx) {
  // input() needs to wait; everything else is synchronous.
  const m = /^input\((.*)\)$/.exec(expr.trim());
  if (!m) { return evaluate(expr, ws); }
  const args = evaluate(`{${m[1]}}`, ws).items;
  const promptText = String(args[0] ?? '');
  // [code] the input shadow publishes the prompt string (mvmInputPrompt) and the state becomes INPUT.
  // [guess] order: mvmInputPrompt first, then mvmPromptChange INPUT (S8). MATLAB itself may also print the prompt.
  if (env.MCW_FAKE_ECHO_INPUT_PROMPT === '1') { out(promptText); }
  notify('mvmInputPrompt', [promptText]);   // [verified, R2026b] an array with the prompt string
  setPrompt('INPUT');
  const answer = await new Promise(r => { inputWaiter = r; });
  if (ctx.cancelled || answer === null) { throw new Interrupt(); }
  setPrompt('BUSY');
  if (args[1] === 's') { return answer; }
  return answer.trim() ? evaluate(answer, ws) : emptyMatrix();
}

/** keyboard: stop at K>> until dbcont/dbquit ([docs] behaviour; [code] DEBUG prompt state). */
async function enterDebugger(ws, ctx) {
  notify('DebuggingStateChange', true);   // [code] sent by the language server when debugging starts ([guess] for keyboard, S6)
  const action = await new Promise(resolve => { debugFrame = { ws, resume: resolve }; setPrompt('DEBUG'); });
  notify('DebuggingStateChange', false);
  if (ctx.cancelled || action === 'dbquit') { throw new Quit(); }
  setPrompt('BUSY');
}

function callStatement(fn, argText, ws) {
  const args = argText.trim() ? evaluate(`{${argText}}`, ws).items : [];
  if (fn === 'disp') {
    const v = args[0];
    // [docs] disp shows the value without the name and without blank lines.
    out(typeof v === 'string' ? `${v}\n` : isScalarNumber(v) ? `     ${fmtNum(v)}\n` : displayValue(v).replace(/^\n/, ''));
    return;
  }
  if (fn === 'fprintf') { out(sprintf(String(args[0] ?? ''), args.slice(1))); return; }
  if (fn === 'warning') { warn(sprintf(String(args[args.length > 1 && /:/.test(args[0]) ? 1 : 0]), [])); return; }
  // error(msg) / error(id, msg, ...)
  const hasId = args.length > 1 && /^[\w]+(:[\w]+)+$/.test(String(args[0]));
  const msg = sprintf(String(args[hasId ? 1 : 0] ?? ''), args.slice(hasId ? 2 : 1));
  throw new MatlabErr(msg, hasId ? String(args[0]) : '');
}

async function runScript(file, ctx) {
  // [docs] run(file): changes to the script's folder, runs it in the caller's (base) workspace, changes back.
  const full = path.resolve(cwd, file);
  if (!fs.existsSync(full)) { throw new MatlabErr(`${file} not found.`); }
  const name = path.basename(full, '.m');
  const old = cwd;
  cwd = path.dirname(full);
  try {
    await runCode(fs.readFileSync(full, 'utf8'), base, ctx, name);
  } catch (e) {
    // [docs] run() adds its own frame ("Error in run (line 91)"); the line number differs per release.
    if (e instanceof MatlabErr) { e.stack.push({ name: 'run', line: 91, code: "evalin('caller', strcat(script, ';'));" }); }
    throw e;
  } finally {
    cwd = old;
  }
}

function changeDir(d) {
  const target = path.resolve(cwd, d);
  if (!fs.existsSync(target)) { throw new MatlabErr(`Cannot CD to ${d} (Name is nonexistent or not a directory).`); }
  cwd = target;
}

function assign(ws, target, value) {
  const parts = target.split('.');
  if (parts.length === 1) { ws.set(target, value); return; }
  let obj = ws.get(parts[0]);
  if (!isStruct(obj)) { obj = makeStruct({}); ws.set(parts[0], obj); }
  for (let i = 1; i < parts.length - 1; i++) {
    if (!isStruct(obj.fields[parts[i]])) { obj.fields[parts[i]] = makeStruct({}); }
    obj = obj.fields[parts[i]];
  }
  obj.fields[parts[parts.length - 1]] = value;
}

// ---- values ----
// number (scalar double), {type:'matrix', rows}, string (char row vector), {type:'struct', fields}, {type:'cell', items},
// boolean (logical scalar), {type:'fh', text}
const makeStruct = fields => ({ type: 'struct', fields });
const isStruct = v => v && v.type === 'struct';
const isCell = v => v && v.type === 'cell';
const isMatrix = v => v && v.type === 'matrix';
const isScalarNumber = v => typeof v === 'number' || typeof v === 'boolean';
const emptyMatrix = () => ({ type: 'matrix', rows: [] });
function toArray(v) {
  if (typeof v === 'number') { return [v]; }
  if (isMatrix(v)) { return v.rows.flat(); }
  if (isCell(v)) { return v.items; }
  return [v];
}
function truthy(v) {
  if (typeof v === 'boolean') { return v; }
  if (typeof v === 'number') { return v !== 0; }
  if (isMatrix(v)) { const a = v.rows.flat(); return a.length > 0 && a.every(x => x !== 0); }
  return !!v;
}
function classOf(v) {
  if (typeof v === 'number' || isMatrix(v)) { return 'double'; }
  if (typeof v === 'boolean') { return 'logical'; }
  if (typeof v === 'string') { return 'char'; }
  if (isStruct(v)) { return 'struct'; }
  if (isCell(v)) { return 'cell'; }
  if (v && v.type === 'fh') { return 'function_handle'; }
  return 'double';
}
function sizeOf(v) {
  if (typeof v === 'string') { return [v.length ? 1 : 0, v.length]; }
  if (isMatrix(v)) { return [v.rows.length, v.rows[0]?.length ?? 0]; }
  if (isCell(v)) { return [v.items.length ? 1 : 0, v.items.length]; }
  return [1, 1];
}
const sizeText = (v, sep = 'x') => sizeOf(v).join(sep);

// ---- display ([docs] MATLAB's default "format short, loose" layout; [guess] spacing through the LS, S11) ----
function fmtNum(x) {
  if (typeof x === 'boolean') { return x ? '1' : '0'; }
  if (Number.isInteger(x)) { return String(x); }
  return x.toFixed(4);
}
function displayValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean') { return `\n    ${fmtNum(v).padStart(5)}\n`; }
  if (typeof v === 'string') { return `\n    '${v}'\n`; }
  if (isMatrix(v)) {
    if (!v.rows.length) { return '\n     []\n'; }
    const cells = v.rows.map(r => r.map(fmtNum));
    const w = Math.max(...cells.flat().map(s => s.length)) + 4;
    return '\n' + cells.map(r => '  ' + r.map(s => s.padStart(w)).join('')).join('\n') + '\n';
  }
  if (isStruct(v)) {
    const keys = Object.keys(v.fields);
    const pad = Math.max(0, ...keys.map(k => k.length));
    return '\n  struct with fields:\n\n' + keys.map(k => `    ${k.padStart(pad)}: ${inlineValue(v.fields[k])}`).join('\n') + '\n';
  }
  if (isCell(v)) {
    return `\n  ${sizeText(v, '×')} cell array\n\n    ${v.items.map(x => `{${inlineValue(x)}}`).join('    ')}\n`;
  }
  if (v && v.type === 'fh') { return `\n  function_handle with value:\n\n    ${v.text}\n`; }
  return '\n';
}
function inlineValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean') { return isStructParent ? fmtNum(v) : `[${fmtNum(v)}]`; }
  if (typeof v === 'string') { return `'${v}'`; }
  if (isMatrix(v)) { return v.rows.length === 1 && v.rows[0].length <= 10 ? `[${v.rows[0].map(fmtNum).join(' ')}]` : `[${sizeText(v, '×')} double]`; }
  if (isStruct(v)) { return `[${sizeText(v, '×')} struct]`; }
  if (isCell(v)) { return `{${sizeText(v, '×')} cell}`; }
  return '';
}
let isStructParent = false;
function display(name, v) {
  isStructParent = isStruct(v);
  const text = `${name} =\n${displayValue(v)}\n`;
  isStructParent = false;
  return text;
}

function sprintf(fmt, args) {
  let i = 0;
  const flat = args.flatMap(a => (isMatrix(a) ? a.rows.flat() : [a]));
  const once = () => fmt.replace(/%(-?\d*)(?:\.(\d+))?([dfgs%])/g, (all, width, prec, conv) => {
    if (conv === '%') { return '%'; }
    const a = flat[i++];
    let s;
    if (conv === 's') { s = String(a ?? ''); }
    else if (conv === 'd') { s = a === undefined ? '' : String(Math.round(Number(a))); }
    else if (conv === 'f') { s = a === undefined ? '' : Number(a).toFixed(prec ? Number(prec) : 6); }
    else { s = a === undefined ? '' : String(Number(a)); }
    return width ? (width.startsWith('-') ? s.padEnd(-width) : s.padStart(Number(width))) : s;
  }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  let res = once();
  while (i > 0 && i < flat.length) { res += once(); }
  return res;
}

// ---- expressions ----
const BUILTIN_FUNCS = ['zeros', 'ones', 'numel', 'size', 'sum', 'sqrt', 'struct', 'num2str', 'isempty', 'pi', 'true', 'false', 'disp', 'magic', 'linspace', 'input', 'error', 'fprintf', 'plot', 'mean'];

function evaluate(expr, ws) {
  const p = new Parser(expr, ws);
  const v = p.parseExpr();
  p.skip();
  if (p.i < p.s.length) { throw new MatlabErr(`Invalid expression. Check for missing or extra characters.`); }
  return v;
}

class Parser {
  constructor(s, ws) { this.s = s; this.i = 0; this.ws = ws; }
  skip() { while (this.s[this.i] === ' ' || this.s[this.i] === '\t') { this.i++; } }
  peek(t) { this.skip(); return this.s.startsWith(t, this.i); }
  eat(t) { if (this.peek(t)) { this.i += t.length; return true; } return false; }
  parseExpr() { return this.parseRange(); }
  parseRange() {
    const a = this.parseCompare();
    if (this.peek(':') && !this.peek('::')) {
      this.eat(':');
      let step = 1, b = this.parseCompare();
      if (this.eat(':')) { step = b; b = this.parseCompare(); }
      const row = [];
      for (let x = Number(a); step > 0 ? x <= Number(b) + 1e-12 : x >= Number(b) - 1e-12; x += Number(step)) { row.push(x); }
      return { type: 'matrix', rows: [row] };
    }
    return a;
  }
  parseCompare() {
    let a = this.parseAdd();
    for (;;) {
      const op = ['==', '~=', '<=', '>=', '<', '>'].find(o => this.peek(o));
      if (!op) { return a; }
      this.eat(op);
      const b = this.parseAdd();
      a = elementwise(a, b, (x, y) => ({ '==': x === y, '~=': x !== y, '<=': x <= y, '>=': x >= y, '<': x < y, '>': x > y })[op]);
    }
  }
  parseAdd() {
    let a = this.parseMul();
    for (;;) {
      if (this.eat('+')) { a = elementwise(a, this.parseMul(), (x, y) => x + y); }
      else if (this.peek('-')) { this.eat('-'); a = elementwise(a, this.parseMul(), (x, y) => x - y); }
      else { return a; }
    }
  }
  parseMul() {
    let a = this.parseUnary();
    for (;;) {
      if (this.eat('.*') || this.eat('*')) { a = elementwise(a, this.parseUnary(), (x, y) => x * y); }
      else if (this.eat('./') || this.eat('/')) { a = elementwise(a, this.parseUnary(), (x, y) => x / y); }
      else { return a; }
    }
  }
  parseUnary() {
    if (this.eat('-')) { return elementwise(this.parseUnary(), 0, x => -x); }
    if (this.eat('~')) { return elementwise(this.parseUnary(), 0, x => !truthy(x)); }
    return this.parsePow();
  }
  parsePow() {
    const a = this.parsePostfix();
    if (this.eat('.^') || this.eat('^')) { return elementwise(a, this.parseUnary(), (x, y) => x ** y); }
    return a;
  }
  parsePostfix() {
    let v = this.parsePrimary();
    for (;;) {
      if (this.peek('.') && /[A-Za-z]/.test(this.s[this.i + 1] ?? '')) {
        this.eat('.');
        const f = /^[A-Za-z]\w*/.exec(this.s.slice(this.i))[0];
        this.i += f.length;
        if (!isStruct(v) || !(f in v.fields)) { throw new MatlabErr(`Unrecognized field name "${f}".`); }
        v = v.fields[f];
      } else if (this.peek('{') && isCell(v)) {
        this.eat('{');
        const k = Number(this.parseExpr()); this.eat('}');
        if (!(k >= 1 && k <= v.items.length)) { throw new MatlabErr(`Index exceeds the number of array elements. Index must not exceed ${v.items.length}.`); }
        v = v.items[k - 1];
      } else if (this.peek('(') && (isMatrix(v) || isCell(v) || typeof v === 'number')) {
        this.eat('(');
        const k = Number(this.parseExpr()); this.eat(')');
        const arr = toArray(v);
        if (!(k >= 1 && k <= arr.length)) { throw new MatlabErr(`Index exceeds the number of array elements. Index must not exceed ${arr.length}.`); }
        v = isCell(v) ? { type: 'cell', items: [arr[k - 1]] } : arr[k - 1];
      } else { return v; }
    }
  }
  parsePrimary() {
    this.skip();
    const rest = this.s.slice(this.i);
    let m;
    if ((m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/.exec(rest))) { this.i += m[0].length; return Number(m[0]); }
    if (rest[0] === "'" || rest[0] === '"') {
      const q = rest[0]; let j = 1, s = '';
      for (; j < rest.length; j++) {
        if (rest[j] === q) { if (rest[j + 1] === q) { s += q; j++; continue; } break; }
        s += rest[j];
      }
      this.i += j + 1;
      return s;
    }
    if (rest[0] === '@') {   // anonymous function: kept as text
      this.i = this.s.length;
      return { type: 'fh', text: rest.trim() };
    }
    if (this.eat('(')) { const v = this.parseExpr(); this.eat(')'); return v; }
    if (this.eat('[')) { return this.parseMatrix(); }
    if (this.eat('{')) {
      const items = [];
      while (!this.peek('}')) { items.push(this.parseExpr()); this.eat(',') || this.eat(';'); if (this.i >= this.s.length) { break; } }
      this.eat('}');
      return { type: 'cell', items };
    }
    if ((m = /^[A-Za-z]\w*/.exec(rest))) {
      const name = m[0];
      this.i += name.length;
      if (this.ws.has(name)) { return this.ws.get(name); }
      if (this.peek('(')) {
        this.eat('(');
        const args = [];
        while (!this.peek(')')) { args.push(this.parseExpr()); if (!this.eat(',')) { break; } }
        this.eat(')');
        return callFunction(name, args);
      }
      if (BUILTIN_FUNCS.includes(name)) { return callFunction(name, []); }
      // [docs] R2020b+ wording.
      throw new MatlabErr(`Unrecognized function or variable '${name}'.`, 'MATLAB:UndefinedFunction');
    }
    throw new MatlabErr('Invalid expression. Check for missing or extra characters.');
  }
  parseMatrix() {
    const rows = [[]];
    while (!this.peek(']')) {
      if (this.i >= this.s.length) { throw new MatlabErr('Invalid expression. When calling a function or indexing a variable, use parentheses.'); }
      if (this.eat(';')) { rows.push([]); continue; }
      if (this.eat(',')) { continue; }
      const v = this.parseExpr();
      rows[rows.length - 1].push(...toArray(v));
      this.skip();
    }
    this.eat(']');
    if (rows.length === 1 && rows[0].length === 1) { return rows[0][0]; }
    return { type: 'matrix', rows: rows.filter(r => r.length) };
  }
}

function elementwise(a, b, f) {
  if (isMatrix(a) || isMatrix(b)) {
    const shape = isMatrix(a) ? a : b;
    return { type: 'matrix', rows: shape.rows.map((r, i) => r.map((_, j) => num(f(isMatrix(a) ? a.rows[i][j] : a, isMatrix(b) ? b.rows[i][j] : b)))) };
  }
  return f(a, b);
}
const num = x => (typeof x === 'boolean' ? (x ? 1 : 0) : x);

function callFunction(name, args) {
  switch (name) {
    case 'zeros': case 'ones': {
      const n = Number(args[0] ?? 1), m = Number(args[1] ?? args[0] ?? 1);
      if (n === 1 && m === 1) { return name === 'zeros' ? 0 : 1; }
      return { type: 'matrix', rows: Array.from({ length: n }, () => Array(m).fill(name === 'zeros' ? 0 : 1)) };
    }
    case 'magic': return { type: 'matrix', rows: [[8, 1, 6], [3, 5, 7], [4, 9, 2]] };
    case 'numel': return toArray(args[0]).length;
    case 'size': return { type: 'matrix', rows: [sizeOf(args[0])] };
    case 'sum': return toArray(args[0]).reduce((s, x) => s + Number(x), 0);
    case 'mean': { const a = toArray(args[0]); return a.reduce((s, x) => s + Number(x), 0) / a.length; }
    case 'sqrt': return elementwise(args[0], 0, x => Math.sqrt(x));
    case 'num2str': return fmtNum(Number(args[0]));
    case 'isempty': return sizeOf(args[0]).includes(0);
    case 'pi': return Math.PI;
    case 'true': return true;
    case 'false': return false;
    case 'linspace': {
      const [a, b, n = 100] = args.map(Number);
      return { type: 'matrix', rows: [Array.from({ length: n }, (_, k) => a + (b - a) * k / (n - 1))] };
    }
    case 'struct': {
      const f = {};
      for (let k = 0; k + 1 < args.length; k += 2) { f[String(args[k])] = args[k + 1]; }
      return makeStruct(f);
    }
    case 'plot': return undefined;
    default:
      throw new MatlabErr(`Unrecognized function or variable '${name}'.`, 'MATLAB:UndefinedFunction');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// feval: the extension's hidden queries.

function onFeval({ requestId, functionName, nargout, args }) {
  // [code] fevalResponse {requestId, result}; [guess] result is {result: [outputs...]} for success (MVM.ts typing)
  // and an MVMError {error: {id, msg}} for a MATLAB error (S5).
  const respond = result => notify('fevalResponse', { requestId, result });
  const ws = debugFrame && prompt === 'DEBUG' ? debugFrame.ws : base;   // [guess] fevals at K>> see the stopped frame (S13)
  const busy = env.MCW_FAKE_FEVAL_PROMPTS === '1';
  const restore = prompt;
  if (busy) { setPrompt('BUSY'); }
  let result;
  try {
    const outs = fevalImpl(functionName, args ?? [], ws);
    result = { result: nargout > 0 ? outs.slice(0, nargout) : [] };
  } catch (e) {
    result = { error: { id: e.id ?? '', msg: e.msg ?? String(e) } };
  }
  setTimeout(() => {
    if (busy) { setPrompt(restore); }
    respond(result);
  }, 5);
}

function fevalImpl(fn, args, ws) {
  switch (fn) {
    case 'addpath': return [];
    case 'cd': if (args[0]) { changeDir(String(args[0])); } return [cwd];
    case 'pwd': return [cwd];
    case 'version': return [`9.99.0 (${RELEASE})`];
    // [verified, R2026b] MATLAB's signature data, as recorded for a few inputs (other inputs: no signatures).
    case 'matlabls.internal.getCompletions': {
      const recorded = require('../fixtures/getCompletions-R2026b.json');
      return recorded[String(args[0])] ?? [{ widgetType: 'none' }];
    }
    case 'which': return [whichName(String(args[0]), ws)];
    // [docs] who() returns a cell array of names; [guess] it arrives as a JSON array of strings (S5).
    case 'who': return [[...ws.keys()]];
    case 'help': return [helpText(String(args[0]))];
    default:
      throw new MatlabErr(`Undefined function '${fn}' for input arguments of type 'char'.`, 'MATLAB:UndefinedFunction');
  }
}

function whichName(name, ws) {
  if (ws.has(name)) { return `${name} is a variable.`; }
  const local = path.join(cwd, `${name}.m`);
  if (fs.existsSync(local)) { return local; }
  if (BUILTIN_FUNCS.includes(name)) { return `built-in (C:\\Program Files\\MATLAB\\${RELEASE}\\toolbox\\matlab\\elmat\\${name})`; }
  return '';
}

/** [docs] newer help layout ("name - summary", "Syntax" section); user files: H1 + comment block. [guess] via LS, S10. */
function helpText(name) {
  if (name === 'zeros') {
    return ' zeros - Create array of all zeros\n    This MATLAB function returns the scalar 0.\n\n    Syntax\n      X = zeros\n      X = zeros(n)\n      X = zeros(sz1,...,szN)\n\n    Input Arguments\n      n - Size of square matrix\n\n    See also ones, rand\n';
  }
  if (name === 'linspace') {
    return ' LINSPACE Linearly spaced vector.\n    LINSPACE(X1, X2) generates a row vector of 100 linearly\n    equally spaced points between X1 and X2.\n\n    LINSPACE(X1, X2, N) generates N points between X1 and X2.\n';
  }
  const local = path.join(cwd, `${name}.m`);
  if (fs.existsSync(local)) {
    const lines = fs.readFileSync(local, 'utf8').split(/\r?\n/);
    const start = lines.findIndex(l => /^\s*%/.test(l));
    if (start < 0) { return ''; }
    const block = [];
    for (let i = start; i < lines.length && /^\s*%/.test(lines[i]); i++) { block.push(lines[i].replace(/^\s*%/, '')); }
    return block.join('\n') + '\n';
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------------
// Completion ([code] TerminalCompletionRequest {requestId, code, offset} -> TerminalCompletionResponse {requestId,
// result: CompletionList}). [guess] that labels are bare names (no "s." prefix) and kinds use LSP numbers (S14).

function onCompletion({ requestId, code, offset }) {
  const before = String(code).slice(0, offset);
  const m = /((?:[A-Za-z]\w*\.)*)([A-Za-z]\w*)?$/.exec(before);
  const chain = (m?.[1] ?? '').replace(/\.$/, '');
  const word = m?.[2] ?? '';
  const ws = debugFrame && prompt === 'DEBUG' ? debugFrame.ws : base;
  let items = [];
  if (chain) {
    let v; try { v = evaluate(chain, ws); } catch { v = undefined; }
    if (isStruct(v)) { items = Object.keys(v.fields).filter(f => f.startsWith(word)).map(f => ({ label: f, kind: 5 })); }
  } else if (word) {
    items = [
      ...[...ws.keys()].filter(k => k.startsWith(word)).map(k => ({ label: k, kind: 6 })),
      ...BUILTIN_FUNCS.filter(f => f.startsWith(word)).map(f => ({ label: f, kind: 3 })),
      ...['for', 'function', 'while', 'if', 'end'].filter(k => k.startsWith(word)).map(k => ({ label: k, kind: 14 })),
    ];
  }
  setTimeout(() => notify('TerminalCompletionResponse', { requestId, result: { isIncomplete: false, items } }), 5);
}

log(`fake language server started (pid ${process.pid}, args ${process.argv.slice(2).join(' ')})`);
