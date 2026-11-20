// The interface between the session core (src/matlabSession.ts) and whatever actually runs MATLAB.
// No VS Code dependency. Implementations:
//   - LsBackend (src/backend/lsBackend.ts): our own instance of the MathWorks MATLAB language server, driven
//     through its MVM notifications. The real backend. UNVERIFIED against real MATLAB (see TESTING-WITH-MATLAB.md).
//   - The same LsBackend pointed at test/fake/fakeLanguageServer.js: the fake MATLAB used by all automated tests.
// A future backend (e.g. a MATLAB-side socket server, or an API of the official extension) implements the same
// interface; nothing above this file needs to change.

/** MATLAB's prompt states, as the MathWorks MVM reports them (mvmPromptChange). */
export type PromptState =
  | 'INITIALIZING' | 'READY' | 'BUSY' | 'DEBUG' | 'INPUT' | 'PAUSE' | 'MORE' | 'COMPLETING_BLOCK';

/** An error raised by MATLAB for a feval (MException identifier and message). */
export class MatlabError extends Error {
  constructor(readonly identifier: string, message: string) { super(message); }
}

export interface BackendEvents {
  /** Text MATLAB printed (Command Window output). */
  output: (text: string, stream: 'out' | 'err') => void;
  /** The prompt changed. `isIdle`: MATLAB waits at a command prompt (READY or DEBUG). */
  prompt: (state: PromptState, isIdle: boolean) => void;
  /** input() is about to wait: its prompt string (sent before the INPUT prompt state). */
  inputPrompt: (prompt: string) => void;
  /** clc was called. */
  clc: () => void;
  /** The backend lost MATLAB (crash, exit, language server gone). */
  exit: (reason: string) => void;
  /** Diagnostic line for the log. */
  log: (message: string) => void;
}

export interface StartInfo {
  /** MATLAB release, e.g. "R2025b", when known. */
  release: string | null;
}

export interface MatlabBackend {
  /** Launch MATLAB (or connect). Resolves once MATLAB accepts commands. */
  start(): Promise<StartInfo>;
  /**
   * Evaluate code as if typed at the prompt (output appears as `output` events while it runs). Resolves when
   * MATLAB reports the eval as complete; this may be much later than the next idle prompt (e.g. when the code
   * stops at a breakpoint, the eval completes only after dbcont/dbquit).
   * While MATLAB waits in input() (state INPUT), the text is the answer.
   */
  eval(code: string): Promise<void>;
  /** Call a function without echo; resolves with its outputs (array of nargout values). Rejects with MatlabError. */
  feval(fn: string, nargout: number, args: unknown[]): Promise<unknown[]>;
  /** Ctrl+C. */
  interrupt(): void;
  /** Continue after `pause` with no argument (state PAUSE). */
  unpause(): void;
  /** MATLAB's own completion for `code` with the cursor at `offset`; undefined when unsupported. */
  complete?(code: string, offset: number): Promise<CompletionCandidate[] | undefined>;
  dispose(): void;
  on<E extends keyof BackendEvents>(event: E, listener: BackendEvents[E]): this;
}

export interface CompletionCandidate {
  label: string;
  /** v = variable, f = field/property, k = keyword, F = function or other name. */
  kind: 'v' | 'f' | 'k' | 'F';
}
