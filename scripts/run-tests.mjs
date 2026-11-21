// Bundles and runs the plain-Node test files. `unit`: pure logic and the MCP protocol/HTTP layer.
// `fake`: the session core and the real backend code against the fake MATLAB language server.
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = {
  unit: ['commandQueue', 'parsing', 'sections', 'signatures', 'foreignInput', 'sharedSession', 'connectorProxy'],
  fake: ['session', 'attach'],
};
const which = process.argv[2];
const names = suites[which];
if (!names) { console.error(`usage: run-tests.mjs ${Object.keys(suites).join('|')}`); process.exit(2); }
const esbuild = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
for (const n of names) {
  const out = path.join(root, 'dist', `${n}.test.js`);
  execFileSync(process.execPath, [esbuild, path.join(root, 'scripts', `${n}.test.ts`), '--bundle', '--platform=node',
    '--target=node20', `--outfile=${out}`, '--log-level=warning', '--external:vscode', '--external:../test/*'], { stdio: 'inherit' });
  execFileSync(process.execPath, [out], { stdio: 'inherit', cwd: root });
}
console.log(`${which}: ${names.length} test file(s) passed`);
