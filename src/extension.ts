import * as vscode from 'vscode';
import { CommandWindowProvider, registerCommandWindow } from './commandWindow/provider';
import { ReportedError, SessionManager } from './session';

let session: SessionManager | undefined;

export interface CommandWindowApi { session: SessionManager; commandWindow: CommandWindowProvider; }

export function activate(context: vscode.ExtensionContext): CommandWindowApi {
  const log = vscode.window.createOutputChannel('MATLAB Command Window', { log: true });
  session = new SessionManager(log);
  const s = session;

  const reg = (id: string, fn: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await fn(); } catch (err) {
        log.error(`${id}: ${(err as Error).stack ?? err}`);
        if (!(err as ReportedError).reported) { void vscode.window.showErrorMessage(`MATLAB Command Window: ${(err as Error).message}`); }
      }
    }));

  reg('matlabCommandWindow.show', () => s.show());
  reg('matlabCommandWindow.connect', () => s.connect(true));
  reg('matlabCommandWindow.disconnect', () => s.disconnect());
  reg('matlabCommandWindow.interrupt', () => s.interrupt());
  reg('matlabCommandWindow.copyShareCommand', async () => {
    await vscode.env.clipboard.writeText('shareMATLABSession()');
    void vscode.window.showInformationMessage('Copied shareMATLABSession() — paste it in the MATLAB terminal of the MATLAB extension.');
  });

  context.subscriptions.push(s, log);
  const commandWindow = registerCommandWindow(context, s, log);
  return { session: s, commandWindow };
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
}
