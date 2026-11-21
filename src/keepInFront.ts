// Keep the Command Window in front when MATLAB stops at a breakpoint (the user's request).
//
// [code, MATLAB extension 1.3.16, out/debug/MatlabDebugger.js] When MATLAB enters the debugger, the official extension
// starts a VS Code debug session of type 'matlab' and, in onDidStartDebugSession, calls
// TerminalService.openTerminalOrBringToFront(): it shows (or creates) its MATLAB terminal and takes the focus, and
// shows it again once a newly created terminal opens. VS Code may also open the Debug Console on a session's start
// (debug.internalConsoleOptions). There is no setting for that, so right after a 'matlab' debug session starts we
// bring the Command Window back, where K>> is.
import * as vscode from 'vscode';
import { SessionManager } from './session';

/** How long after the debug session starts a MATLAB terminal that opens or becomes active is answered. */
const WINDOW_MS = 3000;

export interface KeepInFront extends vscode.Disposable {
  /** What happens when the official extension's 'matlab' debug session starts (the integration test calls it). */
  matlabDebugStarted(): void;
}

export function keepCommandWindowInFront(session: SessionManager): KeepInFront {
  let until = 0;
  let timer: NodeJS.Timeout | undefined;
  const active = () => Date.now() < until
    && session.state !== 'exited'
    && vscode.workspace.getConfiguration('matlabCommandWindow').get<boolean>('runInCommandWindow', true);
  // Debounced: the terminal's show() calls and VS Code's own debug views settle first.
  const bringBack = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (active()) { session.reveal(false); } }, 150);
  };
  const isMatlabTerminal = (t: vscode.Terminal | undefined) => t?.creationOptions.name === 'MATLAB';
  const matlabDebugStarted = () => {
    if (session.state === 'exited') { return; }   // not using the Command Window
    until = Date.now() + WINDOW_MS;
    bringBack();
    setTimeout(bringBack, 700);   // a terminal created just now is shown again when it opens
  };
  const subs = [
    vscode.debug.onDidStartDebugSession(s => { if (s.type === 'matlab') { matlabDebugStarted(); } }),
    vscode.window.onDidOpenTerminal(t => { if (isMatlabTerminal(t) && active()) { bringBack(); } }),
    vscode.window.onDidChangeActiveTerminal(t => { if (isMatlabTerminal(t) && active()) { bringBack(); } }),
  ];
  return { matlabDebugStarted, dispose: () => { clearTimeout(timer); subs.forEach(d => d.dispose()); } };
}
