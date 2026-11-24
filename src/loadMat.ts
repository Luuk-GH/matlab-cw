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
 * A .mat file dropped from outside VS Code (Windows Explorer, a file manager): the webview gets its bytes but not its
 * path, so it is loaded from a temporary copy, which is deleted once load() has run.
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
