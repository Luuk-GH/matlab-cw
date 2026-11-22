// Keep the Command Window in front when the official MATLAB extension brings its MATLAB terminal forward for
// something that happens in our window (the user's request): a breakpoint, or input() asked by a command of ours.
//
// [code, MATLAB extension 1.3.16]
// - Breakpoints (out/debug/MatlabDebugger.js): when MATLAB enters the debugger, the official extension starts a VS Code
//   debug session of type 'matlab' and, in onDidStartDebugSession, calls TerminalService.openTerminalOrBringToFront():
//   it shows (or creates) its MATLAB terminal and takes the focus, and shows it again once a newly created terminal
//   opens. VS Code may also open the Debug Console on a session's start (debug.internalConsoleOptions).
// - input() (out/commandwindow/CommandWindow.js, _handlePromptChange): on the INPUT prompt state, which every client
//   receives, its terminal runs matlab.openCommandWindow, i.e. the same openTerminalOrBringToFront(). Both windows react
//   to the same MATLAB event through different language-server processes, so without this whichever came last won
//   (seen by the user: about half the time the terminal).
// There is no setting for either, so we bring the Command Window back after the terminal's move.
import * as vscode from 'vscode';
import { SessionManager } from './session';

/** How long after the trigger a MATLAB terminal that opens or becomes active is answered. */
const WINDOW_MS = 3000;
/** When to bring the Command Window back after the trigger (the terminal's move can come late or twice). */
const RETRIES_MS = [0, 700, 1500];

export interface KeepInFront extends vscode.Disposable {
  /** The official extension's 'matlab' debug session started (the integration test calls it). */
  matlabDebugStarted(): void;
  /** A command of ours asks for input() or waits in pause. */
  inputRequested(): void;
}

export function keepCommandWindowInFront(session: SessionManager): KeepInFront {
  let until = 0;
  let timer: NodeJS.Timeout | undefined;
  const timers = new Set<NodeJS.Timeout>();
  const active = () => Date.now() < until
    && session.state !== 'exited'
    && vscode.workspace.getConfiguration('matlabCommandWindow').get<boolean>('runInCommandWindow', true);
  // Debounced: the terminal's show() calls and VS Code's own debug views settle first. Takes the focus: K>> and
  // input() both wait for the user to type in the Command Window.
  const bringBack = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (active()) { session.reveal(false); } }, 150);
  };
  const isMatlabTerminal = (t: vscode.Terminal | undefined) => t?.creationOptions.name === 'MATLAB';
  const hold = () => {
    if (session.state === 'exited') { return; }   // not using the Command Window
    until = Date.now() + WINDOW_MS;
    for (const ms of RETRIES_MS) {
      const t = setTimeout(() => { timers.delete(t); bringBack(); }, ms);
      timers.add(t);
    }
  };
  const subs = [
    vscode.debug.onDidStartDebugSession(s => { if (s.type === 'matlab') { hold(); } }),
    vscode.window.onDidOpenTerminal(t => { if (isMatlabTerminal(t) && active()) { bringBack(); } }),
    vscode.window.onDidChangeActiveTerminal(t => { if (isMatlabTerminal(t) && active()) { bringBack(); } }),
    session.onDidRequestInput(hold),
  ];
  return {
    matlabDebugStarted: hold,
    inputRequested: hold,
    dispose: () => { clearTimeout(timer); timers.forEach(clearTimeout); subs.forEach(d => d.dispose()); },
  };
}
