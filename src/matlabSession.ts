import { EventEmitter } from 'events';
import { CommandQueue, Job } from './commandQueue';
import { CompletionCandidate, MatlabBackend, MatlabError, PromptState } from './backend/types';

/**
 * The shared MATLAB session as the rest of the extension sees it: one backend, one queue, one state.
 * No VS Code dependency, so it is tested against the fake language server in plain Node (scripts/session.test.ts).
 *
 * Ordering: a CommandQueue keeps exactly one job in flight. A visible command (`sendLine`) is finished by the
 * first idle prompt (READY or DEBUG) after MATLAB reported BUSY for it, or by its eval response, whichever comes
 * first. That way a run that stops at a breakpoint (`keyboard`, `dbstop`) finishes with 'debug' and the K>> prompt
 * accepts the next command, although MATLAB completes that eval only after dbcont/dbquit. Hidden queries
 * (`query`) are fevals and finish on their response; they never change the visible state.
 *
 * While a command runs, input() moves the state to 'input' and `pause` (no argument) to 'pause'; `sendInput`
 * answers. Assumptions about the backend's event order are listed in test/fake/fakeLanguageServer.js.
 */
export type SessionState = 'starting' | 'idle' | 'busy' | 'input' | 'pause' | 'debug' | 'exited';
export type PromptKind = 'ready' | 'debug' | 'cancelled';
/** Why the session waits for a line: input() or pause. */
export type InputSource = 'input' | 'pause';

export interface QueryResult<T = unknown> {
  ok: boolean;
  /** Outputs of the function (nargout values) when ok. */
  outputs: T[];
  /** MATLAB error when not ok. */
  error?: MatlabError;
  /** A background query refused because MATLAB was not idle. */
  skipped?: boolean;
  cancelled?: boolean;
}

interface Pending extends Job {
  /** command: code to eval. query: function to feval. */
  fn?: string;
  args?: unknown[];
  nargout?: number;
  onSend?: () => void;
  resolveCommand?: (kind: PromptKind) => void;
  resolveQuery?: (r: QueryResult) => void;
  sawBusy?: boolean;
  finished?: boolean;
}

export interface MatlabSessionEvents {
  output: (text: string, stream: 'out' | 'err') => void;
  state: (state: SessionState) => void;
  /** MATLAB waits at a prompt again after a visible command (`hidden` is false) or a query (true). */
  prompt: (kind: 'ready' | 'debug', hidden: boolean) => void;
  /** A running command waits for a line: input() (with its prompt text) or pause. Answer with sendInput. */
  input: (source: InputSource, prompt: string) => void;
  /**
   * MATLAB waits for input() or pause from a command started elsewhere (the MATLAB terminal, an agent). [verified,
   * R2026b] Every client gets the input/prompt events, but output goes only to the client that started the command,
   * so answering here would split the conversation over two windows. Emitted once per wait.
   */
  foreignInput: (source: InputSource, prompt: string) => void;
  clear: () => void;
  exit: (reason: string) => void;
}

/** After an eval response, how long to wait for the prompt event that tells READY from DEBUG. */
const PROMPT_SETTLE_MS = 60;
/** Prompt states in which MATLAB is running something. */
const BUSY_STATES = new Set<PromptState>(['BUSY', 'MORE', 'COMPLETING_BLOCK']);

export class MatlabSession extends EventEmitter {
  private _state: SessionState = 'starting';
  private readonly queue = new CommandQueue<Pending>(p => this.send(p));
  private lastPrompt: PromptState = 'INITIALIZING';
  private inputPrompt = '';
  /** True while MATLAB waits for input()/pause for a command that is not ours (reported once). */
  private foreignWait = false;
  private _release: string | null = null;
  readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;

  constructor(private readonly backend: MatlabBackend, private readonly log: (m: string) => void = () => undefined) {
    super();
    this.ready = new Promise((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
    this.ready.catch(() => { /* reported by callers */ });
    backend.on('output', (text, stream) => { if (this._state !== 'exited') { this.emit('output', text, stream); } });
    backend.on('prompt', (state, isIdle) => this.onPrompt(state, isIdle));
    backend.on('inputPrompt', p => { this.inputPrompt = p; });
    backend.on('clc', () => this.emit('clear'));
    backend.on('exit', reason => this.handleExit(reason));
    backend.on('log', m => this.log(m));
  }

  override on<E extends keyof MatlabSessionEvents>(event: E, listener: MatlabSessionEvents[E]): this { return super.on(event, listener); }

  get state(): SessionState { return this._state; }
  get release(): string | null { return this._release; }
  /** Jobs running or waiting. */
  get queuedCount(): number { return this.queue.size; }

  /** Start MATLAB. Resolves when it accepts commands. */
  async start(): Promise<void> {
    try {
      const info = await this.backend.start();
      this._release = info.release;
    } catch (e) {
      this.readyReject(e as Error);
      this.handleExit((e as Error).message);
      throw e;
    }
    if (this._state === 'exited') { const e = new Error('MATLAB exited during startup.'); this.readyReject(e); throw e; }
    this.setState(this.lastPrompt === 'DEBUG' ? 'debug' : 'idle');
    this.readyResolve();
    this.queue.prompt(true);
  }

  /**
   * Queue code to run as if typed at the prompt. Resolves with the prompt MATLAB showed afterwards
   * ('ready', 'debug' = stopped in the debugger at K>>, 'cancelled' = dropped by interrupt/exit).
   */
  sendLine(code: string, onSend?: () => void): Promise<PromptKind> {
    if (this._state === 'exited') { return Promise.resolve('cancelled'); }
    return new Promise(resolve => {
      this.queue.push({ kind: 'command', line: code, onSend, resolveCommand: resolve });
    });
  }

  /**
   * Call a MATLAB function without echo (a hidden query). A `background` query (completion, help tooltip) only
   * runs when MATLAB is idle with nothing queued; otherwise it resolves at once with `skipped`.
   */
  query<T = unknown>(fn: string, args: unknown[] = [], opts: { background?: boolean; nargout?: number } = {}): Promise<QueryResult<T>> {
    if (this._state === 'exited') { return Promise.resolve({ ok: false, outputs: [], cancelled: true }); }
    const skipped: QueryResult<T> = { ok: false, outputs: [], skipped: true };
    if (opts.background && this._state !== 'idle' && this._state !== 'debug') { return Promise.resolve(skipped); }
    return new Promise(resolve => {
      const accepted = this.queue.push({
        kind: opts.background ? 'background' : 'query', line: fn, fn, args, nargout: opts.nargout ?? 1,
        resolveQuery: r => resolve(r as QueryResult<T>),
      });
      if (!accepted) { resolve(skipped); }
    });
  }

  /** MATLAB's own completion (background: only when idle). */
  async complete(code: string, offset: number): Promise<CompletionCandidate[] | undefined> {
    if ((this._state !== 'idle' && this._state !== 'debug') || this.queue.size > 0 || !this.backend.complete) { return undefined; }
    return this.backend.complete(code, offset);
  }

  /** Answer input() (state 'input') or continue after pause (state 'pause'). False when nothing waits. */
  sendInput(text: string): boolean {
    if (this._state === 'input') {
      this.setState('busy');
      void this.backend.eval(text.replace(/\r?\n/g, ' ')).catch(() => undefined);
      return true;
    }
    if (this._state === 'pause') {
      this.setState('busy');
      this.backend.unpause();
      return true;
    }
    return false;
  }

  /** Ctrl+C: drop queued jobs and interrupt the running one. */
  interrupt(): void {
    if (this._state === 'exited') { return; }
    for (const p of this.queue.cancelWaiting()) { this.finish(p, 'cancelled'); }
    this.backend.interrupt();
    // [verified once, R2026b] An interrupt can be ignored (seen after a figure and a K>> round in the spike); a second
    // one then stops MATLAB at once. Re-send while the same command is still running, but never to a later one.
    const job = this.queue.current;
    if (!job || this._state !== 'busy') { return; }
    for (const ms of [2000, 5000]) {
      setTimeout(() => {
        if (this.queue.current === job && this._state === 'busy') {
          this.log(`still busy ${ms / 1000} s after interrupt: sending it again`);
          this.backend.interrupt();
        }
      }, ms).unref?.();
    }
  }

  dispose(): void {
    this.backend.dispose();
    this.handleExit('stopped');
  }

  // ---------- internals ----------

  /** Called by the queue when it is this job's turn. */
  private send(p: Pending): void {
    if (p.kind === 'command') {
      try { p.onSend?.(); } catch (e) { this.log(`onSend failed: ${(e as Error).message}`); }
      this.setState('busy');
      // [verified, R2026b] MATLAB does not always send READY after a command (e.g. after an input() answer it can stay
      // "BUSY" until the next prompt), and then the next command goes straight to READY/DEBUG without a new BUSY.
      // When the last state MATLAB reported is already busy, count that as this command's BUSY.
      p.sawBusy = BUSY_STATES.has(this.lastPrompt);
      this.backend.eval(p.line).then(() => this.onEvalResponse(p), () => this.finish(p, 'cancelled'));
      return;
    }
    this.backend.feval(p.fn!, p.nargout ?? 1, p.args ?? []).then(
      outputs => this.finishQuery(p, { ok: true, outputs }),
      e => this.finishQuery(p, e instanceof MatlabError ? { ok: false, outputs: [], error: e } : { ok: false, outputs: [], cancelled: true }));
  }

  private onPrompt(state: PromptState, isIdle: boolean): void {
    this.lastPrompt = state;
    if (this._state === 'exited' || this._state === 'starting') { return; }
    const cur = this.queue.current;
    const command = cur?.kind === 'command' ? cur : undefined;
    if (cur && !command) { return; }   // a hidden query: never changes the visible state
    if ((state === 'INPUT' || state === 'PAUSE') && !command) {
      // Not ours: show MATLAB as busy, do not turn our input line into an answer line.
      if (!this.foreignWait) {
        this.foreignWait = true;
        this.emit('foreignInput', state === 'INPUT' ? 'input' : 'pause', this.inputPrompt);
      }
      this.inputPrompt = '';
      this.setState('busy');
      return;
    }
    if (state !== 'INPUT' && state !== 'PAUSE') { this.foreignWait = false; }
    if (state === 'INPUT') {
      this.setState('input');
      this.emit('input', 'input', this.inputPrompt);
      this.inputPrompt = '';
      return;
    }
    if (state === 'PAUSE') {
      this.setState('pause');
      this.emit('input', 'pause', '');
      return;
    }
    if (isIdle || state === 'READY' || state === 'DEBUG') {
      const kind = state === 'DEBUG' ? 'debug' : 'ready';
      if (command) {
        if (command.sawBusy) { this.finish(command, kind); }
        return;
      }
      // No command of ours in flight (e.g. MATLAB finished something the language server started).
      this.setState(kind === 'debug' ? 'debug' : 'idle');
      return;
    }
    // BUSY, MORE, COMPLETING_BLOCK, INITIALIZING
    if (command) { command.sawBusy = true; }
    this.setState('busy');
  }

  private onEvalResponse(p: Pending): void {
    if (p.finished) { return; }
    // The prompt notification that says READY or DEBUG may come just after the response.
    setTimeout(() => {
      if (p.finished) { return; }
      this.finish(p, this.lastPrompt === 'DEBUG' ? 'debug' : 'ready');
    }, PROMPT_SETTLE_MS);
  }

  private finish(p: Pending, kind: PromptKind): void {
    if (p.finished) { return; }
    p.finished = true;
    if (this.queue.current === p) {
      if (kind !== 'cancelled') { this.setState(kind === 'debug' ? 'debug' : 'idle'); }
      this.queue.prompt(this._state !== 'exited', done => {
        done?.resolveCommand?.(kind);
        if (kind !== 'cancelled') { this.emit('prompt', kind, false); }
      });
    } else {
      p.resolveCommand?.(kind);
    }
  }

  private finishQuery(p: Pending, r: QueryResult): void {
    if (p.finished) { return; }
    p.finished = true;
    if (this.queue.current === p) {
      this.queue.prompt(this._state !== 'exited', done => {
        done?.resolveQuery?.(r);
        if (!r.cancelled) { this.emit('prompt', this._state === 'debug' ? 'debug' : 'ready', true); }
      });
    } else {
      p.resolveQuery?.(r);
    }
  }

  private setState(s: SessionState): void {
    if (this._state === s || this._state === 'exited') { return; }
    this._state = s;
    this.emit('state', s);
  }

  private handleExit(reason: string): void {
    if (this._state === 'exited') { return; }
    this.log(`MATLAB session ended: ${reason}`);
    this._state = 'exited';
    this.emit('state', 'exited');
    this.readyReject(new Error(`MATLAB exited: ${reason}`));
    for (const p of this.queue.cancelAll()) {
      p.finished = true;
      p.resolveCommand?.('cancelled');
      p.resolveQuery?.({ ok: false, outputs: [], cancelled: true });
    }
    this.emit('exit', reason);
  }
}
