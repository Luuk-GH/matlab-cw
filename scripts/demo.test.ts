// Screenshot demo: drives the Command Window against the real shared MATLAB in an Extension Development Host and
// pauses at each stage until scripts/run-demo.mjs has captured the screen. Run: npm run demo:screenshots
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandWindowApi } from '../src/extension';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 15000): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) { return v; }
    if (Date.now() > end) { return undefined; }
    await sleep(100);
  }
}

export async function run(): Promise<void> {
  const dirOut = process.env.MCW_DEMO_DIR!;
  const log: string[] = [];
  const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'matlab-command-window-community')!;
  const api = (await ext.activate()) as CommandWindowApi;
  const cw = api.commandWindow;
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const mq = (p: string) => p.replace(/'/g, "''");
  const snap = async () => (await cw.test({ kind: 'snapshot' })) as { text: string; mode: string; completions: string[]; tooltip: string };
  const typeLine = async (text: string) => { await cw.test({ kind: 'type', text }); await cw.test({ kind: 'key', key: 'Enter' }); };
  const idle = () => waitFor(async () => (await snap()).mode === 'ready', 20000);
  /** Ask the runner for a screenshot and wait until it is taken. */
  const shot = async (n: number, name: string) => {
    await vscode.commands.executeCommand('notifications.clearAll');
    await sleep(1200);   // let rendering settle
    fs.writeFileSync(path.join(dirOut, `stage-${n}.txt`), name);
    await waitFor(() => fs.existsSync(path.join(dirOut, `shot-${n}.txt`)), 30000);
    log.push(`stage ${n} ${name}`);
  };
  let startFolder: string | undefined;
  try {
    const demo = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(ws, 'error_demo.m')));
    await vscode.commands.executeCommand('matlabCommandWindow.show');
    await waitFor(() => api.session.state === 'idle', 30000);
    startFolder = await waitFor(() => api.session.queryText('pwd'), 20000);
    await idle();

    // 1. Output, errors, warnings
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await typeLine(`cd('${mq(ws)}')`); await idle();
    await typeLine('x = magic(4)'); await idle();
    await typeLine('y = q + 1'); await idle();
    await typeLine("warning('Low on coffee')"); await idle();
    await typeLine("fprintf('Mean of x: %g\\n', mean(x(:)))"); await idle();
    await shot(1, 'output-errors-warnings');

    // 2. F5 in the editor runs the file in the Command Window (editor keeps focus)
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await vscode.window.showTextDocument(demo.document);
    await vscode.commands.executeCommand('matlabCommandWindow.runFile');
    await waitFor(async () => /Error in error_demo \(line 3\)/.test((await snap()).text), 15000);
    await idle();
    await shot(2, 'run-file-from-editor');

    // 3. Completion pop-up
    await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    await typeLine("results = struct('alpha', 1, 'beta', 2, 'gamma', 3);"); await idle();
    await cw.test({ kind: 'type', text: 'results.' });
    await cw.test({ kind: 'key', key: 'Ctrl-Space' });
    await waitFor(async () => (await snap()).completions.includes('alpha'), 8000);
    await shot(3, 'completion');

    // 4. Help tooltip and usage hint
    await cw.test({ kind: 'key', key: 'Escape' }); await cw.test({ kind: 'key', key: 'Escape' });
    await cw.test({ kind: 'type', text: 'z = zeros' });
    await cw.test({ kind: 'hoverShow', word: 'zeros' });
    await sleep(2500);
    await shot(4, 'help-tooltip');

    // 5. input() prompt in the input line
    await cw.test({ kind: 'key', key: 'Escape' }); await cw.test({ kind: 'key', key: 'Escape' });
    await typeLine(`run('ask_input.m')`);
    await waitFor(async () => (await snap()).mode === 'input', 10000);
    await cw.test({ kind: 'type', text: '42' });
    await shot(5, 'input-prompt');
    await cw.test({ kind: 'key', key: 'Enter' });
    await idle();
  } catch (e) {
    log.push(`error: ${(e as Error).stack ?? e}`);
  } finally {
    // Leave the user's MATLAB as found.
    await Promise.race([api.session.execute(`cd('${mq(startFolder ?? '.')}'); clear x y z results ans n`), sleep(10000)]);
    fs.writeFileSync(path.join(dirOut, 'done.txt'), log.join('\n'));
  }
}
