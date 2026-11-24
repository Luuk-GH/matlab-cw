// The Command Window webview: an HTML output area and a CodeMirror 6 input line. It only renders and
// edits; everything runs in the extension's shared MATLAB session (see ../provider.ts).
import { acceptCompletion, autocompletion, closeCompletion, Completion, CompletionContext, CompletionResult,
  completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history as undoHistory, historyKeymap, indentMore, insertNewlineAndIndent } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, StreamLanguage, StringStream, syntaxHighlighting } from '@codemirror/language';
import { Annotation, Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, hoverTooltip, keymap, placeholder, Tooltip } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { callContext, completionPrefix, maybePathArgument } from '../../language/matlabSyntax';
import { historyRows, HistoryRow } from './historyRows';
import { matlabStreamParser } from './matlabMode';
import { hideHelperFrames, parseAnchors, LinkHit as Hit } from './anchors';
import type { CompletionItem, FromWebview, HelpResult, InputMode, PathCompletion, SignatureHelp, Snapshot, TestAction, ToWebview, WebviewSettings } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const outputEl = document.getElementById('output')!;
const promptEl = document.getElementById('prompt')!;
const stopEl = document.getElementById('stop') as HTMLButtonElement;
const hintEl = document.getElementById('hint')!;
const sigEl = document.getElementById('sigbox')!;
const queueEl = document.getElementById('queue')!;
const testHooks = document.body.dataset.testHooks === 'true';

/** Output blocks longer than this many lines are collapsed once their command finishes (when the setting is on). */
const COLLAPSE_LINES = 40;
/** Oldest blocks are dropped beyond this many. */
const MAX_BLOCKS = 1000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const CLEAR_SCREEN = /\x1b\[2J|\x1bc|\f/;

let mode: InputMode = 'exited';
let inputPrompt: string | undefined;
let history: string[] = [];
let settings: WebviewSettings = { collapseLongOutput: false, historyPopup: true };

// ---------------------------------------------------------------------------------------------------------
// Syntax highlighting (input line and echoed commands), with VS Code theme colours where available.

const matlabLanguage = StreamLanguage.define(matlabStreamParser);
const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--cw-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--cw-string)' },
  { tag: t.number, color: 'var(--cw-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--cw-comment)', fontStyle: 'italic' },
  { tag: t.standard(t.variableName), color: 'var(--cw-builtin)' },
  { tag: t.operator, color: 'var(--cw-operator)' },
  { tag: t.bracket, color: 'var(--cw-bracket)' },
]);

/** Highlighted DOM for a piece of code (echoed commands in the output), using the same MATLAB tokenizer. */
function highlightedCode(code: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parser = matlabStreamParser as unknown as { startState(): unknown; token(s: StringStream, st: unknown): string | null };
  const state = parser.startState();
  code.split('\n').forEach((line, n) => {
    if (n > 0) { frag.append('\n'); }
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      const start = stream.pos;
      const style = parser.token(stream, state);
      if (stream.pos === start) { stream.next(); }   // never loop without progress
      const text = line.slice(start, stream.pos);
      if (style && style !== 'variable') {
        const span = document.createElement('span');
        span.className = `tok-${style.split(' ')[0]}`;
        span.textContent = text;
        frag.append(span);
      } else {
        frag.append(text);
      }
      stream.start = stream.pos;
    }
  });
  return frag;
}

// ---------------------------------------------------------------------------------------------------------
// Output area

interface Block { el: HTMLElement; out: HTMLElement; lines: number; done: boolean; }
let inWarning = false;   // the previous stderr line belonged to a warning (its "> In ..." trace follows)
let current: Block | undefined;

function stickToBottom(): boolean {
  return outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 40;
}
function scrollDown(stick: boolean): void { if (stick) { outputEl.scrollTop = outputEl.scrollHeight; } }

function newBlock(): Block {
  finishBlock();
  const el = document.createElement('div');
  el.className = 'block';
  const out = document.createElement('pre');
  out.className = 'out';
  el.append(out);
  outputEl.append(el);
  while (outputEl.childElementCount > MAX_BLOCKS) { outputEl.firstElementChild!.remove(); }
  current = { el, out, lines: 0, done: false };
  return current;
}

function block(): Block { return current && !current.done ? current : newBlock(); }

/** Collapse a finished block whose output is long (setting collapseLongOutput); a button shows it all again. */
function finishBlock(): void {
  const b = current;
  if (!b || b.done) { return; }
  b.done = true;
  if (!settings.collapseLongOutput) { return; }
  const lines = b.out.textContent!.split('\n').length - (b.out.textContent!.endsWith('\n') ? 1 : 0);
  if (lines <= COLLAPSE_LINES) { return; }
  b.el.classList.add('collapsible', 'collapsed');
  const btn = document.createElement('button');
  btn.className = 'toggle';
  const label = () => { btn.textContent = b.el.classList.contains('collapsed') ? `▸ Show all ${lines} lines` : '▴ Collapse output'; };
  label();
  btn.addEventListener('click', () => { b.el.classList.toggle('collapsed'); label(); });
  b.el.append(btn);
}

function echo(text: string, prompt: string): void {
  const stick = true;
  const b = newBlock();
  const cmd = document.createElement('div');
  cmd.className = 'cmd';
  const p = document.createElement('span');
  p.className = 'cmd-prompt';
  p.textContent = prompt ? prompt + ' ' : '';
  const code = document.createElement('span');
  code.className = 'cmd-code';
  code.append(highlightedCode(text));
  cmd.append(p, code);
  b.el.insertBefore(cmd, b.out);
  scrollDown(stick);
}

function output(text: string, stream: 'out' | 'err'): void {
  const stick = stickToBottom();
  const cls = CLEAR_SCREEN.exec(text);
  if (cls) {   // clc
    clearOutput();
    text = text.slice(cls.index + cls[0].length);
  }
  text = text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
  if (stream === 'err') { text = hideHelperFrames(text); }
  if (!text) { return; }
  const b = block();
  if (stream === 'err') {
    // Errors in red, warnings (and their "> In ..." trace) in yellow, line by line.
    for (const seg of text.split(/(?<=\n)/)) {
      const span = document.createElement('span');
      const isWarning = /^\s*Warning:/.test(seg) || (inWarning && /^(\s*> In |\s)/.test(seg) && seg.trim() !== '');
      inWarning = isWarning;
      span.className = isWarning ? 'warn' : 'err';
      // MATLAB hyperlinks (<a href="matlab:opentoline(...)">) become plain text plus links.
      const a = parseAnchors(seg);
      span.append(linkify(a.text, true, a.links));
      b.out.append(span);
    }
  } else {
    inWarning = false;
    const a = parseAnchors(text);
    b.out.append(linkify(a.text, false, a.links));
  }
  scrollDown(stick);
}

function stdinEcho(text: string, prompt?: string): void {
  // MATLAB may or may not print input()'s prompt itself (spike check S8): add it when the output lacks it.
  const out = block().out;
  if (prompt && !(out.textContent ?? '').endsWith(prompt)) { out.append(prompt); }
  const span = document.createElement('span');
  span.className = 'stdin';
  span.textContent = text + '\n';
  block().out.append(span);
  scrollDown(true);
}

/** A command waiting behind the running one: shown dimmed under the output, with × to drop it, until it starts. */
function showQueued(id: number, text: string, prompt: string): void {
  const stick = stickToBottom();
  const row = document.createElement('div');
  row.className = 'queued';
  row.dataset.id = String(id);
  const p = document.createElement('span');
  p.className = 'cmd-prompt';
  p.textContent = prompt ? prompt + ' ' : '';
  const code = document.createElement('span');
  code.className = 'cmd-code';
  code.append(highlightedCode(text));
  const tag = document.createElement('span');
  tag.className = 'queued-tag';
  tag.textContent = 'queued';
  const x = document.createElement('button');
  x.className = 'queued-cancel';
  x.title = 'Remove from the queue';
  x.textContent = '×';
  x.addEventListener('click', () => { post({ type: 'cancelQueued', id }); editor.focus(); });
  row.append(p, code, tag, x);
  queueEl.append(row);
  queueEl.hidden = false;
  scrollDown(stick);
}

function unqueue(id: number): void {
  queueEl.querySelector(`.queued[data-id="${id}"]`)?.remove();
  queueEl.hidden = !queueEl.childElementCount;
}

function info(text: string): void {
  finishBlock();
  const div = document.createElement('div');
  div.className = 'info';
  div.textContent = text;
  outputEl.append(div);
  current = undefined;
  scrollDown(true);
}

function clearOutput(): void {
  outputEl.textContent = '';
  current = undefined;
}

// ---- file:line links ----

const WIN_PATH = String.raw`[A-Za-z]:[\\/][^\s"'<>|*?\[\]]*?\.(?:m|mlx)`;
const WIN_PATH_SPACES = String.raw`[A-Za-z]:[\\/][^"'<>|*?\[\]\n]*?\.(?:m|mlx)`;
const LINK_PATTERNS: { re: RegExp; make: (m: RegExpExecArray) => Hit }[] = [
  // Error: File: C:\x\y.m Line: 3 Column: 5      (parse errors; also without "Error: ")
  { re: new RegExp(String.raw`File: (${WIN_PATH_SPACES}) Line: (\d+)(?: Column: \d+)?`, 'g'),
    make: m => ({ file: m[1], line: +m[2], start: m.index, end: m.index + m[0].length }) },
  // any C:\path\file.m (optionally :line)
  { re: new RegExp(String.raw`(${WIN_PATH})(?::(\d+))?`, 'g'),
    make: m => ({ file: m[1], line: m[2] ? +m[2] : undefined, start: m.index, end: m.index + m[0].length }) },
  // /unix/path/file.m (optionally :line)
  { re: /(?<![\w.])(\/[^\s"'<>|*?:]+\.m)(?::(\d+))?/g,
    make: m => ({ file: m[1], line: m[2] ? +m[2] : undefined, start: m.index, end: m.index + m[0].length }) },
];
// Stack frames:  "Error in myfun (line 12)", "Error using myfun (line 3)", "> In pkg.fun>sub (line 7)"
const FRAME = /(Error in |Error using |> In |^\s*In )([A-Za-z][\w.>\/@]*) \(line (\d+)\)/gm;

function linkify(text: string, isErr: boolean, anchorLinks: Hit[] = []): DocumentFragment {
  const hits: Hit[] = [...anchorLinks];
  for (const p of LINK_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const h = p.make(m);
      if (!hits.some(o => h.start < o.end && o.start < h.end)) { hits.push(h); }
    }
  }
  if (isErr) {
    FRAME.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FRAME.exec(text))) {
      const start = m.index + m[1].length;
      const h: Hit = { func: m[2], line: +m[3], start, end: m.index + m[0].length };
      if (!hits.some(o => h.start < o.end && o.start < h.end)) { hits.push(h); }
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) { frag.append(text.slice(pos, h.start)); }
    const a = document.createElement('a');
    a.className = 'link';
    a.textContent = text.slice(h.start, h.end);
    a.title = h.file ? `Open ${h.file}${h.line ? ` at line ${h.line}` : ''}` : `Open ${h.func}${h.line ? ` at line ${h.line}` : ''}`;
    if (h.file) { a.dataset.file = h.file; }
    if (h.func) { a.dataset.func = h.func; }
    if (h.line) { a.dataset.line = String(h.line); }
    frag.append(a);
    pos = h.end;
  }
  if (pos < text.length) { frag.append(text.slice(pos)); }
  return frag;
}

outputEl.addEventListener('click', e => {
  const a = (e.target as HTMLElement).closest('a.link') as HTMLAnchorElement | null;
  if (a) {
    e.preventDefault();
    const line = a.dataset.line ? Number(a.dataset.line) : undefined;
    if (a.dataset.file) { post({ type: 'openFile', file: a.dataset.file, line }); }
    else if (a.dataset.func) { post({ type: 'openFunction', name: a.dataset.func, line }); }
  }
});
// A click anywhere (output, empty space, prompt) that does not select text puts the blinking cursor in the input line.
document.addEventListener('mouseup', e => {
  if ((e.target as HTMLElement).closest('a, button, .cm-editor, .cm-tooltip, #sigbox, #histpop')) { return; }
  if (!window.getSelection()?.toString()) { editor.focus(); }
});
// Drop .mat files to load them, from Windows Explorer (or another app). Drags from VS Code's own Explorer never arrive
// here: VS Code blocks webviews during workbench drags (unless Shift is held), and even then the drop did not arrive
// when tried by the user (Chromium keeps drags between the workbench and the webview's process apart).
// The handlers run in the capture phase and stop the events there: VS Code's webview host listens on this window
// and would otherwise block the webview as soon as files are dragged over it, and CodeMirror would paste the file's
// bytes into the input line.
const DROP_TYPES = ['application/vnd.code.uri-list', 'resourceurls', 'codefiles', 'text/uri-list'];
const canDrop = (e: DragEvent) => !!e.dataTransfer && [...DROP_TYPES, 'Files'].some(t => e.dataTransfer!.types.includes(t));
for (const type of ['dragenter', 'dragover'] as const) {
  document.addEventListener(type, e => {
    if (!canDrop(e)) { return; }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = 'copy';
    document.body.classList.add('drop-target');
  }, true);
}
document.addEventListener('dragleave', e => { if (!e.relatedTarget) { document.body.classList.remove('drop-target'); } }, true);
document.addEventListener('drop', e => {
  document.body.classList.remove('drop-target');
  if (!canDrop(e)) { return; }
  e.preventDefault();
  e.stopPropagation();
  const dt = e.dataTransfer!;
  const uris = droppedUris(dt);
  if (uris.length || !dt.files.length) { post({ type: 'dropFiles', uris }); return; }
  // From outside VS Code the webview gets no path: the extension looks for the file by name, size and date and loads
  // that; only when it is not found (and the user agrees) are the bytes sent, to load a copy.
  const mats = [...dt.files].filter(f => /\.mat$/i.test(f.name));
  if (!mats.length) { post({ type: 'dropFiles', uris: [] }); return; }
  for (const f of mats) {
    const id = ++dropId;
    droppedFiles.set(id, f);
    post({ type: 'dropFileInfo', id, name: f.name, size: f.size, lastModified: f.lastModified });
  }
}, true);
let dropId = 0;
const droppedFiles = new Map<number, File>();
/** The extension found no such file and the user chose to load a copy: send its bytes. */
function sendDropBytes(id: number): void {
  const f = droppedFiles.get(id);
  droppedFiles.delete(id);
  f?.arrayBuffer().then(b => post({ type: 'dropFileData', id, name: f.name, data: new Uint8Array(b) }), () => undefined);
}

/** The file URIs in a drop: VS Code's own list (JSON array or lines), else the standard uri-list. */
function droppedUris(dt: DataTransfer): string[] {
  for (const t of DROP_TYPES) {
    const v = dt.getData(t).trim();
    if (!v) { continue; }
    if (v.startsWith('[')) { try { return (JSON.parse(v) as unknown[]).map(String); } catch { /* not JSON */ } }
    return v.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }
  return [];
}

// A click outside the Command History pop-up closes it.
document.addEventListener('mousedown', e => { if (popOpen() && !(e.target as HTMLElement).closest('#histpop')) { closeHistoryPopup(); } });
// The webview gets the focus (its tab or title clicked, the view shown, Alt+Tab back): the cursor goes to the input line.
window.addEventListener('focus', () => { if (!editor.hasFocus) { editor.focus(); } });

// ---------------------------------------------------------------------------------------------------------
// Requests to the extension (completion, help)

let requestId = 0;
const waiting = new Map<number, (v: any) => void>();
function request<T>(msg: (id: number) => FromWebview, timeoutMs = 3000): Promise<T | null> {
  const id = ++requestId;
  return new Promise(res => {
    const timer = setTimeout(() => { waiting.delete(id); res(null); }, timeoutMs);
    waiting.set(id, v => { clearTimeout(timer); res(v); });
    post(msg(id));
  });
}
const canQuery = () => mode === 'ready' || mode === 'debug';

const helpCache = new Map<string, Promise<HelpResult | null>>();
function fetchHelp(name: string): Promise<HelpResult | null> {
  if (!canQuery()) { return Promise.resolve(null); }
  let p = helpCache.get(name);
  if (!p) {
    p = request<HelpResult>(id => ({ type: 'help', id, name }));
    helpCache.set(name, p);
    void p.then(r => { if (!r) { helpCache.delete(name); } });
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------------
// Input line

const KIND_TYPE: Record<CompletionItem['kind'], string> = { v: 'variable', f: 'property', k: 'keyword', F: 'function' };

/**
 * File and folder names, like the MATLAB desktop, for an argument MATLAB declares as a path (load('…, cd …). MATLAB
 * filters them by what is typed, so the list is asked again on every keystroke (filter: false, no validFor). A folder
 * ends in  and has no closing quote: accepting it opens the list of what is inside.
 */
async function pathCompletion(ctx: CompletionContext, lineFrom: number, code: string, offset: number): Promise<CompletionResult | null> {
  const r = await request<PathCompletion>(id => ({ type: 'completePaths', id, code, offset }));
  if (!r || ctx.aborted || r.from > offset) { return null; }
  const options: Completion[] = r.choices.map(c => ({
    label: c.label,
    type: c.folder ? 'folder' : 'file',
    apply: (view: EditorView, _c: Completion, from: number, to: number) => {
      view.dispatch({ changes: { from, to, insert: c.insert }, selection: { anchor: from + c.insert.length }, userEvent: 'input.complete' });
      if (c.folder) { setTimeout(() => startCompletion(view), 0); }
    },
  }));
  return { from: lineFrom + r.from, to: ctx.pos, options, filter: false };
}

async function completionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (!canQuery()) { return null; }
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  if (maybePathArgument(before)) {
    const paths = await pathCompletion(ctx, line.from, line.text, ctx.pos - line.from);
    if (paths || ctx.aborted) { return paths; }
  }
  const cp = completionPrefix(before);
  if (!cp) { return null; }
  const segment = before.slice(cp.segmentStart);
  if (!ctx.explicit && segment.length < 2 && !cp.prefix.includes('.')) { return null; }
  const items = await request<CompletionItem[]>(id => ({ type: 'complete', id, prefix: cp.prefix, code: line.text, offset: ctx.pos - line.from }));
  if (!items || ctx.aborted) { return null; }
  const seen = new Set<string>();
  const options: Completion[] = [];
  for (const it of items) {
    const label = it.label.slice(it.label.lastIndexOf('.') + 1);
    if (seen.has(label)) { continue; }
    seen.add(label);
    options.push({ label, type: KIND_TYPE[it.kind] ?? 'text', boost: it.kind === 'v' || it.kind === 'f' ? 2 : 0 });
  }
  return { from: line.from + cp.segmentStart, options, validFor: /^\w*$/ };
}

/** "Documentation": the page MATLAB's doc would open, in the browser (the extension asks MATLAB on the click). */
function openDocFor(r: HelpResult): void { if (r.docUrl) { post({ type: 'openDoc', url: r.docUrl, name: r.name }); } }
function docLinkEl(r: HelpResult, className: string): HTMLElement {
  const d = document.createElement('a');
  d.className = className;
  d.textContent = 'Documentation';
  d.title = r.docUrl ?? '';
  d.addEventListener('mousedown', e => { e.preventDefault(); openDocFor(r); });
  return d;
}

function helpDom(r: HelpResult): HTMLElement {
  const div = document.createElement('div');
  div.className = 'help';
  for (const s of r.signatures.slice(0, 6)) {
    const code = document.createElement('div');
    code.className = 'help-sig';
    code.textContent = s;
    div.append(code);
  }
  if (r.doc) {
    const d = document.createElement('div');
    d.className = 'help-doc';
    d.textContent = r.doc.length > 400 ? r.doc.slice(0, 397) + '…' : r.doc;
    div.append(d);
  }
  if (r.file) {
    const f = document.createElement('a');
    f.className = 'link help-file';
    f.textContent = r.file;
    f.addEventListener('mousedown', e => { e.preventDefault(); post({ type: 'openFile', file: r.file! }); });
    div.append(f);
  }
  if (r.docUrl) { div.append(docLinkEl(r, 'link help-docurl')); }
  return div;
}

/** Hover over a name in the input line: its usage and description from MATLAB's help (and `which`). */
const helpHover = hoverTooltip((view, pos): Tooltip | null => {
  if (!canQuery()) { return null; }
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    if (m.index <= col && col <= m.index + m[0].length) {
      const name = m[0];
      return {
        pos: line.from + m.index, end: line.from + m.index + name.length, above: true,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'help-tooltip';
          dom.textContent = '…';
          void fetchHelp(name).then(r => { dom.textContent = ''; dom.append(r ? helpDom(r) : document.createTextNode(`No help for ${name}`)); });
          return { dom };
        },
      };
    }
  }
  return null;
}, { hoverTime: 400 });

// ---- history (Up/Down filtered by the text typed before browsing) ----
const fromHistory = Annotation.define<boolean>();
let histIndex = -1;       // -1: editing a new line
let histDraft = '';

function setInput(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    annotations: fromHistory.of(true),
  });
}

function historyMove(view: EditorView, delta: number): boolean {
  if (!history.length || mode === 'input' || mode === 'pause') { return false; }
  const prefix = histIndex === -1 ? view.state.doc.toString() : histDraft;
  let idx = histIndex;
  if (idx === -1) { if (delta > 0) { return false; } histDraft = view.state.doc.toString(); idx = history.length; }
  for (;;) {
    idx += delta;
    if (idx < 0) { return true; }
    if (idx >= history.length) { histIndex = -1; setInput(view, histDraft); return true; }
    if (history[idx].startsWith(prefix) && history[idx] !== view.state.doc.toString()) {
      histIndex = idx;
      setInput(view, history[idx]);
      return true;
    }
  }
}

// ---- Command History pop-up (setting historyPopup), like MATLAB's: Up opens it above the input line with the commands
// that start with what is typed. Up/Down move, Shift+Up/Down select several, Enter runs, Right/Left/Tab put the
// selection on the line, Esc closes; typing narrows the list. A click selects, a double-click runs.

const histPop = document.createElement('div');
histPop.id = 'histpop';
histPop.hidden = true;
histPop.setAttribute('role', 'listbox');
histPop.setAttribute('aria-multiselectable', 'true');
document.getElementById('inputRow')!.append(histPop);
let popRows: HistoryRow[] = [];
let popAnchor = 0;   // selection: rows popAnchor..popActive (either order)
let popActive = 0;
const popOpen = () => !histPop.hidden;

function openHistoryPopup(view: EditorView): boolean {
  if (mode === 'input' || mode === 'pause') { return false; }
  popRows = historyRows(history, view.state.doc.toString());
  if (!popRows.length) { return true; }   // nothing matches: stay (MATLAB beeps)
  popAnchor = popActive = popRows.length - 1;
  closeCompletion(view);
  hideSignature();
  histPop.hidden = false;
  renderHistoryPopup();
  return true;
}

function closeHistoryPopup(): void {
  histPop.hidden = true;
  histPop.textContent = '';
  popRows = [];
}

/** Typing while it is open narrows the list (closes it when nothing matches). */
function refilterHistoryPopup(text: string): void {
  const selected = popRows[popActive]?.text;
  popRows = historyRows(history, text);
  if (!popRows.length) { closeHistoryPopup(); return; }
  const keep = selected === undefined ? -1 : popRows.map(r => r.text).lastIndexOf(selected);
  popAnchor = popActive = keep >= 0 ? keep : popRows.length - 1;
  renderHistoryPopup();
}

/** Build the rows (when the list changes); moving the selection only updates classes (showHistorySelection). */
function renderHistoryPopup(): void {
  const list = document.createElement('div');
  list.className = 'hist-list';
  popRows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.setAttribute('role', 'option');
    const count = document.createElement('span');
    count.className = 'hist-count';
    count.textContent = r.count > 1 ? `${r.count}x` : '';
    const code = document.createElement('span');
    code.className = 'hist-code';
    code.append(highlightedCode(r.text));
    row.append(count, code);
    row.addEventListener('mousedown', e => {
      e.preventDefault();   // keep the focus in the input line
      if (e.shiftKey) { popActive = i; } else { popAnchor = popActive = i; }
      showHistorySelection();
    });
    row.addEventListener('dblclick', () => runHistorySelection(editor));
    list.append(row);
  });
  const foot = document.createElement('div');
  foot.className = 'hist-foot';
  foot.textContent = 'Enter runs · → puts on the line · Shift+↑↓ selects several · Esc closes';
  histPop.replaceChildren(list, foot);
  showHistorySelection();
}

function showHistorySelection(): void {
  const [lo, hi] = [Math.min(popAnchor, popActive), Math.max(popAnchor, popActive)];
  const rows = histPop.querySelector('.hist-list')?.children ?? [];
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('selected', i >= lo && i <= hi);
    rows[i].classList.toggle('active', i === popActive);
    rows[i].setAttribute('aria-selected', String(i >= lo && i <= hi));
  }
  rows[popActive]?.scrollIntoView({ block: 'nearest' });
}

function popSelection(): string[] {
  const [lo, hi] = [Math.min(popAnchor, popActive), Math.max(popAnchor, popActive)];
  return popRows.slice(lo, hi + 1).map(r => r.text);
}

function moveHistoryPopup(view: EditorView, delta: number, extend: boolean): boolean {
  const next = popActive + delta;
  if (next >= popRows.length && !extend) { closeHistoryPopup(); return true; }   // Down past the newest: back to the line
  popActive = Math.max(0, Math.min(popRows.length - 1, next));
  if (!extend) { popAnchor = popActive; }
  showHistorySelection();
  return true;
}

function runHistorySelection(view: EditorView): boolean {
  const codes = popSelection();
  closeHistoryPopup();
  for (const code of codes) { runCode(code); }
  setInput(view, '');
  return true;
}

function putHistorySelection(view: EditorView): boolean {
  const text = popSelection().join('\n');
  closeHistoryPopup();
  setInput(view, text);
  view.focus();
  return true;
}

/** Keys while the pop-up is open (also used by the test hooks); undefined: not handled, CodeMirror goes on. */
const popupKeys: Record<string, (v: EditorView) => boolean> = {
  'ArrowUp': v => moveHistoryPopup(v, -1, false),
  'ArrowDown': v => moveHistoryPopup(v, 1, false),
  'Shift-ArrowUp': v => moveHistoryPopup(v, -1, true),
  'Shift-ArrowDown': v => moveHistoryPopup(v, 1, true),
  'PageUp': v => moveHistoryPopup(v, -10, false),
  'PageDown': v => moveHistoryPopup(v, 10, false),
  'Enter': v => runHistorySelection(v),
  'ArrowRight': v => putHistorySelection(v),
  'ArrowLeft': v => putHistorySelection(v),
  'Tab': v => putHistorySelection(v),
  'Escape': () => { closeHistoryPopup(); return true; },
};
const popupKeymap = Prec.highest(keymap.of(Object.entries(popupKeys).map(([key, run]) => ({ key, run: (v: EditorView) => popOpen() && run(v) }))));

/** Up on the first line: the pop-up (setting historyPopup) or the previous matching command on the line. */
function historyUp(view: EditorView): boolean {
  return settings.historyPopup ? openHistoryPopup(view) : historyMove(view, -1);
}

/** Send one command, as if typed and Enter pressed (it joins the history). */
function runCode(code: string): void {
  if (!code.trim()) { return; }
  post({ type: 'submit', code });
  if (mode !== 'input' && mode !== 'pause') { history.push(code); }
}

function submit(view: EditorView): boolean {
  const code = view.state.doc.toString();
  if (!code.trim() && mode !== 'input' && mode !== 'pause') { return true; }
  post({ type: 'submit', code });
  histIndex = -1;
  histDraft = '';
  if (mode !== 'input' && mode !== 'pause' && code.trim()) { history.push(code); }
  setInput(view, '');
  hintEl.textContent = '';
  return true;
}

const stop = () => { post({ type: 'stop' }); return true; };

/** Esc: close the completion list, else the signature box, else clear the line. */
function escapeKey(v: EditorView): boolean {
  if (completionStatus(v.state)) { return closeCompletion(v); }
  if (!sigEl.hidden) { hideSignature('dismiss'); return true; }
  if (v.state.doc.length) { setInput(v, ''); histIndex = -1; return true; }
  return false;
}

const inputKeys = Prec.high(keymap.of([
  { key: 'Enter', run: v => (completionStatus(v.state) === 'active' ? acceptCompletion(v) : submit(v)) },
  { key: 'Shift-Enter', run: insertNewlineAndIndent },
  {
    key: 'ArrowUp',
    run: v => completionStatus(v.state) === 'active' ? false
      : v.state.doc.lineAt(v.state.selection.main.head).number === 1 ? historyUp(v) : false,
  },
  {
    key: 'ArrowDown',
    run: v => completionStatus(v.state) === 'active' ? false
      : v.state.doc.lineAt(v.state.selection.main.head).number === v.state.doc.lines ? historyMove(v, 1) : false,
  },
  {
    key: 'Escape',
    run: v => escapeKey(v),
  },
  {
    key: 'Tab',
    run: v => {
      if (completionStatus(v.state) === 'active') { return acceptCompletion(v); }
      const head = v.state.selection.main.head;
      const line = v.state.doc.lineAt(head);
      const before = line.text.slice(0, head - line.from);
      const cp = completionPrefix(before);
      if (canQuery() && (cp?.prefix || maybePathArgument(before))) { return startCompletion(v); }
      return indentMore(v);
    },
  },
  { key: 'Ctrl-c', run: v => (v.state.selection.main.empty && (mode === 'busy' || mode === 'input' || mode === 'pause') ? stop() : false) },
  { key: 'Ctrl-l', run: () => { post({ type: 'clear' }); return true; } },
  { key: 'Alt-ArrowDown', run: () => flipSignature(1) },
  { key: 'Alt-ArrowUp', run: () => flipSignature(-1) },
]));

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'inherit', fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'var(--cw-line-height)' },
  '.cm-content': { padding: '0', caretColor: 'var(--vscode-editorCursor-foreground, var(--cw-fg))' },
  '.cm-line': { padding: '0' },
  // [verified] Without a theme cursor colour CodeMirror's default is a 0.8px black line: invisible on a dark theme.
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--vscode-editorCursor-foreground, var(--cw-fg))', marginLeft: '-1px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)', outline: '1px solid var(--vscode-editorBracketMatch-border)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorHoverWidget-background)', color: 'var(--vscode-editorHoverWidget-foreground)',
    border: '1px solid var(--vscode-editorHoverWidget-border)', borderRadius: '3px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background)', color: 'var(--vscode-editorSuggestWidget-foreground)',
    border: '1px solid var(--vscode-editorSuggestWidget-border)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: '14em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground)',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, inherit)',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 'bold', color: 'var(--vscode-editorSuggestWidget-highlightForeground)' },
}, { dark: document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast') });

const placeholderSlot = new Compartment();

const editor = new EditorView({
  parent: document.getElementById('editor')!,
  state: EditorState.create({
    doc: '',
    extensions: [
      EditorView.cspNonce.of(document.body.dataset.nonce ?? ''),
      popupKeymap,
      inputKeys,
      undoHistory(),
      drawSelection(),
      bracketMatching(),
      matlabLanguage,
      syntaxHighlighting(highlightStyle),
      autocompletion({ override: [completionSource], activateOnTyping: true, icons: true, defaultKeymap: true, maxRenderedOptions: 80 }),
      helpHover,
      placeholderSlot.of(placeholder('Type a MATLAB command')),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      theme,
      EditorView.contentAttributes.of({ 'aria-label': 'MATLAB command', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.updateListener.of(u => {
        if (u.docChanged && !u.transactions.some(tr => tr.annotation(fromHistory))) {
          histIndex = -1;
          if (popOpen()) { refilterHistoryPopup(u.state.doc.toString()); }
        }
        if (u.docChanged || u.selectionSet) { scheduleHint(); }
      }),
    ],
  }),
});

// ---- function hint under the input line (usage of the function the cursor is in) ----
let hintTimer: number | undefined;
let hintName = '';
function scheduleHint(): void {
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(updateHint, 250);
}
async function updateHint(): Promise<void> {
  const head = editor.state.selection.main.head;
  const before = editor.state.sliceDoc(0, head);
  const call = canQuery() ? callContext(before) : undefined;
  if (!call) { hintName = ''; hintEl.textContent = ''; hideSignature('leave'); return; }
  // Closed with Esc: stays closed for this call (same function, same opening position) until the cursor leaves it.
  const callKey = call.name + "@" + before.lastIndexOf(call.name + "(");
  if (sigDismissed && sigDismissedKey !== callKey) { sigDismissed = false; }
  if (sigDismissed) { return; }
  sigCallKey = callKey;
  // MATLAB's own signature help (forms, argument purposes and values), like the editor's parameter hints.
  const code = editor.state.doc.toString();
  const sh = await request<SignatureHelp>(id => ({ type: 'signature', id, code, offset: head }), 4000);
  if (editor.state.doc.toString() !== code || editor.state.selection.main.head !== head) { return; }   // typed on
  if (sigDismissed) { return; }
  if (sh && sh.forms.length) {
    hintName = '';
    hintEl.textContent = '';
    showSignature(sh, call.name, before.lastIndexOf(call.name));
    return;
  }
  hideSignature('quiet');
  if (call.name === hintName && hintEl.textContent) { return; }
  hintName = call.name;
  const r = await fetchHelp(call.name);
  if (hintName !== call.name) { return; }
  hintEl.textContent = '';
  if (!r || !r.signatures.length) { return; }
  const sig = document.createElement('span');
  sig.className = 'hint-sig';
  sig.textContent = r.signatures[0] + (r.signatures.length > 1 ? `  (+${r.signatures.length - 1} more)` : '');
  hintEl.append(sig);
  if (r.doc) {
    const d = document.createElement('span');
    d.className = 'hint-doc';
    const first = /^.*?[.!?](?=\s|$)/.exec(r.doc)?.[0] ?? r.doc;
    d.textContent = '  ' + (first.length > 160 ? first.slice(0, 157) + '…' : first);
    hintEl.append(d);
  }
}

// ---- signature box (like the editor's parameter hints): "ⓘ plot(Y,LineSpec,options)  1 of 10 ▾" ----
let sigHelp: SignatureHelp | undefined;
let sigForm = 0;
let sigName = '';
let sigAnchor = 0;
/** Esc closes the box until the cursor leaves the call. */
let sigDismissed = false;
let sigDismissedKey = "";
/** The call the box is showing (name and where its "(" is). */
let sigCallKey = "";
function showSignature(help: SignatureHelp, name: string, anchor: number): void {
  if (name !== sigName) { sigForm = 0; }
  sigName = name;
  sigAnchor = Math.max(0, anchor);
  sigHelp = help;
  sigForm = Math.min(sigForm, help.forms.length - 1);
  renderSignature();
}
/** 'leave': the cursor left the call (forget it); 'dismiss': Esc; 'quiet': just hide (no signature data). */
function hideSignature(how: 'leave' | 'dismiss' | 'quiet' = 'leave'): void {
  if (how === 'dismiss') { sigDismissed = true; sigDismissedKey = sigCallKey; } else if (how === 'leave') { sigDismissed = false; sigName = ''; }
  sigHelp = undefined;
  sigEl.hidden = true;
  sigEl.textContent = '';
}
function flipSignature(step: number): boolean {
  if (!sigHelp || sigEl.hidden || sigHelp.forms.length < 2) { return false; }
  sigForm = (sigForm + step + sigHelp.forms.length) % sigHelp.forms.length;
  renderSignature();
  return true;
}
function renderSignature(): void {
  if (!sigHelp) { return; }
  const f = sigHelp.forms[sigForm];
  sigEl.textContent = '';
  const head = document.createElement('div');
  head.className = 'sig-head';
  const icon = document.createElement('span');
  icon.className = 'sig-icon';
  icon.textContent = 'i';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'sig-label';
  label.append(`${f.functionName}(`);
  f.params.forEach((p, i) => {
    if (i) { label.append(','); }
    const s = document.createElement('span');
    s.textContent = p.name;
    if (i === f.active) { s.className = 'active'; }
    label.append(s);
  });
  label.append(')');
  head.append(icon, label);
  if (sigHelp.forms.length > 1) {
    const count = document.createElement('button');
    count.className = 'sig-count';
    count.title = 'Other forms (Alt+Up / Alt+Down)';
    count.textContent = `${sigForm + 1} of ${sigHelp.forms.length} ▾`;
    count.addEventListener('mousedown', e => { e.preventDefault(); flipSignature(1); });
    head.append(count);
  }
  sigEl.append(head);
  const p = f.params[f.active];
  if (p && (p.purpose || p.valueSummary)) {
    const doc = document.createElement('div');
    doc.className = 'sig-doc';
    if (p.purpose) { const d = document.createElement('div'); d.className = 'sig-purpose'; d.textContent = p.purpose; doc.append(d); }
    if (p.valueSummary) { const d = document.createElement('div'); d.className = 'sig-values'; d.textContent = p.valueSummary; doc.append(d); }
    sigEl.append(doc);
  }
  // The function's documentation: a link under the box, and the ⓘ opens it too (from its help, fetched once).
  const name = f.functionName;
  void fetchHelp(name).then(r => {
    if (!r?.docUrl || sigEl.hidden || sigHelp?.forms[sigForm]?.functionName !== name || sigEl.querySelector('.sig-docurl')) { return; }
    icon.classList.add('clickable');
    icon.title = 'Documentation';
    icon.addEventListener('mousedown', e => { e.preventDefault(); openDocFor(r); });
    sigEl.append(docLinkEl(r, 'link sig-docurl'));
    placeSignature();
  });
  placeSignature();
}

/** Float the box just above the input line, starting at the function name (kept inside the panel). */
function placeSignature(): void {
  sigEl.hidden = false;
  const c = editor.coordsAtPos(Math.min(sigAnchor, editor.state.doc.length));
  const inputTop = (document.getElementById('inputRow') ?? editor.dom).getBoundingClientRect().top;
  const width = sigEl.offsetWidth;
  const left = Math.max(4, Math.min((c?.left ?? 40) - 26, window.innerWidth - width - 8));
  sigEl.style.left = `${left}px`;
  sigEl.style.top = `${Math.max(4, Math.min(c?.top ?? inputTop, inputTop) - sigEl.offsetHeight - 4)}px`;
}

// ---------------------------------------------------------------------------------------------------------
// Modes

function setMode(m: InputMode, prompt?: string): void {
  const wasRunning = mode === 'busy' || mode === 'input' || mode === 'pause';
  mode = m;
  inputPrompt = prompt;
  if (m === 'ready' || m === 'debug' || m === 'exited') { finishBlock(); }
  promptEl.textContent = m === 'debug' ? 'K>>' : m === 'input' ? (prompt?.trim() ? prompt.trim() : '?') : m === 'pause' ? '' : '>>';
  promptEl.className = `mode-${m}`;
  document.body.dataset.mode = m;
  stopEl.hidden = !(m === 'busy' || m === 'input' || m === 'pause');
  const placeholderText = m === 'busy' ? 'Running… (Enter queues the next command, Stop or Ctrl+C aborts)'
    : m === 'input' ? 'MATLAB is waiting for input: type a value and press Enter'
      : m === 'pause' ? 'Paused: press Enter to continue'
        : m === 'exited' ? 'Not connected to MATLAB: run shareMATLABSession() in the MATLAB terminal, then type a command here'
          : m === 'debug' ? 'Stopped in the debugger: dbstep, dbcont, dbquit, or any command'
            : 'Type a MATLAB command';
  editor.dispatch({ effects: placeholderSlot.reconfigure(placeholder(placeholderText)) });
  if (m === 'input' || m === 'pause' || (wasRunning && m !== 'busy')) {
    if (document.hasFocus()) { editor.focus(); }
  }
  if (!canQuery()) { closeCompletion(editor); hintEl.textContent = ''; hideSignature(); }
  if (m === 'input' || m === 'pause') { closeHistoryPopup(); }   // the line now answers input(): no commands
}

stopEl.addEventListener('click', () => { stop(); editor.focus(); });

// ---------------------------------------------------------------------------------------------------------
// Messages from the extension

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'echo': echo(m.text, m.prompt); break;
    case 'output': output(m.text, m.stream); break;
    case 'info': info(m.text); break;
    case 'echoInput': stdinEcho(m.text, m.prompt); break;
    case 'queued': showQueued(m.id, m.text, m.prompt); break;
    case 'unqueued': unqueue(m.id); break;
    case 'mode': setMode(m.mode, m.prompt); break;
    case 'clear': clearOutput(); break;
    case 'history': history = [...m.entries]; break;
    case 'settings': settings = m.settings; break;
    case 'sendDropBytes': sendDropBytes(m.id); break;
    case 'forgetDrop': droppedFiles.delete(m.id); break;
    case 'focus': editor.focus(); break;
    case 'completions': case 'help': case 'signature': case 'pathCompletions': {
      const v = m.type === 'completions' ? m.items : m.result;
      waiting.get(m.id)?.(v);
      waiting.delete(m.id);
      break;
    }
    case 'test': if (testHooks) { void runTest(m.id, m.action); } break;
  }
});

// ---------------------------------------------------------------------------------------------------------
// Test hooks (integration tests only)

async function runTest(id: number, a: TestAction): Promise<void> {
  let result: unknown = true;
  switch (a.kind) {
    case 'snapshot': result = snapshot(); break;
    case 'type': {
      const end = editor.state.doc.length;
      editor.dispatch({ changes: { from: end, insert: a.text }, selection: { anchor: end + a.text.length }, userEvent: 'input.type' });
      break;
    }
    case 'key': {
      const v = editor;
      const fns: Record<string, () => boolean> = {
        'Enter': () => (completionStatus(v.state) === 'active' ? acceptCompletion(v) : submit(v)),
        'Shift-Enter': () => insertNewlineAndIndent(v),
        'ArrowUp': () => historyUp(v),
        'ArrowDown': () => historyMove(v, 1),
        'Escape': () => escapeKey(v),
        'Shift-ArrowUp': () => false,
        'ArrowRight': () => false,
        'Alt-ArrowDown': () => flipSignature(1),
        'Tab': () => (completionStatus(v.state) === 'active' ? acceptCompletion(v) : startCompletion(v)),
        'Ctrl-Space': () => startCompletion(v),
      };
      // The Command History pop-up takes its keys first, as its Prec.highest keymap does for real keys.
      result = (popOpen() && popupKeys[a.key] ? popupKeys[a.key](v) : fns[a.key]?.()) ?? false;
      break;
    }
    case 'clickLink': {
      const links = outputEl.querySelectorAll('a.link');
      (links[a.index] as HTMLElement | undefined)?.click();
      result = !!links[a.index];
      break;
    }
    case 'toggleCollapse': {
      const btns = outputEl.querySelectorAll('button.toggle');
      (btns[a.index] as HTMLElement | undefined)?.click();
      result = !!btns[a.index];
      break;
    }
    case 'hoverShow': {   // move a synthetic mouse over the word so CodeMirror opens its hover tooltip
      const i = editor.state.doc.toString().indexOf(a.word);
      const c = i >= 0 ? editor.coordsAtPos(i + 1) : null;
      if (c) {
        const ev = { clientX: c.left + 3, clientY: (c.top + c.bottom) / 2, bubbles: true };
        editor.contentDOM.dispatchEvent(new MouseEvent('mousemove', ev));
        setTimeout(() => editor.contentDOM.dispatchEvent(new MouseEvent('mousemove', ev)), 50);
      }
      result = !!c;
      break;
    }
    case 'drop': {   // a synthetic drop with the data VS Code's Explorer gives
      const dt = new DataTransfer();
      dt.setData(a.type, a.data);
      for (const type of ['dragover', 'drop']) { document.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true })); }
      result = true;
      break;
    }
    case 'dropFile': {   // like Windows Explorer: a File (no path) over the input line; VS Code's host listens on window
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(a.base64), c => c.charCodeAt(0))], a.name, a.lastModified ? { lastModified: a.lastModified } : undefined));
      let reachedWindow = 0;
      const count = () => { reachedWindow++; };
      const types = ['dragenter', 'dragover', 'drop'];
      for (const type of types) { window.addEventListener(type, count); }
      const before = editor.state.doc.toString();
      for (const type of types) { editor.contentDOM.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true })); }
      for (const type of types) { window.removeEventListener(type, count); }
      await new Promise(r => setTimeout(r, 100));
      result = { reachedWindow, inputChanged: editor.state.doc.toString() !== before };
      break;
    }
    case 'cancelQueued': {
      const btn = queueEl.querySelectorAll<HTMLElement>('button.queued-cancel')[a.index];
      result = !!btn;
      btn?.click();
      break;
    }
    case 'clickStop':
      result = !stopEl.hidden;
      stopEl.click();
      break;
    case 'hover': {
      const r = await fetchHelp(a.word);
      result = r ? helpDom(r).textContent : null;
      break;
    }
  }
  post({ type: 'testResult', id, result });
}

function snapshot(): Snapshot {
  const links = [...outputEl.querySelectorAll<HTMLAnchorElement>('a.link')].map(a => ({
    text: a.textContent ?? '', file: a.dataset.file, func: a.dataset.func, line: a.dataset.line ? +a.dataset.line : undefined,
  }));
  const classes = new Set<string>();
  editor.contentDOM.querySelectorAll('.cm-line span').forEach(s => s.classList.forEach(c => classes.add(c)));
  return {
    text: outputEl.innerText,
    errorText: [...outputEl.querySelectorAll('.err')].map(e => e.textContent).join(''),
    mode,
    prompt: promptEl.textContent ?? '',
    input: editor.state.doc.toString(),
    links,
    collapsed: outputEl.querySelectorAll('.block.collapsed').length,
    completions: currentCompletions(editor.state).map(c => c.label),
    tooltip: hintEl.textContent ?? '',
    signature: sigEl.hidden ? '' : sigEl.textContent ?? '',
    signatureActive: sigEl.hidden ? '' : sigEl.querySelector('.sig-label .active')?.textContent ?? '',
    stopVisible: !stopEl.hidden,
    queued: [...queueEl.querySelectorAll('.queued .cmd-code')].map(e => e.textContent ?? ''),
    historyPopup: popRows.map(r => (r.count > 1 ? `${r.count}x ` : '') + r.text),
    historySelected: popOpen() ? popSelection() : [],
    highlighted: [...classes],
  };
}

void inputPrompt;
post({ type: 'ready' });
editor.focus();
