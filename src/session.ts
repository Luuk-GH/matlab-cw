import * as fs from 'fs';
import * as vscode from 'vscode';
import { LsBackend } from './backend/lsBackend';
import { readSharedSession, SharedSession, sessionFilePath } from './backend/sharedSession';
import { CompletionCandidate } from './backend/types';
import { ConsoleView } from './consoleView';
import { HelpInfo, parseHelp } from './language/helpText';
import { parseSignatures, SignatureHelp } from './language/signatures';
import { describeServer, resolveServer } from './locator';
import { InputSource, MatlabSession, PromptKind, QueryResult, SessionState } from './matlabSession';
import { matlabString, textOf } from './sessionText';

export { matlabString, textOf };

/** Opens the Command Window (registered by the webview provider). */
export interface CommandWindowReveal { reveal(preserveFocus: boolean): void; isVisible(): boolean; }

/** How to share a MATLAB session (shown when there is none). */
export const SHARE_HINT =
  'To connect, run shareMATLABSession() in the MATLAB that the MATLAB extension runs (its MATLAB terminal), ' +
  'or in your MATLAB desktop. It comes with MathWorks\' MATLAB MCP Server Toolbox (installed by the MATLAB Agentic Toolkit, R2023a or newer).';

/**
 * The Command Window's connection to an EXISTING MATLAB: the one shared with shareMATLABSession(), normally the
 * MATLAB the official MATLAB extension runs. There is never a second MATLAB: we run our own instance of the
 * official extension's language server, attached (--matlabUrl, through a local relay) to that MATLAB's connector.
 * Disconnecting never quits MATLAB.
 */
export class SessionManager implements vscode.Disposable {
  private session: MatlabSession | undefined;
  private connected: SharedSession | undefined;
  private starting: Promise<MatlabSession> | undefined;
  private readonly status: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private readonly views = new Set<ConsoleView>();
  private webview: CommandWindowReveal | undefined;
  private inputPrompt = '';
  private lastSeenMtime = 0;
  private helpCache = new Map<string, Promise<HelpInfo | undefined>>();
  private readonly promptEmitter = new vscode.EventEmitter<{ kind: 'ready' | 'debug'; hidden: boolean }>();
  private readonly outputEmitter = new vscode.EventEmitter<{ text: string; stream: 'out' | 'err' }>();
  private readonly exitEmitter = new vscode.EventEmitter<void>();
  private readonly stateEmitter = new vscode.EventEmitter<SessionState>();
  readonly onDidPrompt = this.promptEmitter.event;
  readonly onDidOutput = this.outputEmitter.event;
  readonly onDidExit = this.exitEmitter.event;
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.status = vscode.window.createStatusBarItem('matlabCommandWindow.connection', vscode.StatusBarAlignment.Left, 49);
    this.status.name = 'MATLAB Command Window';
    this.updateStatus('disconnected');
    this.status.show();
    this.disposables.push(this.status, this.promptEmitter, this.outputEmitter, this.exitEmitter, this.stateEmitter,
      vscode.workspace.onDidSaveTextDocument(d => { if (/\.m$/i.test(d.fileName)) { this.helpCache.clear(); } }));
    this.watchSessionFile();
  }

  // ---------- public API ----------

  /** Connection/session state ('exited' when not connected). */
  get state(): SessionState { return this.session?.state ?? 'exited'; }
  get running(): boolean { const s = this.state; return s === 'busy' || s === 'input' || s === 'pause'; }
  get release(): string | null { return this.session?.release ?? null; }
  /** The shared session we are attached to. */
  get sharedSession(): SharedSession | undefined { return this.connected; }

  /** Show the Command Window and connect if possible. */
  async show(preserveFocus = false): Promise<void> {
    this.webview?.reveal(preserveFocus);
    await this.connect(false).catch(() => undefined);
  }

  addView(view: ConsoleView): vscode.Disposable {
    this.views.add(view);
    return new vscode.Disposable(() => this.views.delete(view));
  }

  registerCommandWindow(w: CommandWindowReveal): void { this.webview = w; }

  /** Show the Command Window without connecting (preserveFocus: keep the focus where it is, e.g. in the editor). */
  reveal(preserveFocus: boolean): void { this.webview?.reveal(preserveFocus); }

  private forViews(fn: (v: ConsoleView) => void): void {
    for (const v of this.views) {
      try { fn(v); } catch (e) { this.log.warn(`Command Window view: ${(e as Error).message}`); }
    }
  }

  /** A line or block entered in the Command Window: answers input()/pause, or runs as a command. */
  async submitFromWindow(code: string): Promise<void> {
    const s = this.session;
    if (s && (s.state === 'input' || s.state === 'pause')) {
      const prompt = s.state === 'input' ? this.inputPrompt : '';
      if (s.sendInput(code)) { this.forViews(v => v.echoInput(code, prompt)); }
      return;
    }
    await this.execute(code);
  }

  /** Run code as if typed in the Command Window (echoed). Connects first if needed. Queued while busy. */
  async execute(code: string, display = code): Promise<PromptKind> {
    const trimmed = code.replace(/\s+$/, '');
    if (!trimmed.trim()) { return 'ready'; }
    const s = await this.connect(true);
    if (s.state !== 'idle' || s.queuedCount > 0) { this.log.info(`queued while ${s.state}: ${display}`); }
    return s.sendLine(trimmed, () => this.forViews(v => v.echoCommand(display)));
  }

  /** A hidden function call that returns text; only when connected (and idle, for background calls). */
  async queryText(fn: string, args: unknown[] = [], background = true, timeoutMs = 4000): Promise<string | undefined> {
    const s = this.session;
    if (!s || s.state === 'exited' || s.state === 'starting') { return undefined; }
    const r = await withTimeout(s.query(fn, args, { background }), timeoutMs) as QueryResult | undefined;
    if (!r || !r.ok) { if (r?.error) { this.log.warn(`${fn}: ${r.error.message}`); } return undefined; }
    return textOf(r.outputs[0]);
  }

  /**
   * Completion for the input line (`line`, cursor at `offset`; `prefix` = identifier being typed): MATLAB's own
   * completion through the language server; falls back to variable names from who(). Undefined while busy.
   */
  async completeNames(prefix: string, line?: string, offset?: number): Promise<[string, CompletionCandidate['kind']][] | undefined> {
    const s = this.session;
    if (!s || (s.state !== 'idle' && s.state !== 'debug')) { return undefined; }
    if (line !== undefined && offset !== undefined) {
      const items = await s.complete(line, offset);
      if (items && items.length) { return items.map(i => [i.label, i.kind]); }
    }
    if (prefix.includes('.')) { return undefined; }
    const r = await withTimeout(s.query<unknown>('who', [], { background: true }), 2000);
    if (!r || !r.ok) { return undefined; }
    const names = flatStrings(r.outputs[0]);
    return names.filter(n => n.startsWith(prefix)).map(n => [n, 'v']);
  }

  /** Which MATLAB function gives signature data; undefined after both failed (then the help text is used). */
  private signatureFns: string[] = ['matlabls.internal.getCompletions', 'matlabls.handlers.completions.getCompletions'];

  /**
   * MATLAB's own signature help for the call the cursor is in (forms, argument purposes and values), from the
   * MATLAB extension's matlabls.internal.getCompletions ([verified, R2026b + extension 1.3.16]). Only when idle.
   * [verified] In extension 1.3.16 the documented wrapper matlabls.handlers.completions.getCompletions calls a function
   * that does not exist, so the internal one is tried first.
   */
  async signatureFor(code: string, offset: number): Promise<SignatureHelp | undefined> {
    const s = this.session;
    if (!s || (s.state !== 'idle' && s.state !== 'debug')) { return undefined; }
    for (const fn of [...this.signatureFns]) {
      const r = await withTimeout(s.query(fn, [code, '', offset], { background: true }), 3000) as QueryResult | undefined;
      if (!r) { return undefined; }   // busy or slow: try again on the next keystroke
      if (r.ok) { return parseSignatures(r.outputs[0]); }
      if (r.cancelled) { return undefined; }
      // Not available in this extension version: do not try it again.
      this.log.info(`signature help: ${fn} failed (${r.error?.message ?? 'error'}); not using it`);
      this.signatureFns = this.signatureFns.filter(f => f !== fn);
    }
    return undefined;
  }

  /** Usage lines and a one-line description from help(), cached until a .m file is saved. Only when idle. */
  helpFor(name: string): Promise<HelpInfo | undefined> {
    const hit = this.helpCache.get(name);
    if (hit) { return hit; }
    const s = this.session;
    if (!s || (s.state !== 'idle' && s.state !== 'debug')) { return Promise.resolve(undefined); }
    const p = (async () => {
      const help = await this.queryText('help', [name], true, 4000);
      if (help === undefined) { this.helpCache.delete(name); return undefined; }
      const which = await this.queryText('which', [name], true, 2000) ?? '';
      const info = parseHelp(name, which, help);
      if (info?.file && !info.signatures.length) {
        try { return parseHelp(name, which, help, fs.readFileSync(info.file, 'utf8')); } catch { /* unreadable */ }
      }
      return info;
    })();
    this.helpCache.set(name, p);
    return p;
  }

  /** The file that defines `name` (which()), for links. Only when idle. */
  async whichFile(name: string): Promise<string | undefined> {
    // A click on a link: MATLAB may be busy for a moment (shared MATLAB: other clients such as the MATLAB extension
    // also run code after an error, [verified, R2026b]). Wait up to 3 s for it to be idle; background queries are
    // refused while busy.
    for (let i = 0; i < 30 && this.state === 'busy'; i++) { await new Promise(r => setTimeout(r, 100)); }
    let w = await this.queryText('which', [name], true, 2000);
    for (let i = 0; i < 10 && w === undefined && this.state !== 'exited'; i++) {
      await new Promise(r => setTimeout(r, 300));
      w = await this.queryText('which', [name], true, 2000);
    }
    const f = w?.trim().replace(/^built-in \((.*)\)$/, '$1');
    return f && /\.(m|mlx)$/i.test(f) && fs.existsSync(f) ? f : undefined;
  }

  async interrupt(): Promise<void> {
    if (this.running) { this.session?.interrupt(); }
  }

  /**
   * Connect to the shared MATLAB (no-op when connected). `report`: show a message when there is nothing to
   * connect to (otherwise only the Command Window says so).
   */
  async connect(report: boolean): Promise<MatlabSession> {
    if (!vscode.workspace.isTrusted) {
      const err: ReportedError = new Error('The MATLAB Command Window needs a trusted workspace.');
      err.reported = true;
      if (report) {
        void vscode.window.showWarningMessage('MATLAB Command Window: connecting to MATLAB needs a trusted workspace (Restricted Mode is on).',
          'Manage Workspace Trust').then(c => { if (c) { void vscode.commands.executeCommand('workbench.trust.manage'); } });
      }
      throw err;
    }
    if (this.session && this.session.state !== 'exited') {
      if (this.starting) { return this.starting; }
      await this.session.ready;
      return this.session;
    }
    this.starting = this.attach(report).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Disconnect (MATLAB keeps running). */
  disconnect(): void {
    if (!this.session) { return; }
    this.forViews(v => v.info('Disconnected. MATLAB keeps running in the MATLAB extension.'));
    this.stopSession();
  }

  dispose(): void {
    this.stopSession();
    fs.unwatchFile(sessionFilePath());
    this.disposables.forEach(d => d.dispose());
  }

  // ---------- internals ----------

  private async attach(report: boolean): Promise<MatlabSession> {
    const lookup = readSharedSession();
    if (!lookup.ok) {
      const msg = `${lookup.message} ${SHARE_HINT}`;
      this.forViews(v => v.info(msg));
      this.log.info(`${lookup.message} (${lookup.file})`);
      if (report) {
        void vscode.window.showInformationMessage(`MATLAB Command Window: ${lookup.message} Run shareMATLABSession() in the MATLAB terminal, then try again.`,
          'Copy Command').then(c => { if (c) { void vscode.env.clipboard.writeText('shareMATLABSession()'); } });
      }
      const err: ReportedError = new Error(lookup.message);
      err.reported = true;
      throw err;
    }
    const shared = lookup.session;
    let server;
    try {
      server = resolveServer(vscode.workspace.getConfiguration('matlabCommandWindow').get<string>('languageServerPath') ?? '');
    } catch (err) {
      const msg = (err as Error).message;
      this.forViews(v => v.info(msg));
      void vscode.window.showErrorMessage(msg, 'Install MATLAB Extension').then(choice => {
        if (choice) { void vscode.commands.executeCommand('workbench.extensions.search', 'MathWorks.language-matlab'); }
      });
      (err as ReportedError).reported = true;
      throw err;
    }
    // MCW_TRACE=1: log the engine messages (prompt states, evals, input) to the output channel, for diagnosing.
    const trace = process.env.MCW_TRACE === '1'
      ? (dir: '->' | '<-', m: unknown) => {
        const method = (m as { method?: string })?.method ?? '';
        if (/^(mvm|eval|feval|text|interrupt|unpause|clc|DebugAdaptor)/i.test(method)) { this.log.info(`${dir} ${JSON.stringify(m).slice(0, 300)}`); }
      }
      : undefined;
    const backend = new LsBackend({ serverPath: server.path, attach: shared, env: testEnv(), startTimeoutMs: CONNECT_TIMEOUT_MS, trace });
    const s = new MatlabSession(backend, m => this.log.info(m));
    this.session = s;
    this.lastSeenMtime = shared.mtimeMs;
    s.on('output', (text, stream) => {
      if (this.session !== s || !text) { return; }
      this.forViews(v => v.writeOutput(text, stream));
      this.outputEmitter.fire({ text, stream });
    });
    s.on('clear', () => { if (this.session === s) { this.forViews(v => v.clearScreen()); } });
    s.on('input', (source: InputSource, prompt: string) => {
      if (this.session !== s) { return; }
      this.inputPrompt = prompt;
      this.forViews(v => v.requestInput(source, prompt));
      this.webview?.reveal(true);
    });
    s.on('foreignInput', (source: InputSource, prompt: string) => {
      if (this.session !== s) { return; }
      const what = source === 'input' ? `input()${prompt.trim() ? ` ("${prompt.trim()}")` : ''}` : 'pause (press Enter)';
      this.forViews(v => v.info(`MATLAB is waiting for ${what} from a command started outside this window, e.g. in the MATLAB terminal. Answer it there: its output goes to that window.`));
    });
    s.on('state', st => this.onState(s, st));
    s.on('prompt', (kind, hidden) => {
      if (this.session !== s) { return; }
      if (s.queuedCount === 0) { this.forViews(v => v.showPrompt(kind)); }
      this.promptEmitter.fire({ kind, hidden });
    });
    s.on('exit', reason => {
      if (this.session !== s) { return; }
      this.session = undefined;
      this.connected = undefined;
      this.helpCache.clear();
      this.exitEmitter.fire();
      this.forViews(v => v.resetInput());
      this.forViews(v => v.info(`Connection to MATLAB ended (${reason}). It reconnects when MATLAB is shared again, or type a command to retry.`));
      this.updateStatus('disconnected');
    });

    this.updateStatus('connecting');
    this.forViews(v => v.info(`Connecting to MATLAB (process ${shared.pid || '?'}) through ${describeServer(server)}…`));
    try {
      await s.start();
    } catch (err) {
      if (this.session === s) { this.stopSession(); }
      this.updateStatus('disconnected');
      const msg = `Could not connect to MATLAB: ${(err as Error).message}`;
      this.forViews(v => v.info(`${msg} If MATLAB was restarted, run shareMATLABSession() again.`));
      if (report) {
        void vscode.window.showErrorMessage(`MATLAB Command Window: ${msg} See the "MATLAB Command Window" output for details.`, 'Show Log')
          .then(c => { if (c) { this.log.show(); } });
      }
      (err as ReportedError).reported = true;
      throw err;
    }
    this.connected = shared;
    this.log.info(`connected to MATLAB ${s.release ?? ''} (pid ${shared.pid}) via ${describeServer(server)}`);
    this.forViews(v => v.info(`Connected to MATLAB ${s.release ?? ''} (process ${shared.pid || '?'}), shared with the MATLAB extension.`.replace('  ', ' ')));
    if (s.state === 'idle' || s.state === 'debug') { this.forViews(v => v.showPrompt(s.state === 'debug' ? 'debug' : 'ready')); }
    this.updateStatus(s.state);
    return s;
  }

  /**
   * shareMATLABSession() rewrites the session file: connect when the Command Window is visible and we are not
   * connected, or reconnect when a different MATLAB was shared.
   */
  private watchSessionFile(): void {
    const file = sessionFilePath();
    fs.watchFile(file, { interval: 2000 }, cur => {
      if (!cur.mtimeMs || cur.mtimeMs === this.lastSeenMtime) { return; }
      this.lastSeenMtime = cur.mtimeMs;
      if (!vscode.workspace.getConfiguration('matlabCommandWindow').get<boolean>('autoConnect', true)) { return; }
      const lookup = readSharedSession(file);
      if (!lookup.ok) { return; }
      const same = this.connected && this.connected.port === lookup.session.port && this.connected.pid === lookup.session.pid;
      if (same) { return; }
      if (this.session && !this.running) { this.stopSession(); }
      if (!this.session && this.webview?.isVisible()) { void this.connect(false).catch(() => undefined); }
    });
  }

  private onState(s: MatlabSession, st: SessionState): void {
    if (this.session !== s) { return; }
    if (st !== 'starting') { this.updateStatus(st); }
    this.stateEmitter.fire(st);
    void vscode.commands.executeCommand('setContext', 'matlabCommandWindow.busy', st === 'busy' || st === 'input' || st === 'pause');
    if (st === 'busy') { this.forViews(v => v.setBusy()); }
    // [verified, R2026b] A command started elsewhere (the MATLAB terminal) ends with no 'prompt' event of ours:
    // show the prompt again when MATLAB is back at >> / K>> and nothing of ours is running or queued.
    if ((st === 'idle' || st === 'debug') && s.queuedCount === 0) {
      this.forViews(v => v.showPrompt(st === 'debug' ? 'debug' : 'ready'));
    }
  }

  private stopSession(): void {
    const s = this.session;
    this.session = undefined;
    this.connected = undefined;
    if (s && s.state !== 'exited') { this.exitEmitter.fire(); this.forViews(v => v.resetInput()); }
    s?.dispose();
    this.helpCache.clear();
    this.updateStatus('disconnected');
    void vscode.commands.executeCommand('setContext', 'matlabCommandWindow.busy', false);
  }

  private updateStatus(s: SessionState | 'disconnected' | 'connecting'): void {
    const map: Record<string, [string, string, string]> = {
      disconnected: ['$(debug-disconnect) MATLAB CW', 'MATLAB Command Window: not connected. Click to show it and connect.', 'matlabCommandWindow.show'],
      connecting:   ['$(loading~spin) MATLAB CW', 'MATLAB Command Window: connecting to MATLAB…', 'matlabCommandWindow.show'],
      starting:     ['$(loading~spin) MATLAB CW', 'MATLAB Command Window: connecting to MATLAB…', 'matlabCommandWindow.show'],
      idle:         ['$(plug) MATLAB CW', 'MATLAB Command Window: connected, idle.', 'matlabCommandWindow.show'],
      debug:        ['$(debug-pause) MATLAB CW', 'MATLAB Command Window: connected, stopped at K>>.', 'matlabCommandWindow.show'],
      busy:         ['$(sync~spin) MATLAB CW', 'MATLAB Command Window: MATLAB is busy. Click to interrupt.', 'matlabCommandWindow.interrupt'],
      input:        ['$(keyboard) MATLAB CW', 'MATLAB Command Window: MATLAB waits for input.', 'matlabCommandWindow.show'],
      pause:        ['$(debug-pause) MATLAB CW', 'MATLAB Command Window: paused; press Enter in the Command Window.', 'matlabCommandWindow.show'],
      exited:       ['$(debug-disconnect) MATLAB CW', 'MATLAB Command Window: not connected.', 'matlabCommandWindow.show'],
    };
    const [text, tooltip, command] = map[s];
    this.status.text = text;
    this.status.tooltip = tooltip;
    this.status.command = command;
  }
}

/** An error the session already showed to the user (command wrappers don't show it again). */
export interface ReportedError extends Error { reported?: boolean; }

/** Environment for the backend: the fake language server reads MCW_FAKE_* variables (tests only). */
function testEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) { if (k.startsWith('MCW_FAKE_') && v !== undefined) { env[k] = v; } }
  return env;
}

const CONNECT_TIMEOUT_MS = 20000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);
}

/** who() returns a cell array of names; accept the shapes a feval result may take. */
function flatStrings(v: unknown): string[] {
  if (typeof v === 'string') { return [v]; }
  if (Array.isArray(v)) { return v.flatMap(flatStrings); }
  if (v && typeof v === 'object' && 'value' in v) { return flatStrings((v as { value: unknown }).value); }
  return [];
}
