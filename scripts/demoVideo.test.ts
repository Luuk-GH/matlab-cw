// Demo video: drives the Command Window against the real shared MATLAB at a human pace while
// scripts/run-demo-video.mjs records the window. Writes timeline.json (scene captions with timestamps) for the
// composer (scripts/video/compose.html). Run: npm run demo:video
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
interface Snap { text: string; mode: string; completions: string[]; signature: string; tooltip: string; links: { func?: string; line?: number }[]; historyPopup: string[]; queued: string[] }

export async function run(): Promise<void> {
  const out = process.env.MCW_DEMO_DIR!;
  const timeline: { t: number; caption: string }[] = [];
  const log: string[] = [];
  const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'matlab-command-window')!;
  const api = (await ext.activate()) as CommandWindowApi;
  const cw = api.commandWindow;
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const mq = (p: string) => p.replace(/'/g, "''");
  // Undefined while the webview (re)loads, e.g. right after the panel is maximized.
  const empty: Snap = { text: '', mode: '', completions: [], signature: '', tooltip: '', links: [], historyPopup: [], queued: [] };
  const matFile = path.join(ws, 'measurements.mat');   // made off camera for the file-name completion, deleted after
  const snap = async () => ((await cw.test({ kind: 'snapshot' })) as Snap | undefined) ?? empty;
  const idle = () => waitFor(async () => ['ready', 'debug'].includes((await snap()).mode), 20000);
  const typeSlow = async (text: string) => {
    for (const ch of text) { await cw.test({ kind: 'type', text: ch }); await sleep(ch === ' ' ? 70 : 45); }
  };
  // Enter with the completion pop-up open accepts the completion: close the pop-up first (Esc closes only it).
  const enter = async () => {
    if ((await snap()).completions.length) { await cw.test({ kind: 'key', key: 'Escape' }); await sleep(150); }
    await cw.test({ kind: 'key', key: 'Enter' });
  };
  const command = async (text: string, pause = 900) => { await typeSlow(text); await sleep(250); await enter(); await idle(); await sleep(pause); };
  const esc = async (n = 3) => { for (let i = 0; i < n; i++) { await cw.test({ kind: 'key', key: 'Escape' }); } };
  const scene = (caption: string) => { timeline.push({ t: Date.now(), caption }); log.push(caption); };
  let maximized = false;   // the panel starts at its normal size
  const panelMax = async (on: boolean) => {
    if (maximized !== on) { await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel'); maximized = on; }
    await sleep(300);
  };
  let startFolder: string | undefined;
  let breakpointsSaved = false;
  // MCW_DEMO_ONLY=errors,f5,hover records just those scenes (e.g. to redo a few highlight GIFs).
  const only = process.env.MCW_DEMO_ONLY ? new Set(process.env.MCW_DEMO_ONLY.split(',')) : undefined;
  const want = (key: string) => !only || only.has(key);
  let ed = vscode.window.activeTextEditor!;
  try {
    // Set up off camera.
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
    const demoDoc = await vscode.workspace.openTextDocument(path.join(ws, 'signal_demo.m'));
    await vscode.window.showTextDocument(demoDoc);
    await vscode.commands.executeCommand('matlabCommandWindow.show');
    await waitFor(() => api.session.state === 'idle', 30000);
    startFolder = await waitFor(() => api.session.queryText('pwd'), 20000);
    await api.session.execute(`cd('${mq(ws)}'); clear A results x t peakValue thr n`);
    await api.session.execute("mcwSamples = rand(1, 100); save('measurements.mat', 'mcwSamples'); clear mcwSamples");
    // Warm up off camera: a freshly started MATLAB takes longer than the 3 s the Command Window waits for its first
    // completion and signature data. One call each, waiting as long as it takes (retrying would only queue more work
    // in MATLAB).
    for (const [fn, args] of [
      ['matlabls.internal.getCompletions', ["S = load('me", '', 12]],
      ['matlabls.internal.getCompletions', ['plot(', '', 5]],
      ['help', ['linspace']],
    ] as [string, unknown[]][]) {
      const t0 = Date.now();
      const r = await api.session.queryText(fn, args, true, 90000);
      log.push(`warm-up ${fn}: ${Date.now() - t0} ms`);
      // Completion and signature help need the MATLAB extension's matlabls package on MATLAB's path (it adds it when
      // it starts MATLAB): without it the scenes fail, so do not record at all.
      if (r === undefined && fn.startsWith('matlabls.')) {
        throw new Error(`${fn} is not available in this MATLAB: start MATLAB from VS Code (the MATLAB extension), or `
          + 'add <MATLAB extension>/server/matlab to its path');
      }
    }
    // The user's own breakpoints (e.g. one in signal_demo.m) would stop the demo at K>>: keep them aside, put back after.
    await api.session.execute('mcwDemoBreakpoints = dbstatus(\'-completenames\'); dbclear all');
    breakpointsSaved = true;
    await cw.test({ kind: 'snapshot' });
    await vscode.commands.executeCommand('matlabCommandWindow.commandWindow.clear').then(undefined, () => undefined);
    await panelMax(true);
    await vscode.commands.executeCommand('notifications.clearAll');
    await idle();
    await sleep(800);
    fs.writeFileSync(path.join(out, 'start.txt'), String(Date.now()));   // the recorder starts now
    await sleep(1500);

    if (want('intro')) {
      scene('A real Command Window, attached to the MATLAB the MATLAB extension runs');
      await command('A = magic(4)');
      await command('total = sum(A(:))', 1200);

    }
    if (want('errors')) {
      scene('Errors in red, with links straight to the code');
      await command('scale_to_sum([1 2 3])', 1200);
      const s = await snap();
      const linkIdx = s.links.findIndex(l => l.func === 'scale_to_sum' && l.line === 4);
      await panelMax(false);
      if (linkIdx >= 0) { await cw.test({ kind: 'clickLink', index: linkIdx }); }
      await sleep(2200);

    }
    if (want('history')) {
      scene('↑ opens the Command History: Shift+↑ selects several, Enter runs them');
      await vscode.commands.executeCommand('matlabCommandWindow.show');
      await panelMax(true);
      await cw.test({ kind: 'key', key: 'ArrowUp' });
      await waitFor(async () => (await snap()).historyPopup.length > 0, 5000);
      await sleep(1300);
      await cw.test({ kind: 'key', key: 'ArrowUp' });
      await sleep(700);
      await cw.test({ kind: 'key', key: 'Shift-ArrowUp' });
      await sleep(1600);
      await cw.test({ kind: 'key', key: 'Escape' });
      await sleep(400);

    }
    if (want('paths')) {
      scene('File and folder names complete, from MATLAB, wherever a function takes a path');
      await typeSlow("S = load('me");
      await cw.test({ kind: 'key', key: 'Tab' });
      await waitFor(async () => (await snap()).completions.length > 0, 8000);
      await sleep(1600);
      await cw.test({ kind: 'key', key: 'Enter' });   // accepts measurements.mat
      await sleep(500);
      await typeSlow(');');
      await sleep(300);
      await enter();
      await idle();
      await sleep(500);
      await command('size(S.mcwSamples)', 1300);

    }
    if (want('completion')) {
      scene('Completion from MATLAB itself');
      await command("results = struct('alpha', 1, 'beta', 2, 'gamma', 3);", 500);
      await typeSlow('results.');
      await cw.test({ kind: 'key', key: 'Ctrl-Space' });
      await waitFor(async () => (await snap()).completions.includes('alpha'), 8000);
      await sleep(2200);
      await esc(3);

    }
    if (want('signature')) {
      scene('Signature help, like in the editor');
      await typeSlow('linspace(0, ');
      await waitFor(async () => /linspace\(/.test((await snap()).signature), 8000);
      await sleep(2500);
      await esc(3);
      await typeSlow('plot(');
      await waitFor(async () => /plot\(/.test((await snap()).signature), 8000);
      await sleep(1400);
      await cw.test({ kind: 'key', key: 'Alt-ArrowDown' });
      await sleep(1600);
      await esc(3);

    }
    if (want('f5')) {
      scene('F5 runs the file in the Command Window; input() is answered right there');
      await panelMax(false);
      ed = await vscode.window.showTextDocument(demoDoc);
      ed.selection = new vscode.Selection(0, 0, 0, 0);
      await sleep(900);
      void vscode.commands.executeCommand('matlabCommandWindow.runFile');
      await waitFor(async () => (await snap()).mode === 'input', 15000);
      await sleep(900);
      await typeSlow('0.8');
      await sleep(400);
      await enter();
      await idle();
      await sleep(1800);

    }
    if (want('hover')) {
      scene('Hover help in .m files, from MATLAB\'s own help');
      ed = await vscode.window.showTextDocument(demoDoc);
      ed.selection = new vscode.Selection(1, 6, 1, 6);   // in "linspace"
      await sleep(500);
      await vscode.commands.executeCommand('editor.action.showHover');
      await sleep(3200);
      await vscode.commands.executeCommand('closeParameterHints').then(undefined, () => undefined);

    }
    if (want('shiftenter')) {
      scene('Shift+Enter runs the selection; it joins the Command History');
      ed.selection = new vscode.Selection(7, 0, 7, 18);   // peakValue = max(x)
      await sleep(900);
      await vscode.commands.executeCommand('matlabCommandWindow.runSelection');
      await idle();
      await sleep(1200);
      await cw.test({ kind: 'key', key: 'ArrowUp' });
      await sleep(1800);
      await cw.test({ kind: 'key', key: 'Escape' });
      await vscode.window.showTextDocument(demoDoc);
      await sleep(400);

    }
    if (want('section')) {
      scene('Ctrl+Enter runs the current section');
      await vscode.window.showTextDocument(demoDoc);
      ed.selection = new vscode.Selection(5, 0, 5, 0);
      ed.revealRange(new vscode.Range(4, 0, 6, 0));
      await sleep(1000);
      await vscode.commands.executeCommand('matlabCommandWindow.runSection');
      await idle();
      await sleep(2000);

    }
    if (want('breakpoints')) {
      scene('Breakpoints stop at K>>, right in the Command Window');
      await vscode.commands.executeCommand('matlabCommandWindow.show');
      await panelMax(true);
      await command('dbstop in scale_to_sum at 4', 300);
      await typeSlow('scale_to_sum([2 3 5])');
      await enter();
      await waitFor(async () => (await snap()).mode === 'debug', 15000);
      await sleep(900);
      await command('total', 900);
      await command('dbquit', 300);
      await api.session.execute('dbclear in scale_to_sum');
      await sleep(600);

    }
    if (want('long')) {
      scene('Long runs: output streams in, the next commands wait in line, Stop interrupts');
      await typeSlow('count_forever');
      await enter();
      await waitFor(async () => (await snap()).mode === 'busy', 8000);
      await sleep(1500);
      await typeSlow('disp(A)');
      await enter();
      await waitFor(async () => (await snap()).queued.length > 0, 3000);
      await sleep(2200);
      await cw.test({ kind: 'clickStop' });
      await idle();
      await sleep(1800);
    }
    scene('end');
  } catch (e) {
    log.push(`error: ${(e as Error).stack ?? e}`);
  } finally {
    fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
    // Leave the user's MATLAB as found.
    await Promise.race([api.session.execute("if ~isempty(dbstack), dbquit('all'); end"), sleep(5000)]);
    await Promise.race([api.session.execute(`dbclear in scale_to_sum; cd('${mq(startFolder ?? '.')}'); clear A S total results x t peakValue thr n ans`), sleep(10000)]);
    if (breakpointsSaved) {
      await Promise.race([api.session.execute('dbclear all; dbstop(mcwDemoBreakpoints); clear mcwDemoBreakpoints'), sleep(10000)]);
    }
    try { fs.unlinkSync(matFile); } catch { /* gone */ }
    fs.writeFileSync(path.join(out, 'done.txt'), log.join('\n'));
  }
}
