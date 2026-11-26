// Finds the MATLAB session shared with shareMATLABSession() (MathWorks' "MATLAB MCP Server Toolbox", installed by
// the MATLAB Agentic Toolkit or `matlab-mcp-server --setup-matlab`, R2023a+). That function turns on MATLAB's web
// connector and writes {port, certificate, apiKey, pid, basePath} to sessionDetails.json in the MCP server's
// app-data folder (read from the toolbox's +mcpserver/+internal/shareMATLABSession.m and DefaultAppDataLocator.m).
// The same file is what the MathWorks MCP server uses in --matlab-session-mode=existing.
// No VS Code dependency; unit-tested.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectorTarget } from './connectorProxy';

export interface SharedSession extends ConnectorTarget {
  pid: number;
  /** The file the details came from. */
  file: string;
  /** Its modification time (a new shareMATLABSession() call changes it). */
  mtimeMs: number;
}

/** Where shareMATLABSession() writes its details on this OS (MCW_SESSION_FILE overrides, for tests). */
export function sessionFilePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.MCW_SESSION_FILE) { return env.MCW_SESSION_FILE; }
  let dir: string;
  if (platform === 'win32') { dir = path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'MathWorks', 'MATLAB MCP Server'); }
  else if (platform === 'darwin') { dir = path.join(env.HOME ?? os.homedir(), 'Library', 'Application Support', 'MathWorks', 'MATLAB MCP Server'); }
  else { dir = path.join(env.HOME ?? os.homedir(), '.MathWorks', 'MATLABMCPServer'); }
  return path.join(dir, 'v1', 'sessionDetails.json');
}

export type SessionLookup =
  | { ok: true; session: SharedSession }
  | { ok: false; reason: 'missing' | 'invalid' | 'stale'; message: string; file: string };

/** Read and check the session file. `alive` tells whether a process id still exists. */
export function readSharedSession(file = sessionFilePath(), alive: (pid: number) => boolean = processAlive): SessionLookup {
  let text: string;
  let mtimeMs: number;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return { ok: false, reason: 'missing', file, message: 'No shared MATLAB session found.' };
  }
  let d: Record<string, unknown>;
  try { d = JSON.parse(text.replace(/^﻿/, '')); } catch {
    return { ok: false, reason: 'invalid', file, message: `The shared-session file is not valid JSON: ${file}` };
  }
  const port = Number(d.port), pid = Number(d.pid);
  const certificate = typeof d.certificate === 'string' ? d.certificate : '';
  const apiKey = typeof d.apiKey === 'string' ? d.apiKey : '';
  if (!port || !certificate || !apiKey) {
    return { ok: false, reason: 'invalid', file, message: `The shared-session file lacks port, certificate or apiKey: ${file}` };
  }
  if (pid && !alive(pid)) {
    return { ok: false, reason: 'stale', file, message: `The shared MATLAB (process ${pid}) is no longer running.` };
  }
  return {
    ok: true,
    session: { port, certificate, apiKey, pid, basePath: typeof d.basePath === 'string' ? d.basePath : '', file, mtimeMs },
  };
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** "R2026b" from a MATLAB executable path such as C:\Program Files\MATLAB\R2026b\bin\win64\MATLAB.exe. */
export function releaseFromPath(p: string | undefined | null): string | null {
  const m = /(?:^|[\\/_])(R20\d\d[ab])(?=[\\/.]|$)/i.exec(p ?? '');
  return m ? `R${m[1].slice(1, 5)}${m[1].slice(5).toLowerCase()}` : null;
}

/**
 * The release from matlabroot/VersionInfo.xml (`<release>R2026b</release>`), looked up from the MATLAB executable's
 * folder upwards (matlabroot/bin/<arch>/MATLAB.exe, matlabroot/bin/matlab, MATLAB_R2026b.app/bin/maci64/MATLAB).
 * For installations whose folder name does not contain the release.
 */
export function releaseFromInstall(exe: string): string | null {
  let dir = path.dirname(exe.trim());
  for (let i = 0; i < 4; i++) {
    try {
      const m = /<release>\s*(R20\d\d[ab])\s*<\/release>/i.exec(fs.readFileSync(path.join(dir, 'VersionInfo.xml'), 'utf8'));
      if (m) { return releaseFromPath(m[1]); }
    } catch { /* not here */ }
    const up = path.dirname(dir);
    if (up === dir) { break; }
    dir = up;
  }
  return null;
}

/**
 * The release of a running MATLAB, read from its executable path or else its installation (the session file does not
 * contain it). Null when it cannot be told; the backend then assumes FALLBACK_RELEASE (lsLoader.ts).
 */
export async function matlabReleaseOfProcess(pid: number): Promise<string | null> {
  if (!pid) { return null; }
  try {
    let exe: string;
    if (process.platform === 'linux') { exe = fs.readlinkSync(`/proc/${pid}/exe`); }
    else {
      const { execFile } = await import('child_process');
      const run = (cmd: string, args: string[]) => new Promise<string>(resolve =>
        execFile(cmd, args, { timeout: 5000, windowsHide: true }, (_e, out) => resolve(String(out ?? ''))));
      exe = process.platform === 'win32'
        ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).Path`])
        : await run('ps', ['-o', 'comm=', '-p', String(pid)]);
    }
    exe = exe.trim();
    return exe ? releaseFromPath(exe) ?? releaseFromInstall(exe) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Which MATLAB is ours: only the one the MATLAB extension in THIS VS Code window started. Its language server is a
// child of the extension host we run in, and starts MATLAB (on Windows MATLAB.exe starts a second MATLAB.exe), so the
// shared MATLAB descends from our extension host. Another client's MATLAB, e.g. one the MATLAB MCP server starts with
// `-r "...initializeMCP()"` when the shared one is gone, or the MATLAB of another VS Code window, does not; it also
// writes sessionDetails.json, and following it there silently switched the Command Window to a different MATLAB.

export interface ProcInfo { pid: number; ppid: number; name: string; }

/** `pid`, its parent, its parent's parent, ... (stops at a loop, a missing process or after 16 steps). */
export function processChain(pid: number, table: Map<number, ProcInfo>): ProcInfo[] {
  const chain: ProcInfo[] = [];
  const seen = new Set<number>();
  for (let p = table.get(pid); p && !seen.has(p.pid) && chain.length < 16; p = table.get(p.ppid)) {
    seen.add(p.pid);
    chain.push(p);
  }
  return chain;
}

export type Ownership = { ours: true } | { ours: false; startedBy: string };

/** Whether MATLAB `pid` was started (directly or not) by process `ancestor`; else what started it. */
export function ownership(pid: number, ancestor: number, table: Map<number, ProcInfo>): Ownership {
  const chain = processChain(pid, table);
  if (chain.slice(1).some(p => p.pid === ancestor)) { return { ours: true }; }
  if (!chain.length) { return { ours: false, startedBy: 'an unknown process' }; }
  const starter = chain.find(p => !/^matlab(\.exe)?$/i.test(p.name));
  return { ours: false, startedBy: starter ? `${starter.name} (process ${starter.pid})` : 'a process that has ended' };
}

/** Parse "pid ppid name" lines (the output of processTable's commands). */
export function parseProcessTable(text: string): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*?)\s*$/.exec(line);
    if (m) { table.set(+m[1], { pid: +m[1], ppid: +m[2], name: m[3].replace(/^.*[\/]/, '') }); }
  }
  return table;
}

/** All processes with their parent (about 1 s on Windows). Empty when it cannot be read. */
export async function processTable(): Promise<Map<number, ProcInfo>> {
  const { execFile } = await import('child_process');
  const run = (cmd: string, args: string[]) => new Promise<string>(resolve =>
    execFile(cmd, args, { timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? ''))));
  const text = process.platform === 'win32'
    ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'])
    : await run('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
  return parseProcessTable(text);
}
