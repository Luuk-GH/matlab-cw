import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ConsoleView } from '../consoleView';
import { OFFICIAL_EXTENSION_ID } from '../locator';
import { CommandWindowReveal, SessionManager } from '../session';
import { openDoc } from '../docLink';
import { loadMatBytes, loadMatFiles } from '../loadMat';
import { FromWebview, HelpResult, InputMode, TestAction, ToWebview, WebviewSettings } from './protocol';

const HISTORY_KEY = 'matlabCommandWindow.commandWindow.history';
/** The MATLAB extension's Workspace view and its own container ([code] MathWorks.language-matlab 1.3.16 package.json). */
const WORKSPACE_VIEW = 'workspaceBrowserSidebarView';
const WORKSPACE_HOME = 'workbench.view.extension.matlabSidebar';
const PANEL_CONTAINER = 'workbench.view.extension.matlabCommandWindowPanel';   // VS Code's id for our container
/** Set once the Workspace view was put beside the Command Window (it is not moved again: the user may move it away). */
const WORKSPACE_PLACED_KEY = 'matlabCommandWindow.workspacePlaced';
const HISTORY_MAX = 1000;
/** Rendered messages kept for replay when the webview is (re)created: about this many characters. */
const REPLAY_CHARS = 2_000_000;

/**
 * The HTML Command Window: a webview in the bottom panel that shows the shared session (same process and
 * workspace as the official MATLAB extension). It is the session's console view; everything it
 * shows is also kept here, so a webview that is created later (or re-created) can replay it.
 */
export class CommandWindowProvider implements vscode.WebviewViewProvider, ConsoleView, CommandWindowReveal {
  static readonly viewId = 'matlabCommandWindow.commandWindow';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private replay: ToWebview[] = [];
  private replayChars = 0;
  private mode: InputMode = 'exited';
  private inputPrompt: string | undefined;
  private basePrompt = '>>';   // 'K>>' while stopped in the debugger
  private history: string[];
  private testId = 0;
  private readonly testWaiters = new Map<number, (r: unknown) => void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly session: SessionManager,
              private readonly log: vscode.LogOutputChannel) {
    this.history = context.globalState.get<string[]>(HISTORY_KEY, []);
    this.disposables.push(session.addView(this));
    session.registerCommandWindow(this);
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('matlabCommandWindow')) { this.post({ type: 'settings', settings: webviewSettings() }); }
      if (e.affectsConfiguration('matlabCommandWindow.workspaceBesideCommandWindow')) {
        const on = vscode.workspace.getConfiguration('matlabCommandWindow').get<boolean>('workspaceBesideCommandWindow', true);
        void this.context.globalState.update(WORKSPACE_PLACED_KEY, on);
        this.moveWorkspace(on ? PANEL_CONTAINER : WORKSPACE_HOME);
      }
    }));
  }

  dispose(): void { this.disposables.forEach(d => d.dispose()); }

  // ---------- vscode.WebviewViewProvider ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const root = this.context.extensionUri;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(root, 'dist'), vscode.Uri.joinPath(root, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => { void this.onMessage(m); }, undefined, this.disposables);
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.ready = false; } });
    view.onDidChangeVisibility(() => { if (view.visible) { this.post({ type: 'focus' }); this.autoConnect(); } });
    this.autoConnect();
    this.placeWorkspace();
  }

  /**
   * The first time the Command Window opens, put the MATLAB extension's Workspace view beside it in the panel
   * (setting workspaceBesideCommandWindow). VS Code does not let the user drop that view onto the Command Window's
   * container (only into the Terminal's), so we move it with VS Code's vscode.moveViews command. Only once: VS Code
   * remembers where views are, and a user who moves it elsewhere afterwards keeps it there.
   */
  private placeWorkspace(): void {
    if (this.context.globalState.get<boolean>(WORKSPACE_PLACED_KEY)) { return; }
    if (!vscode.workspace.getConfiguration('matlabCommandWindow').get<boolean>('workspaceBesideCommandWindow', true)) { return; }
    if (!vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID)) { return; }
    void this.context.globalState.update(WORKSPACE_PLACED_KEY, true);
    this.moveWorkspace(PANEL_CONTAINER);
  }

  private moveWorkspace(destinationId: string): void {
    void Promise.resolve(vscode.commands.executeCommand('vscode.moveViews', { viewIds: [WORKSPACE_VIEW], destinationId })).then(
      () => this.log.info(`moved the MATLAB Workspace view to ${destinationId}`),
      e => this.log.warn(`could not move the MATLAB Workspace view: ${e}`));
  }

  // ---------- CommandWindowReveal ----------

  isVisible(): boolean { return !!this.view?.visible; }

  /** Opening the Command Window connects to the shared MATLAB (setting matlabCommandWindow.autoConnect). */
  private autoConnect(): void {
    if (!vscode.workspace.getConfiguration('matlabCommandWindow').get<boolean>('autoConnect', true)) { return; }
    if (this.session.state === 'exited') { void this.session.connect(false).catch(() => undefined); }
  }

  reveal(preserveFocus: boolean): void {
    if (this.view) {
      if (!this.view.visible || !preserveFocus) { this.view.show(preserveFocus); }
      if (!preserveFocus) { this.post({ type: 'focus' }); }
      return;
    }
    // Not created yet: opening the view focuses it; give focus back to the editor if asked.
    const editor = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand(`${CommandWindowProvider.viewId}.focus`).then(() => {
      if (preserveFocus && editor) { void vscode.window.showTextDocument(editor.document, editor.viewColumn, false); }
    });
  }

  // ---------- ConsoleView ----------

  echoCommand(display: string): void {
    this.record({ type: 'echo', text: display, prompt: this.basePrompt });
  }

  queueCommand(id: number, display: string): void { this.record({ type: 'queued', id, text: display, prompt: this.basePrompt }); }

  unqueueCommand(id: number): void { this.record({ type: 'unqueued', id }); }

  writeOutput(text: string, stream: 'out' | 'err'): void { this.record({ type: 'output', text, stream }); }

  showPrompt(kind: 'ready' | 'debug'): void {
    this.basePrompt = kind === 'debug' ? 'K>>' : '>>';
    this.setMode(kind);
  }

  setBusy(): void { this.setMode('busy'); }

  requestInput(source: 'input' | 'pause', prompt: string): void { this.setMode(source, prompt); }

  echoInput(text: string, prompt: string): void { this.record({ type: 'echoInput', text, prompt }); }

  info(text: string): void { this.record({ type: 'info', text }); }

  clearScreen(): void { this.clear(); }

  resetInput(): void { this.basePrompt = '>>'; this.setMode('exited'); }

  // ---------- commands ----------

  /** Clear the output area (the session and its workspace are not touched). */
  clear(): void {
    this.replay = [];
    this.replayChars = 0;
    this.post({ type: 'clear' });
  }

  /** Current input mode (for tests). */
  get inputMode(): InputMode { return this.mode; }

  /** Run a test action inside the webview and return its result (integration tests only). */
  async test(action: TestAction, timeoutMs = 5000): Promise<any> {
    if (!this.ready) { return undefined; }
    const id = ++this.testId;
    const result = new Promise(res => this.testWaiters.set(id, res));
    this.post({ type: 'test', id, action });
    return Promise.race([result, new Promise(r => setTimeout(() => r(undefined), timeoutMs))]);
  }

  /** Whether the webview has loaded and replayed. */
  get isReady(): boolean { return this.ready; }

  // ---------- internals ----------

  private setMode(mode: InputMode, prompt?: string): void {
    this.mode = mode;
    this.inputPrompt = prompt;
    this.post({ type: 'mode', mode, prompt });
  }

  private record(msg: ToWebview): void {
    this.replay.push(msg);
    this.replayChars += 'text' in msg ? msg.text.length : 0;
    while (this.replayChars > REPLAY_CHARS && this.replay.length > 1) {
      const old = this.replay.shift()!;
      this.replayChars -= 'text' in old ? old.text.length : 0;
    }
    this.post(msg);
  }

  private post(msg: ToWebview): void {
    if (this.view && this.ready) { void this.view.webview.postMessage(msg); }
  }

  addHistory(line: string): void {
    if (!line.trim()) { return; }   // repeats are kept: the Command History pop-up shows them as "2x"
    this.history.push(line);
    if (this.history.length > HISTORY_MAX) { this.history.splice(0, this.history.length - HISTORY_MAX); }
    void this.context.globalState.update(HISTORY_KEY, this.history);
    this.post({ type: 'history', entries: this.history });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.post({ type: 'settings', settings: webviewSettings() });
          this.post({ type: 'history', entries: this.history });
          for (const r of this.replay) { this.post(r); }
          this.post({ type: 'mode', mode: this.mode, prompt: this.inputPrompt });
          break;
        case 'submit':
          if (this.mode !== 'input' && this.mode !== 'pause') { this.addHistory(m.code); }
          await this.session.submitFromWindow(m.code);
          break;
        case 'stop':
          await this.session.interrupt();
          break;
        case 'dropFiles':
          this.loadDropped(m.uris);
          break;
        case 'dropFileData':
          if (!(await loadMatBytes(this.session, m.name, bytesOf(m.data)))) { dropHint(); }
          break;
        case 'cancelQueued':
          this.session.cancelQueued(m.id);
          break;
        case 'complete': {
          const ok = this.mode === 'ready' || this.mode === 'debug';
          const r = ok ? await this.session.completeNames(m.prefix, m.code, m.offset) : undefined;
          this.post({ type: 'completions', id: m.id, items: r ? r.map(([label, kind]) => ({ label, kind })) : null });
          break;
        }
        case 'signature': {
          const ok = this.mode === 'ready' || this.mode === 'debug';
          this.post({ type: 'signature', id: m.id, result: (ok ? await this.session.signatureFor(m.code, m.offset) : undefined) ?? null });
          break;
        }
        case 'completePaths': {
          const ok = this.mode === 'ready' || this.mode === 'debug';
          this.post({ type: 'pathCompletions', id: m.id, result: (ok ? await this.session.completePaths(m.code, m.offset) : undefined) ?? null });
          break;
        }
        case 'help':
          this.post({ type: 'help', id: m.id, result: await this.help(m.name) });
          break;
        case 'openDoc':   // only MathWorks' documentation (the link in the help tooltip)
          await openDoc(this.session, m.url, m.name);
          break;
        case 'openFile':
          await this.open(vscode.Uri.file(m.file), m.line);
          break;
        case 'openFunction': {
          const file = await this.session.whichFile(m.name.split('>')[0]);
          if (file) { await this.open(vscode.Uri.file(file), m.line); }
          else { void vscode.window.setStatusBarMessage(`MATLAB: no file found for ${m.name} (MATLAB must be idle to look it up)`, 4000); }
          break;
        }
        case 'clear':
          this.clear();
          break;
        case 'testResult':
          this.testWaiters.get(m.id)?.(m.result);
          this.testWaiters.delete(m.id);
          break;
      }
    } catch (err) {
      this.log.error(`Command Window: ${(err as Error).stack ?? err}`);
      if (m.type === 'submit' && !(err as { reported?: boolean }).reported) { void vscode.window.showErrorMessage(`MATLAB Command Window: ${(err as Error).message}`); }
    }
  }

  /** .mat files dropped on the Command Window: load each one, as typed (other files are ignored). */
  private loadDropped(uris: string[]): void {
    // URIs (uri-list, resourceurls) or plain paths (VS Code's codefiles).
    const files = uris.map(u => { try { return /^[a-z][\w+.-]+:\/\//i.test(u) ? vscode.Uri.parse(u, true) : vscode.Uri.file(u); } catch { return undefined; } })
      .filter((u): u is vscode.Uri => !!u);
    if (!loadMatFiles(this.session, files)) { dropHint(); }
  }

  private async help(name: string): Promise<HelpResult | null> {
    if (this.mode !== 'ready' && this.mode !== 'debug') { return null; }
    const info = await this.session.helpFor(name);
    if (!info || (!info.signatures.length && !info.doc)) { return null; }
    const file = info.file;
    return { name, signatures: info.signatures, doc: info.doc, file, docUrl: info.docUrl };
  }

  private async open(uri: vscode.Uri, line?: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = line && line > 0 ? new vscode.Position(Math.min(line - 1, doc.lineCount - 1), 0) : undefined;
    await vscode.window.showTextDocument(doc, {
      preview: false, selection: pos ? new vscode.Range(pos, pos) : undefined,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'commandWindow.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'commandWindow.css'));
    const testHooks = process.env.MCW_IT_RESULT ? 'true' : 'false';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>MATLAB Command Window</title>
</head>
<body data-test-hooks="${testHooks}" data-nonce="${nonce}">
<div id="output" role="log" aria-live="polite" tabindex="-1"></div>
<div id="queue" hidden></div>
<div id="hint" aria-live="polite"></div>
<div id="sigbox" role="tooltip" hidden></div>
<div id="inputRow">
  <span id="prompt">&gt;&gt;</span>
  <div id="editor"></div>
  <button id="stop" title="Stop the running command (Ctrl+C)" hidden><span class="stop-icon"></span>Stop</button>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function webviewSettings(): WebviewSettings {
  const c = vscode.workspace.getConfiguration('matlabCommandWindow');
  return { collapseLongOutput: c.get<boolean>('collapseLongOutput', false), historyPopup: c.get<boolean>('historyPopup', true) };
}

/** Register the Command Window view and its commands. */
export function registerCommandWindow(context: vscode.ExtensionContext, session: SessionManager,
                                      log: vscode.LogOutputChannel): CommandWindowProvider {
  const provider = new CommandWindowProvider(context, session, log);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(CommandWindowProvider.viewId, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('matlabCommandWindow.commandWindow.clear', () => provider.clear()),
    // Explorer: right-click .mat files (several when selected together) -> load them.
    vscode.commands.registerCommand('matlabCommandWindow.loadMatFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const files = uris?.length ? uris : uri ? [uri] : [];
      if (files.length) { session.reveal(true); }
      if (!loadMatFiles(session, files)) { dropHint(); }
    }),
  );
  return provider;
}

function dropHint(): void {
  void vscode.window.setStatusBarMessage('MATLAB Command Window: only .mat files can be loaded this way', 4000);
}

/** The bytes of a dropped file as posted by the webview (a Uint8Array, or its ArrayBuffer). */
function bytesOf(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) { return data; }
  if (data instanceof ArrayBuffer) { return new Uint8Array(data); }
  if (ArrayBuffer.isView(data)) { return new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
  return new Uint8Array(0);
}
