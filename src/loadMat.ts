// Load .mat files into the shared MATLAB, as if `load('file.mat')` was typed in the Command Window: dropped on the
// Command Window, or "Load into MATLAB Command Window" on .mat files in the Explorer.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionManager } from './session';
import { matlabString } from './sessionText';

const isMat = (p: string) => /\.mat$/i.test(p);

/** Load the .mat files among `uris` (others are ignored); false when there were none. */
export function loadMatFiles(session: SessionManager, uris: vscode.Uri[]): boolean {
  const files = uris.filter(u => u.scheme === 'file' && isMat(u.fsPath));
  for (const f of files) { void session.execute(`load(${matlabString(f.fsPath)})`).catch(() => undefined); }
  return files.length > 0;
}

/**
 * A .mat file dragged from outside VS Code (Windows Explorer): the webview gets its name, size and date but not its
 * path. Look for that file (same name, size and modification time) in the workspace folders, MATLAB's current folder
 * and the user's Desktop, Downloads and Documents; its path when found.
 */
export async function findDroppedFile(session: SessionManager, name: string, size: number, lastModified: number): Promise<string | undefined> {
  const base = path.basename(name);
  if (!isMat(base)) { return undefined; }
  const same = async (file: string) => {
    try {
      const st = await fs.promises.stat(file);
      return st.isFile() && st.size === size && Math.abs(st.mtimeMs - lastModified) < 2000;
    } catch { return false; }
  };
  const home = os.homedir();
  const pwd = (await session.queryText('pwd', [], true, 2000))?.trim();
  const folders = [pwd, path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(home, 'Documents'),
    path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'OneDrive', 'Documents')];
  for (const dir of folders) {
    if (dir && await same(path.join(dir, base))) { return path.join(dir, base); }
  }
  const glob = `**/${base.replace(/[[\]{}*?!]/g, '[$&]')}`;
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const hits = await vscode.workspace.findFiles(new vscode.RelativePattern(f, glob), null, 200);
    for (const h of hits) { if (await same(h.fsPath)) { return h.fsPath; } }
  }
  return undefined;
}

/**
 * Not found (findDroppedFile) and the user chose to load a copy: the bytes go to a temporary file, which is deleted
 * once load() has run.
 */
export async function loadMatBytes(session: SessionManager, name: string, bytes: Uint8Array): Promise<boolean> {
  const base = path.basename(name);
  if (!isMat(base)) { return false; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcw-drop-'));
  const file = path.join(dir, base);
  try {
    await fs.promises.writeFile(file, bytes);
    await session.execute(`load(${matlabString(file)})`);
  } finally {
    void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return true;
}
