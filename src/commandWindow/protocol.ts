// Messages between the extension and the Command Window webview. Shared by both sides (no VS Code or DOM imports).

/** What the input line does when Enter is pressed. */
export type InputMode =
  | 'ready'     // >>  run a command
  | 'debug'     // K>> run a command in the debugger's frame
  | 'input'     // answer input() (the line is sent as the answer)
  | 'pause'     // `pause` without argument: Enter continues
  | 'busy'      // a command runs: Enter queues the next one
  | 'exited';   // no session: Enter starts one and runs the command

export interface CompletionItem { label: string; kind: 'v' | 'f' | 'k' | 'F'; }
export type { SignatureHelp, SignatureForm, SignatureParam } from '../language/signatures';
import type { SignatureHelp } from '../language/signatures';

export interface HelpResult {
  name: string;
  /** Usage forms, e.g. "X = zeros(n)". */
  signatures: string[];
  /** Short description. */
  doc: string;
  /** Defining file, when it is an m-file. */
  file?: string;
}

/** Extension -> webview. */
export type ToWebview =
  | { type: 'echo'; text: string; prompt: string }
  | { type: 'output'; text: string; stream: 'out' | 'err' }
  | { type: 'info'; text: string }
  | { type: 'mode'; mode: InputMode; prompt?: string }
  | { type: 'echoInput'; text: string; prompt?: string }
  | { type: 'clear' }
  | { type: 'history'; entries: string[] }
  | { type: 'completions'; id: number; items: CompletionItem[] | null }
  | { type: 'help'; id: number; result: HelpResult | null }
  | { type: 'signature'; id: number; result: SignatureHelp | null }
  | { type: 'focus' }
  | { type: 'test'; id: number; action: TestAction };

/** Webview -> extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'submit'; code: string }
  | { type: 'stop' }
  | { type: 'complete'; id: number; prefix: string; code: string; offset: number }
  | { type: 'help'; id: number; name: string }
  | { type: 'signature'; id: number; code: string; offset: number }
  | { type: 'openFile'; file: string; line?: number }
  | { type: 'openFunction'; name: string; line?: number }
  | { type: 'clear' }
  | { type: 'testResult'; id: number; result: unknown };

/** Test hooks (integration tests only; the webview ignores them unless built with test hooks enabled). */
export type TestAction =
  | { kind: 'snapshot' }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: 'Enter' | 'Shift-Enter' | 'ArrowUp' | 'ArrowDown' | 'Escape' | 'Tab' | 'Ctrl-Space' | 'Alt-ArrowDown' }
  | { kind: 'clickLink'; index: number }
  | { kind: 'toggleCollapse'; index: number }
  | { kind: 'clickStop' }
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
  stopVisible: boolean;
  highlighted: string[];   // token classes used in the input line (syntax highlighting)
}
