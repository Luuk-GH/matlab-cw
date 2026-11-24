// End-to-end test inside a real Extension Development Host. The shared MATLAB is FAKE: test/fake/fakeConnector.js
// (started by run-integration.mjs, writes the session file like shareMATLABSession()) plus the fake language server.
// Drives the Command Window webview through its test hooks. Run: npm run test:integration
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Snapshot } from '../src/commandWindow/protocol';
import type { CommandWindowApi } from '../src/extension';
import { LsBackend } from '../src/backend/lsBackend';
import { readSharedSession } from '../src/backend/sharedSession';
import { docPageFromOutput, docPageQuery } from '../src/docLink';

/** MCW_IT_REAL=1 (npm run test:real): against the real shared MATLAB instead of the fakes. */
const real = process.env.MCW_IT_REAL === '1';

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

/** Resolves with the promise's value, or undefined after `ms` (a stuck step must not hang the cleanup). */
function withLimit<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, sleep(ms).then(() => undefined)]);
}

export async function run(): Promise<void> {
  let cleanup: (() => Promise<void>) | undefined;
  const resultFile = process.env.MCW_IT_RESULT ?? path.join(os.tmpdir(), 'mcw-it-result.txt');
  try {
    const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'matlab-command-window')!;
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
    let s = await untilText(real ? /Connected to MATLAB R20\d\d[ab]/ : /Connected to MATLAB R2099z/);
    check('says it is connected (and to which MATLAB)', !!s, (await snap()).text.slice(-300));
    // Real MATLAB: remember its current folder, to put it back at the end.
    const startFolder = real ? await waitFor(() => api.session.queryText('pwd'), 20000) : undefined;
    if (real) {
      // Whatever happens below, never leave the user's MATLAB at K>> or in our test folder.
      cleanup = async () => {
        api.session.interrupt();
        await sleep(500);
        await withLimit(api.session.execute("if ~isempty(dbstack) || feature('IsDebugMode'), dbquit('all'); end"), 10000);
        await withLimit(api.session.execute(`cd('${mq(startFolder ?? '.')}'); clear x y myStruct kb a b n s mcwOrder mcwDrop mcwA`), 10000);
      };
    }
    s = await untilMode('ready');
    check('prompt is >> when idle', s?.prompt === '>>', s?.prompt);
    check('attached through the session file, not a new MATLAB', !!api.session.sharedSession?.port);

    await typeLine(`cd '${mq(dir)}'`);
    await untilMode('ready');
    await typeLine('x = 6*7');
    s = await untilText(/x =\s+42/);
    check('command output shown', !!s, (await snap()).text.slice(-300));
    check('echoed command with prompt', /^>> x = 6\*7/m.test(s?.text ?? ''));
    // A command's output comes before the next command's echo ([verified, R2026b] a late READY once broke this).
    await untilMode('ready');
    await typeLine('mcwOrder = magic(3)'); await untilMode('ready');
    await typeLine('disp(99)');
    s = await untilText(/^\s*99$/m);
    const orderText = s?.text ?? '';
    const rowAt = orderText.search(/mcwOrder =\s+8\s+1\s+6/);
    check('output before the next echo', rowAt >= 0 && rowAt < orderText.lastIndexOf('>> disp(99)'), JSON.stringify(orderText.slice(-300)));
    await untilMode('ready');

    // ---- errors in red, links ----
    await typeLine('y = q + 1');
    s = await untilText(/Unrecognized function or variable 'q'/);
    check('error styled red', /Unrecognized function or variable/.test(s?.errorText ?? ''), s?.errorText);
    await typeLine(`run('${mq(path.join(dir, 'error_demo.m'))}')`);
    s = await untilText(/Error in error_demo \(line 3\)/);
    check('script error shown with its stack', !!s, (await snap()).text.slice(-400));
    check('run() frame hidden', !/Error in run \(line/.test(s?.text ?? ''));
    check("run() frame's code line hidden too", !/evalin\('caller'/.test(s?.text ?? ''), s?.text.slice(-300));
    check('no {\\b }\\b error markers shown', !/[\x08]|^\{|^\}/m.test(s?.text ?? ''), JSON.stringify(s?.text.slice(-300)));
    const linkIdx = s?.links.findIndex(l => l.func === 'error_demo' && l.line === 3) ?? -1;
    check('"Error in error_demo (line 3)" is a link', linkIdx >= 0, JSON.stringify(s?.links));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (linkIdx >= 0) {
      await cw.test({ kind: 'clickLink', index: linkIdx });
      // The editor opens first and moves to the line just after: wait for both.
      const atLine = () => {
        const e = vscode.window.activeTextEditor;
        return e?.document.fileName.endsWith('error_demo.m') && e.selection.active.line === 2 ? e : undefined;
      };
      const ed = (await waitFor(atLine, 5000)) ?? vscode.window.activeTextEditor;
      check('clicking the link opens the file at the error line', ed?.selection.active.line === 2, String(ed?.selection.active.line));
    }

    // ---- collapsible output, history ----
    await typeLine('for k = 1:60, disp(k), end');
    await untilText(/\s60\n/);
    s = await untilMode('ready');
    check('long output shown in full (collapseLongOutput off)', s?.collapsed === 0, String(s?.collapsed));
    // Command History pop-up (default): Up lists the commands that start with what is typed.
    await cw.test({ kind: 'type', text: 'x =' });
    await cw.test({ kind: 'key', key: 'ArrowUp' });
    s = await snap();
    check('Up opens the Command History pop-up, filtered by what is typed',
      s.historyPopup.length > 0 && s.historyPopup.every(r => /^(\d+x )?x =/.test(r)) && s.historySelected.join() === 'x = 6*7', JSON.stringify(s.historyPopup));
    await cw.test({ kind: 'key', key: 'ArrowRight' });
    s = await snap();
    check('Right puts the selected command on the line', s.input === 'x = 6*7' && s.historyPopup.length === 0, s.input);
    await cw.test({ kind: 'key', key: 'Escape' });
    for (const line of ['mcwA = 1', 'mcwA = mcwA + 1', 'mcwA = mcwA + 1']) { await typeLine(line); await untilMode('ready'); }
    await cw.test({ kind: 'type', text: 'mcwA' });
    await cw.test({ kind: 'key', key: 'ArrowUp' });
    s = await snap();
    check('a repeated command shows once with its count', s.historyPopup[s.historyPopup.length - 1] === '2x mcwA = mcwA + 1', JSON.stringify(s.historyPopup.slice(-3)));
    await cw.test({ kind: 'key', key: 'Shift-ArrowUp' });
    s = await snap();
    check('Shift+Up selects several', s.historySelected.join('|') === 'mcwA = 1|mcwA = mcwA + 1', JSON.stringify(s.historySelected));
    await cw.test({ kind: 'key', key: 'Enter' });
    await untilMode('ready');
    s = await snap();
    check('Enter runs the selected commands in order', s.input === '' && /^>> mcwA = 1$[\s\S]*^>> mcwA = mcwA \+ 1$/m.test(s.text.slice(-400)), JSON.stringify(s.text.slice(-200)));
    await typeLine("fprintf('mcwA=%d\\n', mcwA)");
    check('they ran (mcwA = 2)', !!(await untilText(/^mcwA=2$/m)), JSON.stringify((await snap()).text.slice(-200)));
    await untilMode('ready');
    // historyPopup off: Up recalls on the line, as before.
    await vscode.workspace.getConfiguration('matlabCommandWindow').update('historyPopup', false, vscode.ConfigurationTarget.Global);
    await sleep(300);
    await cw.test({ kind: 'type', text: 'x =' });
    await cw.test({ kind: 'key', key: 'ArrowUp' });
    s = await snap();
    check('with historyPopup off, Up recalls history on the line', s.input === 'x = 6*7' && s.historyPopup.length === 0, s.input);
    await cw.test({ kind: 'key', key: 'Escape' });
    await vscode.workspace.getConfiguration('matlabCommandWindow').update('historyPopup', undefined, vscode.ConfigurationTarget.Global);

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
    if (real) { check('the help tooltip links to the documentation', /Documentation/.test(tip ?? ''), String(tip)); }
    // ---- hover help in MATLAB editors, from the same MATLAB help (VS Code's own hover request) ----
    {
      const hdoc = await vscode.workspace.openTextDocument({ language: 'matlab', content: "y = zeros(3); % zeros\ndisp('zeros')" });
      const hover = async (line: number, col: number) => {
        const hs = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', hdoc.uri, new vscode.Position(line, col));
        return (hs ?? []).flatMap(h => h.contents.map(c => typeof c === 'string' ? c : c.value)).join('\n');
      };
      const md = await hover(0, 6);
      check('editor hover shows MATLAB help for a function', /X = zeros\(n\)/.test(md) && /Create array of all zeros/.test(md), md);
      if (real) { check('editor hover links to the MathWorks documentation', md.includes('command:matlabCommandWindow.openDoc?') && md.includes('"https://www.mathworks.com/help/matlab/ref/zeros.html"'), md); }
      if (real) {
        // A Documentation click asks MATLAB for the page its doc would open (the derived address is wrong for linspace).
        const page = async (n: string) => docPageFromOutput(await api.session.queryText('evalc', [docPageQuery(n)], true, 10000));
        const lin = await page('linspace'), zer = await page('zeros');
        check('MATLAB gives the exact documentation page (linspace -> double.linspace)', !!lin?.startsWith('https://www.mathworks.com/help/matlab/ref/double.linspace.html')
          && !!zer?.startsWith('https://www.mathworks.com/help/matlab/ref/zeros.html'), `${lin} | ${zer}`);
      }
      check('no editor hover in comments or strings', !/zeros\(n\)/.test(await hover(0, 18)) && !/zeros\(n\)/.test(await hover(1, 8)));
    }
    await cw.test({ kind: 'type', text: 'zeros(' });
    s = await waitFor(async () => { const x = await snap(); return /X = zeros/.test(x.tooltip) || /zeros\(/.test(x.signature) ? x : undefined; }, 8000);
    check('usage hint while typing a call', !!s, `${(await snap()).tooltip} | ${(await snap()).signature}`);
    check('input line is highlighted', (s?.highlighted.length ?? 0) > 0);
    // MATLAB's signature help, like the editor's parameter hints: the form, the current argument, its purpose.
    for (let i = 0; i < 3; i++) { await cw.test({ kind: 'key', key: 'Escape' }); }
    await cw.test({ kind: 'type', text: 'linspace(0, ' });
    s = await waitFor(async () => { const x = await snap(); return /linspace\(x1,x2,n\)/.test(x.signature) ? x : undefined; }, 8000);
    check('signature box shows the function form', !!s, (await snap()).signature);
    check('signature box highlights the current argument', s?.signatureActive === 'x2', s?.signatureActive);
    check('signature box explains the argument', /Point interval/.test(s?.signature ?? '') && /pair of scalars/.test(s?.signature ?? ''), s?.signature);
    // Esc closes an open completion list first (as in the editor), then the signature box, and only then clears the line.
    await cw.test({ kind: 'key', key: 'Escape' });
    if ((await snap()).signature) { await cw.test({ kind: 'key', key: 'Escape' }); }
    s = await snap();
    check('Esc closes the signature box (before clearing the line)', s.signature === '' && s.input === 'linspace(0, ', `${s.signature} | ${s.input}`);
    for (let i = 0; i < 2; i++) { await cw.test({ kind: 'key', key: 'Escape' }); }
    await cw.test({ kind: 'type', text: 'plot(' });
    s = await waitFor(async () => { const x = await snap(); return /plot\(Y,LineSpec,options\)\s*1 of \d+/.test(x.signature) ? x : undefined; }, 8000);
    check('signature box: the suggested form first, "1 of N"', !!s && s.signatureActive === 'Y' && /y-coordinates/.test(s.signature), (await snap()).signature);
    await cw.test({ kind: 'key', key: 'Alt-ArrowDown' });
    s = await snap();
    check('Alt+Down shows the next form', /2 of \d+/.test(s.signature) && !/^iplot\(Y,LineSpec,options\)/.test(s.signature), s.signature);
    for (let i = 0; i < 3; i++) { await cw.test({ kind: 'key', key: 'Escape' }); }
    await cw.test({ kind: 'key', key: 'Escape' });

    // ---- file and folder completion from MATLAB's function signatures (load('…, cd …) ----
    {
      // Fake: data recorded in this repository's folder; real: the test workspace (MATLAB is in it).
      const [typed, pick, after] = real ? ["readtable('err", 'error_demo.m', "readtable('error_demo.m'"] : ['cd sc', 'scripts\\', 'cd scripts\\'];
      await cw.test({ kind: 'type', text: typed });
      await cw.test({ kind: 'key', key: 'Tab' });
      s = await waitFor(async () => { const x = await snap(); return x.completions.includes(pick) ? x : undefined; }, 5000);
      check('file/folder names complete in a path argument', !!s, JSON.stringify((await snap()).completions));
      await sleep(200);   // CodeMirror ignores accepting within its interactionDelay (75 ms) after the list opens
      await cw.test({ kind: 'key', key: 'Enter' });
      s = await snap();
      check('accepting a name puts it on the line', s.input === after, s.input);
      for (let i = 0; i < 3; i++) { await cw.test({ kind: 'key', key: 'Escape' }); }
    }

    // ---- input(), keyboard, Stop ----
    await typeLine(`run('${mq(path.join(dir, 'ask_input.m'))}')`);
    s = await untilMode('input');
    check('input() switches the input line to answer mode', /Enter a number:/.test(s?.prompt ?? ''), s?.prompt);
    // The MATLAB extension's terminal reacts to the same INPUT state with matlab.openCommandWindow, sometimes after us
    // (CommandWindow.js; that extension is not loaded here, so do the same, late): the Command Window comes back.
    {
      await sleep(400);
      const t = vscode.window.createTerminal({ name: 'MATLAB' });
      t.show();
      const hiddenByTerminal = await waitFor(() => !cw.isVisible(), 1000);
      const backAgain = await waitFor(() => cw.isVisible(), 3000);
      await sleep(1500);
      check('input(): the MATLAB terminal took the panel', !!hiddenByTerminal);
      check('input(): the Command Window comes back in front of it', !!backAgain && cw.isVisible());
      t.dispose();
    }
    await typeLine('7');
    s = await untilText(/You typed 7/);
    check('answer goes to input() and the run continues', !!s);
    check('answer echoed after the prompt', /Enter a number: 7/.test(s?.text ?? ''));
    await untilMode('ready');

    await typeLine("kb = 1; keyboard; disp('after keyboard')");
    // Real MATLAB: K>> can take seconds (the MATLAB extension's debugger reacts to the stop first).
    s = await untilMode('debug', real ? 20000 : 10000);
    check('keyboard shows the K>> prompt', s?.prompt === 'K>>', s?.prompt);
    // At a breakpoint the MATLAB extension starts its 'matlab' debug session and shows its MATLAB terminal
    // (MatlabDebugger.js; that extension is not loaded here, so do the same): the Command Window comes back.
    api.keepInFront.matlabDebugStarted();
    const matlabTerminal = vscode.window.createTerminal({ name: 'MATLAB' });
    matlabTerminal.show();
    const hidden = await waitFor(() => !cw.isVisible(), 1000);
    const back = await waitFor(() => cw.isVisible(), 3000);
    await sleep(1200);   // after the debounced reveal: still in front
    check('the MATLAB terminal took the panel (as at a breakpoint)', !!hidden);
    check('at a breakpoint the Command Window comes back in front of it', !!back && cw.isVisible());
    matlabTerminal.dispose();
    // At K>> Shift+Enter / Ctrl+Enter still run in the Command Window (in the stopped workspace); F5 stays Continue.
    {
      const keys = (ext.packageJSON.contributes.keybindings as { key: string; when: string }[]);
      const debugOk = (key: string) => !/matlab\.isDebugging/.test(keys.find(k => k.key === key)?.when ?? 'matlab.isDebugging');
      check('Shift+Enter and Ctrl+Enter also apply while debugging, F5 does not', debugOk('shift+enter') && debugOk('ctrl+enter') && !debugOk('f5'));
      const kbDoc = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'matlab', content: 'kbSel = kb + 41' }));
      kbDoc.selection = new vscode.Selection(0, 0, 0, 15);
      await withLimit(Promise.resolve(vscode.commands.executeCommand('matlabCommandWindow.runSelection')), 15000);
      s = await untilText(/kbSel =\s+42/);
      check('Run Selection at K>> runs in the Command Window, in the stopped workspace', !!s && (await untilMode('debug'))?.prompt === 'K>>', JSON.stringify((await snap()).text.slice(-200)));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await typeLine('dbcont');
    await untilText(/after keyboard/);
    s = await untilMode('ready');
    check('dbcont continues, back to >>', s?.prompt === '>>');

    await typeLine(`run('${mq(path.join(dir, 'long_loop.m'))}')`);
    s = await untilMode('busy');
    check('Stop button visible while busy', !!s?.stopVisible);
    await typeLine('disp(111)');
    await typeLine('disp(222)');
    s = await waitFor(async () => { const x = await snap(); return x?.queued.length === 2 ? x : undefined; }, 3000);
    check('commands typed while busy are shown as queued', s?.queued.join('|') === 'disp(111)|disp(222)', String(s?.queued ?? (await snap()).queued));
    await cw.test({ kind: 'cancelQueued', index: 1 });
    s = await waitFor(async () => { const x = await snap(); return x?.queued.length === 1 ? x : undefined; }, 3000);
    check('× removes one queued command', s?.queued[0] === 'disp(111)', String((await snap()).queued));
    // Press Stop once the loop really runs: [verified, R2026b] an interrupt that arrives before the code starts, while
    // the MATLAB extension's debugger is active (after the keyboard step), becomes a debugger pause at line 1.
    await sleep(real ? 1500 : 300);
    await cw.test({ kind: 'clickStop' });
    s = await untilMode('ready', 5000);
    check('Stop interrupts the run', !!s && s.stopVisible === false, (await snap()).mode);
    check('Stop drops the queued commands too', !!s && s.queued.length === 0 && !/^>> disp\((111|222)\)$/m.test(s.text), String(s?.queued));

    // ---- Run File / Section / Selection from the editor go to the Command Window, the editor keeps focus ----
    const demo = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(dir, 'error_demo.m')));
    await withLimit(Promise.resolve(vscode.commands.executeCommand('matlabCommandWindow.runFile')), 15000);
    s = await untilText(/^>> error_demo$[\s\S]*Error in error_demo \(line 3\)/m);
    check('Run File runs the file in the Command Window', !!s, (await snap()).text.slice(-300));
    check('the editor keeps the focus after Run File', vscode.window.activeTextEditor?.document === demo.document);
    demo.selection = new vscode.Selection(1, 0, 1, 6);   // "a = 1;"
    await withLimit(Promise.resolve(vscode.commands.executeCommand('matlabCommandWindow.runSelection')), 15000);
    check('Run Selection runs the selected code', !!(await untilText(/^>> a = 1;$/m)), JSON.stringify((await snap()).text.slice(-500)));
    await untilMode('ready');
    await cw.test({ key: 'ArrowUp', kind: 'key' });
    s = await snap();
    check('Run Selection adds the selection to the Command History', s.historyPopup[s.historyPopup.length - 1] === 'a = 1;', JSON.stringify(s.historyPopup.slice(-3)));
    await cw.test({ key: 'Escape', kind: 'key' });
    demo.selection = new vscode.Selection(0, 0, 0, 0);
    await withLimit(Promise.resolve(vscode.commands.executeCommand('matlabCommandWindow.runSection')), 15000);
    check('Run Section runs the section at the cursor', !!(await untilText(/>> % error_demo\.m: section lines 1–\d/)), JSON.stringify((await snap()).text.slice(-500)));

    // ---- dropping a .mat file loads it (other files are ignored) ----
    {
      await untilMode('ready');
      const mat = path.join(dir, 'mcw_drop_test.mat');
      if (real) { await api.session.execute(`mcwDrop = 4242; save('${mq(mat)}', 'mcwDrop'); clear mcwDrop`); }
      const uris = [vscode.Uri.file(mat).toString(), vscode.Uri.file(path.join(dir, 'error_demo.m')).toString()];
      await cw.test({ kind: 'drop', type: 'application/vnd.code.uri-list', data: uris.join('\r\n') });
      s = await untilText(/^>> load\('[^\n]*mcw_drop_test\.mat'\)$/m, 5000);
      check('dropping a .mat file runs load() on it', !!s && !/load\('[^\n]*error_demo\.m'\)/.test(s.text), JSON.stringify((await snap()).text.slice(-300)));
      if (real) {
        await untilMode('ready');
        await typeLine('disp(mcwDrop)');
        check('the dropped .mat file is loaded into the workspace', !!(await untilText(/^\s*4242$/m)), JSON.stringify((await snap()).text.slice(-200)));
      }
      await untilMode('ready');
      // From Windows Explorer: only the bytes arrive (no path); VS Code's host must not see the drag (it would block
      // the webview) and CodeMirror must not paste the bytes; the extension loads a temporary copy and deletes it.
      if (real) { await typeLine('clear mcwDrop'); await untilMode('ready'); }
      const bytes = real ? fs.readFileSync(mat) : Buffer.from('MATLAB 5.0 MAT-file (fake)');
      const r = await cw.test({ kind: 'dropFile', name: 'mcw_drop_bytes.mat', base64: bytes.toString('base64') }) as { reachedWindow: number; inputChanged: boolean };
      check('a file dragged from outside VS Code is kept from VS Code and the input line', r?.reachedWindow === 0 && !r.inputChanged, JSON.stringify(r));
      s = await untilText(/^>> load\('([^\n]*mcw-drop-[^\n]*mcw_drop_bytes\.mat)'\)$/m, 5000);
      check('dropping a file from outside VS Code loads a copy of it', !!s, JSON.stringify((await snap()).text.slice(-300)));
      await untilMode('ready');
      const copy = /^>> load\('([^\n]*mcw-drop-[^\n]*mcw_drop_bytes\.mat)'\)$/m.exec(s?.text ?? '')?.[1]?.replace(/''/g, "'");
      check('the temporary copy is deleted after load()', !!copy && !!(await waitFor(() => !fs.existsSync(path.dirname(copy)), 3000)), copy);
      if (real) {
        await typeLine('disp(mcwDrop)');
        check('the copy is loaded into the workspace', !!(await untilText(/^\s*4242$[\s\S]*^\s*4242$/m)), JSON.stringify((await snap()).text.slice(-200)));
        await untilMode('ready');
      }
      // Explorer: right-click a .mat file -> Load into MATLAB Command Window.
      await vscode.commands.executeCommand('matlabCommandWindow.loadMatFile', vscode.Uri.file(mat), [vscode.Uri.file(mat)]);
      s = await waitFor(async () => { const x = await snap(); return (x.text.match(/^>> load\('[^\n]*mcw_drop_test\.mat'\)$/gm) ?? []).length === 2 ? x : undefined; }, 5000);
      check('Explorer: Load into MATLAB Command Window loads the .mat file', !!s, JSON.stringify((await snap()).text.slice(-300)));
      await untilMode('ready');
      if (real) { try { fs.unlinkSync(mat); } catch { /* gone */ } }
    }
    await untilMode('ready');

    await typeLine('clc');
    s = await waitFor(async () => { const x = await snap(); return !/x = 6\*7/.test(x.text) ? x : undefined; }, 5000);
    check('clc clears the Command Window', !!s);

    // ---- input() from a command started elsewhere (real MATLAB only: the fakes do not share one interpreter) ----
    if (real) {
      // A second client plays the MATLAB terminal of the official extension.
      const lookup = readSharedSession();
      const other = lookup.ok ? new LsBackend({ serverPath: process.env.MCW_LANGUAGE_SERVER!, attach: lookup.session, startTimeoutMs: 20000 }) : undefined;
      let otherOut = '';
      other?.on('output', (t: string) => { otherOut += t; });
      await other?.start();
      const otherRun = other?.eval(`run('${mq(path.join(dir, 'ask_input.m'))}')`);
      s = await untilText(/MATLAB is waiting for input\(\)[\s\S]*Answer it there/);
      check('input() from another window is left to that window', !!s, (await snap()).text.slice(-300));
      check('our input line does not switch to answering', (await snap()).mode !== 'input', (await snap()).mode);
      await other?.eval('5');   // answered "in the terminal"
      await otherRun;
      check('the other window gets its output', /You typed 5/.test(otherOut), JSON.stringify(otherOut));
      check('back to >> afterwards', !!(await untilMode('ready')), (await snap()).mode);
      other?.dispose();
      await sleep(1500);
    }

    // ---- disconnect / reconnect; stale share ----
    await vscode.commands.executeCommand('matlabCommandWindow.disconnect');
    s = await untilMode('exited');
    check('Disconnect leaves the Command Window disconnected', !!s && /Disconnected\. MATLAB keeps running/.test(s.text), (await snap()).text.slice(-200));
    {
      // Only the MATLAB started by the MATLAB extension in this window: the shared MATLAB here (the fake's test runner,
      // or the real one of the developer's own VS Code window) is not, so without MCW_ANY_MATLAB it is refused.
      delete process.env.MCW_ANY_MATLAB;
      await Promise.resolve(vscode.commands.executeCommand('matlabCommandWindow.connect')).catch(() => undefined);
      s = await untilText(/was started by [^\n]+, not by the MATLAB extension in this VS Code window/, 20000);
      check('refuses a MATLAB not started by the MATLAB extension in this window', !!s && api.session.state === 'exited',
        `${api.session.state}: ${(await snap()).text.slice(-300)}`);
      process.env.MCW_ANY_MATLAB = '1';
    }
    if (real) {
      // Do not touch the real session file: just connect again.
      await Promise.resolve(vscode.commands.executeCommand('matlabCommandWindow.connect')).catch(() => undefined);
      check('reconnects', !!(await waitFor(() => api.session.state === 'idle', 20000)), api.session.state);
    } else {
    const sessionFile = process.env.MCW_SESSION_FILE!;
    const saved = fs.readFileSync(sessionFile, 'utf8');
    fs.writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(saved), pid: 999999 }));
    await Promise.resolve(vscode.commands.executeCommand('matlabCommandWindow.connect')).catch(() => undefined);
    s = await untilText(/no longer running[\s\S]*shareMATLABSession\(\)/, 5000);
    check('a stale share is explained (run shareMATLABSession())', !!s, (await snap()).text.slice(-300));
    fs.writeFileSync(sessionFile, saved);   // like running shareMATLABSession() again
    check('reconnects when MATLAB is shared again', !!(await waitFor(() => api.session.state === 'idle', 10000)), api.session.state);
    }
    await typeLine('disp(123)');
    check('works after reconnecting', !!(await untilText(/\s123\n/)));
    if (real) {
      // Leave the user's MATLAB as we found it: folder back, our test variables gone.
      await api.session.execute(`cd('${mq(startFolder ?? '.')}'); clear x y myStruct kb a b n s mcwOrder mcwDrop mcwA`);
      const now = await api.session.queryText('pwd');
      check('MATLAB is back in its own folder', now === startFolder, `${now} vs ${startFolder}`);
    }
  } catch (e) {
    check('no exception', false, (e as Error).stack ?? String(e));
  } finally {
    await cleanup?.().catch(e => check('cleanup of the real MATLAB', false, String(e)));
    const summary = `${results.length - failures}/${results.length} checks passed`;
    fs.writeFileSync(resultFile, [...results, '', summary, ''].join('\n'));
    console.log(summary);
  }
  if (failures) { throw new Error(`${failures} integration check(s) failed`); }
}
