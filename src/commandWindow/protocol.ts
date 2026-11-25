// Messages between the extension and the Command Window webview. Shared by both sides (no VS Code or DOM imports).

/** What the input line does when Enter is pressed. */
export type InputMode =
  | 'ready'     // >>  run a command
  | 'debug'     // K>> run a command in the debugger's frame
  | 'input'     // answer input() (the line is sent as the answer)
  | 'pause'     // `pause` without argument: Enter continues
  | 'busy'      // a command runs: Enter queues the next one
  | 'exited';   // no session: Enter starts one and runs the command

/** Settings the webview needs (sent on load and when they change). */
export interface WebviewSettings {
  /** matlabCommandWindow.collapseLongOutput: collapse long output once its command finishes. */
  collapseLongOutput: boolean;
  /** matlabCommandWindow.historyPopup: Up opens the Command History pop-up (else Up recalls inline). */
  historyPopup: boolean;
}

export interface CompletionItem { label: string; kind: 'v' | 'f' | 'k' | 'F'; }
export type { PathChoice, PathCompletion, SignatureHelp, SignatureForm, SignatureParam } from '../language/signatures';
import type { PathCompletion, SignatureHelp } from '../language/signatures';

export interface HelpResult {
  name: string;
  /** Usage forms, e.g. "X = zeros(n)". */
  signatures: string[];
  /** Short description. */
  doc: string;
  /** Defining file, when it is an m-file. */
  file?: string;
  /** MathWorks documentation page (functions that ship with MATLAB or a toolbox). */
  docUrl?: string;
}

/** Extension -> webview. */
export type ToWebview =
  | { type: 'echo'; text: string; prompt: string }
  | { type: 'output'; text: string; stream: 'out' | 'err' }
  | { type: 'info'; text: string }
  | { type: 'mode'; mode: InputMode; prompt?: string }
  | { type: 'echoInput'; text: string; prompt?: string }
  | { type: 'queued'; id: number; text: string; prompt: string }
  | { type: 'unqueued'; id: number }
  | { type: 'clear' }
  | { type: 'history'; entries: string[] }
  | { type: 'completions'; id: number; items: CompletionItem[] | null }
  | { type: 'help'; id: number; result: HelpResult | null }
  | { type: 'signature'; id: number; result: SignatureHelp | null }
  | { type: 'pathCompletions'; id: number; result: PathCompletion | null }
  | { type: 'focus' }
  | { type: 'sendDropBytes'; id: number }
  | { type: 'forgetDrop'; id: number }
  | { type: 'settings'; settings: WebviewSettings }
  | { type: 'test'; id: number; action: TestAction };

/** Webview -> extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'submit'; code: string }
  | { type: 'stop' }
  | { type: 'cancelQueued'; id: number }
  | { type: 'dropFiles'; uris: string[] }
  /** A file dropped from outside VS Code: its bytes (the webview cannot see its path). */
  | { type: 'dropFileInfo'; id: number; name: string; size: number; lastModified: number }
  | { type: 'dropFileData'; id: number; name: string; data: Uint8Array }
  | { type: 'complete'; id: number; prefix: string; code: string; offset: number }
  | { type: 'help'; id: number; name: string }
  | { type: 'signature'; id: number; code: string; offset: number }
  | { type: 'completePaths'; id: number; code: string; offset: number }
  | { type: 'openFile'; file: string; line?: number }
  | { type: 'openDoc'; url: string; name: string }
  | { type: 'openFunction'; name: string; line?: number }
  | { type: 'clear' }
  | { type: 'testResult'; id: number; result: unknown };

/** Test hooks (integration tests only; the webview ignores them unless built with test hooks enabled). */
export type TestAction =
  | { kind: 'snapshot' }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: 'Enter' | 'Shift-Enter' | 'ArrowUp' | 'ArrowDown' | 'Escape' | 'Tab' | 'Ctrl-Space' | 'Alt-ArrowDown' | 'Shift-ArrowUp' | 'ArrowRight' }
  | { kind: 'clickLink'; index: number }
  | { kind: 'toggleCollapse'; index: number }
  | { kind: 'clickStop' }
  | { kind: 'cancelQueued'; index: number }
  /** The output area shrinks to px (as when the panel is restored from maximized); result: distance from the bottom. */
  | { kind: 'shrinkOutput'; px: number }
  | { kind: 'drop'; type: string; data: string }
  /** A file dragged from outside VS Code (only its bytes, base64), dropped on the input line. */
  | { kind: 'dropFile'; name: string; base64: string; lastModified?: number }
  | { kind: 'hoverShow'; word: string }
  | { kind: 'hover'; word: string };

/** What a snapshot reports. */
export interface Snapshot {
  text: string;            // output area text
  errorText: string;       // text of error-styled spans
  mode: InputMode;
  prompt: string;
  input: string;           // input line content
  links: { text: string; file?: string; func?: string; line?: number }[];
  collapsed: number;       // number of collapsed output blocks
  completions: string[];   // labels in the open completion pop-up
  tooltip: string;         // text of the open help tooltip / hint
  signature: string;       // text of the signature box ('' when closed)
  signatureActive: string; // the highlighted argument in the signature box
  signatureDocLink: boolean; // its ⓘ opens the documentation
  stopVisible: boolean;
  queued: string[];        // commands shown as waiting
  historyPopup: string[];  // rows of the open Command History pop-up ("2x cmd" for repeats), [] when closed
  historySelected: string[]; // its selected commands
  highlighted: string[];   // token classes used in the input line (syntax highlighting)
}
