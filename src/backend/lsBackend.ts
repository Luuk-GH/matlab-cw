// The real MATLAB backend: our own instance of the MathWorks MATLAB language server (the one that ships with the
// official "MATLAB" extension), driven only through its MVM notifications. See RESEARCH.md §2 for the protocol,
// read from mathworks/MATLAB-language-server v1.3.16 (src/mvm/MVMServer.ts, src/notifications/NotificationService.ts).
//
// The language server does NOT start MATLAB: it connects (--matlabUrl) through a local relay
// (connectorProxy.ts) to the web connector of an existing MATLAB, normally the one the official extension runs,
// shared with shareMATLABSession(). On dispose it only disconnects; the shared MATLAB keeps running.
//
// Attach mode runs the server through lsLoader.ts, which fixes --matlabUrl mode in memory (verified cause, see there).
//
// Verified with the spike on MATLAB R2026b (extension 1.3.16); see TESTING-WITH-MATLAB.md for what is still open. Every assumption about message contents is also encoded in
// test/fake/fakeLanguageServer.js (which is what the automated tests use) and is checked by the spike.
//
// No VS Code dependency.
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { RunningProxy, startConnectorProxy, ConnectorTarget } from './connectorProxy';
import { JsonRpcPeer } from './jsonRpc';
import { FALLBACK_RELEASE, LOADER_SOURCE, PATCH_MISSING_MARKER } from './lsLoader';
import { matlabReleaseOfProcess } from './sharedSession';
import { BackendEvents, CompletionCandidate, MatlabBackend, MatlabError, PromptState, StartInfo } from './types';

export interface LsBackendOptions {
  /** Path of the language server's entry point (`<official extension>/server/out/index.js`) or of the fake. */
  serverPath: string;
  /** The existing MATLAB's web connector (from shareMATLABSession()). */
  attach: ConnectorTarget & { pid?: number };
  /** Folder for the language server process. */
  cwd?: string;
  /** Node executable. In the extension host this is VS Code itself (run as Node via ELECTRON_RUN_AS_NODE). */
  execPath?: string;
  /** Extra environment variables (tests use them to configure the fake). */
  env?: Record<string, string>;
  /** How long to wait for MATLAB to accept commands. */
  startTimeoutMs?: number;
  /** How long the engine may take to answer once the connector connection is up (default 10 s). */
  engineTimeoutMs?: number;
  /** Called with every message sent ('->') and received ('<-') (the spike records them). */
  trace?: (direction: '->' | '<-', message: unknown) => void;
}

/** LSP CompletionItemKind numbers -> our kinds. */
const KIND: Record<number, CompletionCandidate['kind']> = { 5: 'f', 10: 'f', 6: 'v', 14: 'k' };
/**
 * MATLAB wraps warnings in [\b ... ]\b and errors in {\b ... }\b ([verified, R2026b]); the official terminal strips
 * these and colours the text. Errors already arrive on stream 1 (stderr).
 */
const WARNING_MARKS = /\[\x08|\]\x08|\{\x08|\}\x08/g;

export class LsBackend extends EventEmitter implements MatlabBackend {
  private child: ChildProcess | undefined;
  private peer: JsonRpcPeer | undefined;
  private nextId = 1;
  private readonly evals = new Map<string, () => void>();
  private readonly fevals = new Map<string, { resolve: (v: unknown[]) => void; reject: (e: Error) => void }>();
  private readonly completions = new Map<number, (r: CompletionCandidate[] | undefined) => void>();
  private exited = false;
  /** Set while starting: a 'disconnected' status then means the connection failed. */
  private onDisconnected: (() => void) | undefined;
  /** The loader did not find the code it fixes (another MATLAB extension version, possibly already fixed). */
  private patchMissing = false;
  /** Set while starting: the connector connection is up; now the engine (MVM) must answer. */
  private onConnectorUp: (() => void) | undefined;
  private release: string | null = null;
  /** The shared MATLAB's release as read from its process, told to the language server (lsLoader.ts). */
  private releaseHint: string | null = null;
  private proxy: RunningProxy | undefined;

  constructor(private readonly opts: LsBackendOptions) { super(); }

  override on<E extends keyof BackendEvents>(event: E, listener: BackendEvents[E]): this { return super.on(event, listener); }

  private log(m: string): void { this.emit('log', m); }

  async start(): Promise<StartInfo> {
    this.proxy = await startConnectorProxy(this.opts.attach, m => this.log(m));
    this.releaseHint = await matlabReleaseOfProcess(this.opts.attach.pid ?? 0);
    this.log(`shared MATLAB release: ${this.releaseHint ?? `unknown (assuming ${FALLBACK_RELEASE} or newer)`}`);
    try {
      const info = await this.launch(this.proxy.url);
      // The language server only knows the release we told it (lsLoader.ts); ask MATLAB for the real one.
      const v = await this.feval('version', 1, []).catch(() => undefined);
      const m = /\((R\d{4}\w)\)/.exec(String(v?.[0] ?? ''));
      this.release = m ? m[1] : null;
      info.release = this.release;
      return info;
    } catch (e) {
      void this.proxy?.close();
      throw e;
    }
  }

  private launch(matlabUrl: string): Promise<StartInfo> {
    const args = ['--node-ipc', '--matlabConnectionTiming=onDemand', '--indexWorkspace=false', `--matlabUrl=${matlabUrl}`];
    this.log(`starting language server: ${this.opts.serverPath} ${args.map(a => a.replace(/matlabUrl=.*$/, 'matlabUrl=<relay>')).join(' ')}`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env, ELECTRON_RUN_AS_NODE: '1' };
    const execPath = this.opts.execPath ?? process.execPath;
    const stdio: ('ignore' | 'pipe' | 'ipc')[] = ['ignore', 'pipe', 'pipe', 'ipc'];
    // Run through the loader, which fixes --matlabUrl mode in memory (lsLoader.ts).
    const child = spawn(execPath, ['-e', LOADER_SOURCE, this.opts.serverPath, ...args],
      { cwd: this.opts.cwd, env: { ...env, MCW_MATLAB_RELEASE: this.releaseHint ?? FALLBACK_RELEASE }, stdio, windowsHide: true });
    this.child = child;
    child.stdout?.on('data', (b: Buffer) => this.log(`[ls] ${b.toString().trimEnd()}`));
    child.stderr?.on('data', (b: Buffer) => {
      const text = b.toString();
      if (text.includes(PATCH_MISSING_MARKER)) {
        // Not fatal: a newer extension may have fixed the bug itself. If the engine then does not answer, say why.
        this.patchMissing = true;
        this.log('the loader did not find the code it fixes (other MATLAB extension version); trying without the fix');
      }
      this.log(`[ls err] ${text.trimEnd()}`);
    });

    const trace = this.opts.trace;
    const peer = new JsonRpcPeer({
      send: m => {
        trace?.('->', m);
        try { child.send(m as object); } catch (e) { this.log(`send failed: ${(e as Error).message}`); }
      },
      onMessage: l => child.on('message', m => { trace?.('<-', m); l(m); }),
    }, m => this.log(m));
    this.peer = peer;
    // Requests the server may send. We advertise no client capabilities, so these should be rare.
    peer.onRequest((method) => {
      if (method === 'workspace/configuration') { return [{}]; }
      return null;
    });

    peer.onNotification('text', (d: { text: string; stream: number }) => {
      if (!d || typeof d.text !== 'string') { return; }
      if (d.stream === 0 && d.text.startsWith('[\x08')) { this.emit('output', d.text.replace(WARNING_MARKS, ''), 'err'); return; }
      this.emit('output', d.text.replace(WARNING_MARKS, ''), d.stream === 0 ? 'out' : 'err');
    });
    peer.onNotification('mvmPromptChange', (d: { state: PromptState; isIdle: boolean }) => this.emit('prompt', d.state, !!d.isIdle));
    peer.onNotification('mvmInputPrompt', (p: unknown) => this.emit('inputPrompt', inputPromptText(p)));
    peer.onNotification('clc', () => this.emit('clc'));
    peer.onNotification('evalResponse', (d: { requestId: string }) => {
      const done = this.evals.get(d?.requestId);
      if (done) { this.evals.delete(d.requestId); done(); }
    });
    peer.onNotification('fevalResponse', (d: { requestId: string; result: unknown }) => {
      const p = this.fevals.get(d?.requestId);
      if (!p) { return; }
      this.fevals.delete(d.requestId);
      const err = fevalError(d.result);
      if (err) { p.reject(err); } else { p.resolve(fevalOutputs(d.result)); }
    });
    peer.onNotification('TerminalCompletionResponse', (d: { requestId: number; result: unknown }) => {
      const done = this.completions.get(d?.requestId);
      if (done) { this.completions.delete(d.requestId); done(completionItems(d.result)); }
    });
    peer.onNotification('matlab/connection/update/server', (d: { connectionStatus?: string }) => {
      this.log(`connection: ${JSON.stringify(d)}`);
      if (d?.connectionStatus === 'disconnected') { this.onDisconnected?.(); }
      if (d?.connectionStatus === 'connected') { this.onConnectorUp?.(); }
    });
    peer.onNotification('telemetry/logdata', () => { /* never forwarded anywhere */ });
    peer.onNotification('window/logMessage', (d: { message?: string }) => this.log(`[ls log] ${d?.message ?? ''}`));

    return new Promise<StartInfo>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        clearTimeout(engineTimer);
        reject(new Error(reason));
      };
      let engineTimer: NodeJS.Timeout | undefined;
      // Seen with the bug the loader fixes: the connection comes up, the engine never does. Do not wait for the
      // overall timeout.
      const engineMs = this.opts.engineTimeoutMs ?? 10000;
      this.onConnectorUp = () => {
        clearTimeout(engineTimer);
        engineTimer = setTimeout(() => fail(this.patchMissing
          ? 'This version of the MATLAB extension is not supported by the Command Window yet (its language server ' +
            'changed). Please report it with the version number.'
          : `Reached the shared MATLAB, but its engine did not answer within ${Math.round(engineMs / 1000)} s. ` +
            'See View → Output → MATLAB Command Window.'), engineMs);
      };
      const timeoutMs = this.opts.startTimeoutMs ?? 20000;
      const timer = setTimeout(() => fail(`MATLAB did not become ready within ${Math.round(timeoutMs / 1000)} s.`), timeoutMs);
      // [code] RemoteMatlabSession reports DISCONNECTED when the connection fails or MATLAB goes away.
      this.onDisconnected = () => {
        if (!settled) { fail('Could not connect to the shared MATLAB.'); }
        else { this.lost('MATLAB disconnected'); }
      };
      peer.onNotification('mvmStateChange', (d: { state: string; release?: string | null }) => {
        this.log(`mvm state: ${JSON.stringify(d)}`);
        if (d?.state === 'connected') {
          this.release = d.release ?? this.release;
          if (!settled) { settled = true; clearTimeout(timer); clearTimeout(engineTimer); resolve({ release: this.release }); }
        } else if (d?.state === 'disconnected') {
          if (!settled) { fail('MATLAB disconnected during startup.'); } else { this.lost('MATLAB disconnected'); }
        }
      });
      child.on('error', e => { fail(`language server could not start: ${e.message}`); this.lost(e.message); });
      child.on('exit', code => { fail(`language server exited (code ${code}) before MATLAB was ready.`); this.lost(`language server exited (code ${code})`); });

      void peer.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'matlab-command-window' },
        rootUri: null,
        capabilities: {},
      }, 60000).then(() => {
        peer.notify('initialized', {});
        peer.notify('matlab/request');   // onDemand: start MATLAB now
      }, e => fail(`language server did not initialize: ${(e as Error).message}`));
    });
  }

  eval(code: string): Promise<void> {
    if (this.exited || !this.peer) { return Promise.reject(new Error('MATLAB is not running')); }
    const requestId = `e${this.nextId++}`;
    return new Promise(resolve => {
      this.evals.set(requestId, resolve);
      this.peer!.notify('evalRequest', { requestId, command: code, isUserEval: true });
    });
  }

  feval(fn: string, nargout: number, args: unknown[]): Promise<unknown[]> {
    if (this.exited || !this.peer) { return Promise.reject(new Error('MATLAB is not running')); }
    const requestId = `f${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.fevals.set(requestId, { resolve, reject });
      this.peer!.notify('fevalRequest', { requestId, functionName: fn, nargout, args, isUserEval: false });
    });
  }

  interrupt(): void { this.peer?.notify('interruptRequest'); }

  /** Send any notification (the spike uses this to probe the protocol directly). */
  rawNotify(method: string, params?: unknown): void { this.peer?.notify(method, params); }

  unpause(): void { this.peer?.notify('unpauseRequest', {}); }

  complete(code: string, offset: number): Promise<CompletionCandidate[] | undefined> {
    if (this.exited || !this.peer) { return Promise.resolve(undefined); }
    const requestId = this.nextId++;
    return new Promise(resolve => {
      this.completions.set(requestId, resolve);
      this.peer!.notify('TerminalCompletionRequest', { requestId, code, offset });
      setTimeout(() => { if (this.completions.delete(requestId)) { resolve(undefined); } }, 3000);
    });
  }

  dispose(): void {
    const child = this.child;
    if (!child || this.exited) { return; }
    // [code] In --matlabUrl mode a polite LSP shutdown only disconnects (RemoteMatlabSession.shutdown closes the
    // connection); MATLAB keeps running. Kill the server if it does not exit soon.
    void this.peer?.request('shutdown', null, 3000).then(() => this.peer?.notify('exit'), () => undefined);
    const proxy = this.proxy;
    setTimeout(() => { if (child.exitCode === null) { child.kill(); } void proxy?.close(); }, 1500);
    this.lost('disposed');
  }

  private lost(reason: string): void {
    if (this.exited) { return; }
    this.exited = true;
    if (reason !== 'disposed') { void this.proxy?.close(); }
    this.peer?.close(reason);
    for (const done of this.evals.values()) { done(); }
    this.evals.clear();
    for (const p of this.fevals.values()) { p.reject(new Error(reason)); }
    this.fevals.clear();
    for (const done of this.completions.values()) { done(undefined); }
    this.completions.clear();
    this.emit('exit', reason);
  }
}

/** [verified, R2026b] mvmInputPrompt params are an array: ["Enter a number: "]. Accept a string or {promptString} too. */
export function inputPromptText(p: unknown): string {
  const v = Array.isArray(p) ? p[0] : p;
  if (typeof v === 'string') { return v; }
  const s = (v as { promptString?: unknown } | null)?.promptString;
  return typeof s === 'string' ? s : '';
}

/** An MVMError looks like {error: {id, msg}} (MVMInterface.d.ts). Also accept {error: {identifier, message}}. */
function fevalError(result: unknown): MatlabError | undefined {
  const e = (result as { error?: { id?: string; msg?: string; identifier?: string; message?: string } } | null)?.error;
  if (!e || typeof e !== 'object') { return undefined; }
  return new MatlabError(e.id ?? e.identifier ?? '', e.msg ?? e.message ?? 'MATLAB error');
}

/**
 * The extension types a feval result as `{result: T[]}` (MVM.ts). Be lenient: accept a bare array or a single value
 * too, because this was read from typings, not observed (spike check S5).
 */
export function fevalOutputs(result: unknown): unknown[] {
  if (result && typeof result === 'object' && !Array.isArray(result) && 'result' in result) {
    const r = (result as { result: unknown }).result;
    return Array.isArray(r) ? r : [r];
  }
  if (Array.isArray(result)) { return result; }
  return result === undefined || result === null ? [] : [result];
}

/** TerminalCompletionResponse.result is an LSP CompletionList (or item array). */
export function completionItems(result: unknown): CompletionCandidate[] | undefined {
  const items = Array.isArray(result) ? result : (result as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) { return undefined; }
  return items
    .filter((i): i is { label: string; kind?: number } => !!i && typeof (i as any).label === 'string')
    .map(i => ({ label: i.label, kind: KIND[i.kind ?? 0] ?? 'F' }));
}
