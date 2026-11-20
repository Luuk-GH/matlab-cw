// End-to-end test inside a real Extension Development Host. The shared MATLAB is FAKE: test/fake/fakeConnector.js
// (started by run-integration.mjs, writes the session file like shareMATLABSession()) plus the fake language server.
// Drives the Command Window webview through its test hooks. Run: npm run test:integration
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Snapshot } from '../src/commandWindow/protocol';
import type { CommandWindowApi } from '../src/extension';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: string[] = [];
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; }
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`;
  results.push(line);
  console.log(line);
}
async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 10000): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) { return v; }
    if (Date.now() > end) { return undefined; }
    await sleep(100);
  }
}

export async function run(): Promise<void> {
  const resultFile = process.env.MCW_IT_RESULT ?? path.join(os.tmpdir(), 'mcw-it-result.txt');
  try {
    const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'matlab-command-window-community')!;
    const api = (await ext.activate()) as CommandWindowApi;
    const cw = api.commandWindow;
    const dir = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const snap = async (): Promise<Snapshot> => (await cw.test({ kind: 'snapshot' })) as Snapshot;
    const typeLine = async (text: string) => {
      await cw.test({ kind: 'type', text });
      await cw.test({ kind: 'key', key: 'Enter' });
    };
    const untilMode = (mode: string, ms = 10000) => waitFor(async () => { const s = await snap(); return s?.mode === mode ? s : undefined; }, ms);
    const untilText = (re: RegExp, ms = 10000) => waitFor(async () => { const s = await snap(); return s && re.test(s.text) ? s : undefined; }, ms);
    const mq = (p: string) => p.replace(/'/g, "''");

    // ---- showing the Command Window connects to the shared MATLAB ----
    await vscode.commands.executeCommand('matlabCommandWindow.show');
    check('Command Window webview loads', !!(await waitFor(() => cw.isReady, 15000)));
    check('connects to the shared MATLAB automatically', !!(await waitFor(() => api.session.state === 'idle', 20000)), api.session.state);
    let s = await untilText(/Connected to MATLAB R2099z/);
    check('says it is connected (and to which MATLAB)', !!s, (await snap()).text.slice(-300));
    s = await untilMode('ready');
    check('prompt is >> when idle', s?.prompt === '>>', s?.prompt);
    check('attached through the session file, not a new MATLAB', !!api.session.sharedSession?.port);

    await typeLine(`cd '${mq(dir)}'`);
    await untilMode('ready');
    await typeLine('x = 6*7');
    s = await untilText(/x =\s+42/);
    check('command output shown', !!s, (await snap()).text.slice(-300));
    check('echoed command with prompt', /^>> x = 6\*7/m.test(s?.text ?? ''));

    // ---- errors in red, links ----
    await typeLine('y = q + 1');
    s = await untilText(/Unrecognized function or variable 'q'/);
    check('error styled red', /Unrecognized function or variable/.test(s?.errorText ?? ''), s?.errorText);
    await typeLine(`run('${mq(path.join(dir, 'error_demo.m'))}')`);
    s = await untilText(/Error in error_demo \(line 3\)/);
    check('script error shown with its stack', !!s, (await snap()).text.slice(-400));
    check('run() frame hidden', !/Error in run \(line/.test(s?.text ?? ''));
    const linkIdx = s?.links.findIndex(l => l.func === 'error_demo' && l.line === 3) ?? -1;
    check('"Error in error_demo (line 3)" is a link', linkIdx >= 0, JSON.stringify(s?.links));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (linkIdx >= 0) {
      await cw.test({ kind: 'clickLink', index: linkIdx });
      const ed = await waitFor(() => vscode.window.activeTextEditor?.document.fileName.endsWith('error_demo.m') ? vscode.window.activeTextEditor : undefined, 5000);
      check('clicking the link opens the file at the error line', ed?.selection.active.line === 2, String(ed?.selection.active.line));
    }

    // ---- collapsible output, history ----
    await typeLine('for k = 1:60, disp(k), end');
    await untilText(/\s60\n/);
    s = await untilMode('ready');
    check('long output collapsed', (s?.collapsed ?? 0) >= 1, String(s?.collapsed));
    await cw.test({ kind: 'type', text: 'x =' });
    await cw.test({ kind: 'key', key: 'ArrowUp' });
    s = await snap();
    check('Up recalls history filtered by prefix', s.input === 'x = 6*7', s.input);
    await cw.test({ kind: 'key', key: 'Escape' });

    // ---- completion, help tooltip, usage hint ----
    await typeLine("myStruct = struct('alpha', 1, 'beta', 2);");
    await untilMode('ready');
    await sleep(300);
    await cw.test({ kind: 'type', text: 'myS' });
    await cw.test({ kind: 'key', key: 'Ctrl-Space' });
    s = await waitFor(async () => { const x = await snap(); return x.completions.length ? x : undefined; }, 5000);
    check('completion pop-up lists workspace variables', !!s?.completions.includes('myStruct'), JSON.stringify(s?.completions));
    await cw.test({ kind: 'key', key: 'Escape' }); await cw.test({ kind: 'key', key: 'Escape' });
    await cw.test({ kind: 'type', text: 'myStruct.al' });
    await cw.test({ kind: 'key', key: 'Ctrl-Space' });
    s = await waitFor(async () => { const x = await snap(); return x.completions.length ? x : undefined; }, 5000);
    check('completion lists struct fields', !!s?.completions.includes('alpha'), JSON.stringify(s?.completions));
    await cw.test({ kind: 'key', key: 'Escape' }); await cw.test({ kind: 'key', key: 'Escape' });
    const tip = (await cw.test({ kind: 'hover', word: 'zeros' })) as string | null;
    check('help tooltip from MATLAB', !!tip && /X = zeros\(n\)/.test(tip) && /Create array of all zeros/.test(tip), String(tip));
    await cw.test({ kind: 'type', text: 'zeros(' });
    s = await waitFor(async () => { const x = await snap(); return /X = zeros/.test(x.tooltip) ? x : undefined; }, 5000);
    check('usage hint while typing a call', !!s, (await snap()).tooltip);
    check('input line is highlighted', (s?.highlighted.length ?? 0) > 0);
    await cw.test({ kind: 'key', key: 'Escape' });

    // ---- input(), keyboard, Stop ----
    await typeLine(`run('${mq(path.join(dir, 'ask_input.m'))}')`);
    s = await untilMode('input');
    check('input() switches the input line to answer mode', /Enter a number:/.test(s?.prompt ?? ''), s?.prompt);
    await typeLine('7');
    s = await untilText(/You typed 7/);
    check('answer goes to input() and the run continues', !!s);
    check('answer echoed after the prompt', /Enter a number: 7/.test(s?.text ?? ''));
    await untilMode('ready');

    await typeLine("kb = 1; keyboard; disp('after keyboard')");
    s = await untilMode('debug');
    check('keyboard shows the K>> prompt', s?.prompt === 'K>>', s?.prompt);
    await typeLine('dbcont');
    await untilText(/after keyboard/);
    s = await untilMode('ready');
    check('dbcont continues, back to >>', s?.prompt === '>>');

    await typeLine(`run('${mq(path.join(dir, 'long_loop.m'))}')`);
    s = await untilMode('busy');
    check('Stop button visible while busy', !!s?.stopVisible);
    await sleep(300);
    await cw.test({ kind: 'clickStop' });
    s = await untilMode('ready', 5000);
    check('Stop interrupts the run', !!s && s.stopVisible === false, (await snap()).mode);

    await typeLine('clc');
    s = await waitFor(async () => { const x = await snap(); return !/x = 6\*7/.test(x.text) ? x : undefined; }, 5000);
    check('clc clears the Command Window', !!s);

    // ---- disconnect / reconnect; stale share ----
    await vscode.commands.executeCommand('matlabCommandWindow.disconnect');
    s = await untilMode('exited');
    check('Disconnect leaves the Command Window disconnected', !!s && /Disconnected\. MATLAB keeps running/.test(s.text), (await snap()).text.slice(-200));
    const sessionFile = process.env.MCW_SESSION_FILE!;
    const saved = fs.readFileSync(sessionFile, 'utf8');
    fs.writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(saved), pid: 999999 }));
    await Promise.resolve(vscode.commands.executeCommand('matlabCommandWindow.connect')).catch(() => undefined);
    s = await untilText(/no longer running[\s\S]*shareMATLABSession\(\)/, 5000);
    check('a stale share is explained (run shareMATLABSession())', !!s, (await snap()).text.slice(-300));
    fs.writeFileSync(sessionFile, saved);   // like running shareMATLABSession() again
    check('reconnects when MATLAB is shared again', !!(await waitFor(() => api.session.state === 'idle', 10000)), api.session.state);
    await typeLine('disp(123)');
    check('works after reconnecting', !!(await untilText(/\s123\n/)));
  } catch (e) {
    check('no exception', false, (e as Error).stack ?? String(e));
  } finally {
    const summary = `${results.length - failures}/${results.length} checks passed`;
    fs.writeFileSync(resultFile, [...results, '', summary, ''].join('\n'));
    console.log(summary);
  }
  if (failures) { throw new Error(`${failures} integration check(s) failed`); }
}
