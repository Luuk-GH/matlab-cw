// Launches a separate VS Code instance (own user-data-dir and extensions-dir) as Extension Development Host and runs
// dist/integration.test.js inside it. The "shared MATLAB" is the fake connector (test/fake/fakeConnector.js, which
// writes a session file like shareMATLABSession()) and the fake language server. Works while your normal VS Code is open.
//
// --real: against the real MATLAB shared with shareMATLABSession() (its real session file) and the installed official
// MATLAB extension's language server. Changes that MATLAB's workspace while it runs; restores its current folder.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(os.tmpdir(), 'mcw-it-vscode');
const resultFile = path.join(base, 'result.txt');
fs.mkdirSync(base, { recursive: true });
fs.rmSync(resultFile, { force: true });
fs.rmSync(path.join(base, 'user-data'), { recursive: true, force: true });

const codeExe = process.env.VSCODE_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const args = [
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(root, 'dist', 'integration.test.js')}`,
  `--user-data-dir=${path.join(base, 'user-data')}`,
  `--extensions-dir=${path.join(base, 'extensions')}`,
  '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
  path.join(root, 'test', 'workspace'),
];
const real = process.argv.includes('--real');
let connector;
let env;
if (real) {
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  const official = fs.existsSync(extDir) && fs.readdirSync(extDir).filter(d => /^mathworks\.language-matlab-\d/.test(d)).sort().pop();
  if (!official) { console.error('The official MATLAB extension is not installed.'); process.exit(2); }
  env = { ...process.env, MCW_IT_RESULT: resultFile, MCW_IT_REAL: '1', MCW_TRACE: '1',
    MCW_LANGUAGE_SERVER: path.join(extDir, official, 'server', 'out', 'index.js') };
  delete env.MCW_SESSION_FILE;
  console.log(`real MATLAB, language server of ${official}`);
} else {
  const sessionFile = path.join(base, 'session', 'sessionDetails.json');
  fs.rmSync(sessionFile, { force: true });
  connector = spawn(process.execPath, [path.join(root, 'test', 'fake', 'fakeConnector.js'), sessionFile], { stdio: 'inherit' });
  for (let i = 0; i < 50 && !fs.existsSync(sessionFile); i++) { await new Promise(r => setTimeout(r, 100)); }
  env = {
    ...process.env,
    MCW_IT_RESULT: resultFile,
    MCW_SESSION_FILE: sessionFile,
    MCW_LANGUAGE_SERVER: path.join(root, 'test', 'fake', 'fakeLanguageServer.js'),
    MCW_FAKE_STARTUP_MS: '200',
  };
}
delete env.ELECTRON_RUN_AS_NODE;   // would make Code.exe behave like node
const child = spawn(codeExe, args, { stdio: 'inherit', env });
child.on('exit', code => {
  connector?.kill();
  const out = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '(no result file written)\n';
  process.stdout.write('\n' + out);
  process.exit(code ?? 1);
});
