// Heavy output on the real shared MATLAB: how fast output arrives, and whether Stop ends a flood at once.
// Run: npm run bench:flood   (node scripts/run-integration.mjs --real --tests=dist/flood.test.js)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandWindowApi } from '../src/extension';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const lines: string[] = [];
let failures = 0;
const log = (s: string) => { lines.push(s); console.log(s); };
const check = (name: string, ok: boolean, detail = '') => { if (!ok) { failures++; } log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

export async function run(): Promise<void> {
  const resultFile = process.env.MCW_IT_RESULT ?? path.join(os.tmpdir(), 'mcw-flood-result.txt');
  const api = (await vscode.extensions.all.find(e => e.packageJSON?.name === 'matlab-command-window')!.activate()) as CommandWindowApi;
  const cw = api.commandWindow;
  let slowest = 0;
  type Draw = { draws: number; ms: number; max: number; msgs: number; layout: number };
  type Tail = { tail: string; blockLength: number; mode: string; input: string; draw?: Draw };
  const draw: Draw = { draws: 0, ms: 0, max: 0, msgs: 0, layout: 0 };
  const snap = async (): Promise<Tail> => {
    const t0 = Date.now();
    const r = (await cw.test({ kind: 'tail', chars: 400 }, 60000)) as Tail | undefined;
    slowest = Math.max(slowest, Date.now() - t0);
    if (r?.draw) { draw.draws += r.draw.draws; draw.ms += r.draw.ms; draw.max = Math.max(draw.max, r.draw.max); draw.msgs += r.draw.msgs; draw.layout += r.draw.layout; }
    return r ?? { tail: '', blockLength: -1, mode: '?', input: '' };
  };
  const resetSlowest = () => {
    const v = `${slowest} ms (webview: ${draw.msgs} messages, ${draw.draws} draws, ${draw.ms} ms drawing of which ${draw.layout} ms layout, longest ${draw.max} ms)`;
    slowest = 0; draw.draws = draw.ms = draw.max = draw.msgs = draw.layout = 0;
    return v;
  };
  const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms: number): Promise<T | undefined> => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) { return v; } if (Date.now() > end) { return undefined; } await sleep(20); }
  };
  const typeLine = async (t: string) => { await cw.test({ kind: 'type', text: t }); await cw.test({ kind: 'key', key: 'Enter' }); };
  try {
    await vscode.commands.executeCommand('matlabCommandWindow.show');
    await waitFor(async () => api.session.state === 'idle', 30000);
    await waitFor(async () => (await snap()).mode === 'ready', 30000);
    await typeLine('clc');
    await sleep(500);
    resetSlowest();

    // 1. Latency of a single short output (should stay as quick as before: no batching delay).
    for (let k = 0; k < 3; k++) {
      const t0 = Date.now();
      await typeLine(`disp('mcw-ping-${k}')`);
      const ok = await waitFor(async () => (await snap()).tail.includes(`mcw-ping-${k}`), 10000);
      log(`ping ${k}: output shown after ${Date.now() - t0} ms${ok ? '' : ' (NOT SHOWN)'}`);
    }

    // 2. Throughput: N lines; time until MATLAB is done (prompt) and until the last line is on screen.
    // Where the time goes: output messages reaching the extension, time spent handling them, event-loop lag.
    const prov = cw as unknown as { writeOutput(t: string, s: string): void };
    const orig = prov.writeOutput.bind(prov);
    let msgs = 0, chars = 0, handling = 0, lag = 0;
    prov.writeOutput = (t, s) => { msgs++; chars += t.length; const h = performance.now(); orig(t, s); handling += performance.now() - h; };
    let tick = performance.now();
    const lagTimer = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - tick - 50); tick = now; }, 50);
    const stats = () => { const r = `${msgs} messages, ${chars} chars, handling ${Math.round(handling)} ms, max event-loop lag ${Math.round(lag)} ms`; msgs = chars = handling = lag = 0; return r; };
    for (const n of (process.env.MCW_FLOOD_N ?? "2000,20000").split(",").map(Number)) {
      await typeLine('clc');
      await waitFor(async () => (await snap()).mode === 'ready', 10000);
      stats();
      const t0 = Date.now();
      await typeLine(`mcwT = tic; for mcwI = 1:${n}, fprintf('flood line %d of ${n}, with some padding text to make it longer\\n', mcwI); end, fprintf('mcw-toc %.2f\\n', toc(mcwT))`);
      const shown = await waitFor(async () => (await snap()).tail.includes('mcw-toc'), 180000);
      const tShown = Date.now() - t0;
      const ready = await waitFor(async () => (await snap()).mode === 'ready', 60000);
      const toc = /mcw-toc ([\d.]+)/.exec((await snap()).tail)?.[1];
      log(`flood ${n} lines: on screen after ${shown ? tShown : 'NEVER'} ms, prompt after ${ready ? Date.now() - t0 : 'NEVER'} ms; MATLAB's loop took ${toc} s; webview slowest answer ${resetSlowest()} ms; ${stats()}`);
    }
    clearInterval(lagTimer);

    // 3. Stop during an endless flood: back to >> quickly, and no output keeps streaming in afterwards.
    await typeLine('clc');
    await waitFor(async () => (await snap()).mode === 'ready', 10000);
    await typeLine(`mcwI = 0; while true, mcwI = mcwI + 1; fprintf('endless line %d, with some padding text to make it longer\\n', mcwI); end`);
    await waitFor(async () => (await snap()).mode === 'busy', 10000);
    await sleep(3000);
    const tStop = Date.now();
    await cw.test({ kind: 'clickStop' });
    const back = await waitFor(async () => (await snap()).mode === 'ready', 90000);
    const tBack = Date.now() - tStop;
    const t1 = await snap();
    await sleep(1500);
    const t2 = await snap();
    // >> returns once the output MATLAB printed before Stop has passed the language server (~3,300 lines/s): reported.
    check('Stop during a flood returns to >> (within 90 s)', !!back, 'never');
    log(`Stop: >> after ${tBack} ms; webview slowest answer ${resetSlowest()}`);
    check('no output streams in after Stop', t1.tail === t2.tail && t1.blockLength === t2.blockLength, JSON.stringify(t2.tail.slice(-80)));
    const v = await api.session.queryText('evalc', ['disp(mcwI)'], true, 5000);
    log(`MATLAB printed ${v?.trim()} lines before the interrupt`);

    // 4. The input line answers while output floods (typing is not blocked).
    await typeLine('clc');
    await typeLine(`for mcwI = 1:200000, fprintf('busy line %d, with some padding text to make it longer\\n', mcwI); end`);
    await waitFor(async () => (await snap()).mode === 'busy', 10000);
    await sleep(1000);
    const t5 = Date.now();
    await cw.test({ kind: 'type', text: 'x' });
    const typed = await waitFor(async () => (await snap()).input.endsWith('x'), 10000);
    log(`typing during a flood: shown after ${typed ? Date.now() - t5 : 'NEVER'} ms; webview slowest answer ${resetSlowest()} ms`);
    await cw.test({ kind: 'clickStop' });
    await waitFor(async () => (await snap()).mode === 'ready', 30000);
    await cw.test({ kind: 'key', key: 'Escape' });
    await api.session.execute('clear mcwI');
  } catch (e) {
    failures++;
    log(`FAIL  exception: ${(e as Error)?.stack ?? e}`);
  } finally {
    try { api.session.interrupt(); } catch { /* */ }
    fs.writeFileSync(resultFile, lines.join('\n') + `\n${failures ? `${failures} FAILED` : 'ALL PASSED'}\n`);
    setTimeout(() => process.exit(failures ? 1 : 0), 500);
  }
}
