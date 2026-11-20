import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const OFFICIAL_EXTENSION_ID = 'MathWorks.language-matlab';

export interface ServerLocation {
  path: string;
  source: 'setting' | 'official extension' | 'environment';
  version?: string;
}

/**
 * Find the MATLAB language server to run: `matlabCommandWindow.languageServerPath`, else the one inside the installed
 * official MATLAB extension (`server/out/index.js`). MCW_LANGUAGE_SERVER (tests) wins over both.
 */
export function resolveServer(setting: string): ServerLocation {
  const env = process.env.MCW_LANGUAGE_SERVER;
  if (env) { return { path: env, source: 'environment' }; }
  if (setting.trim()) {
    const p = setting.trim();
    if (!fs.existsSync(p)) { throw new Error(`matlabCommandWindow.languageServerPath does not exist: ${p}`); }
    return { path: p, source: 'setting' };
  }
  const ext = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
  if (ext) {
    const p = path.join(ext.extensionPath, 'server', 'out', 'index.js');
    if (fs.existsSync(p)) { return { path: p, source: 'official extension', version: String(ext.packageJSON?.version ?? '') }; }
    throw new Error(`The MATLAB extension is installed, but its language server was not found at ${p}.`);
  }
  throw new Error('MATLAB Command Window needs the official MATLAB extension (MathWorks.language-matlab): it uses its language server to connect. ' +
    'Install it, or set matlabCommandWindow.languageServerPath.');
}

export function describeServer(s: ServerLocation): string {
  if (s.source === 'official extension') { return `the MATLAB extension's language server${s.version ? ` ${s.version}` : ''}`; }
  return `the language server at ${s.path}`;
}
