// Unit checks for finding the session shared with shareMATLABSession(). Run: npm run test:unit
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ownership, parseProcessTable, processChain, processTable, readSharedSession, releaseFromInstall, releaseFromPath, sessionFilePath } from '../src/backend/sharedSession';

assert.strictEqual(releaseFromPath('C:\\Program Files\\MATLAB\\R2026b\\bin\\win64\\MATLAB.exe\r\n'), 'R2026b');
assert.strictEqual(releaseFromPath('/usr/local/MATLAB/R2024a/bin/glnxa64/MATLAB'), 'R2024a');
assert.strictEqual(releaseFromPath('/Applications/MATLAB_R2025b.app/bin/maca64/MATLAB'), 'R2025b');
assert.strictEqual(releaseFromPath('/Applications/R2025b.app/bin/maca64/MATLAB'), 'R2025b');
assert.strictEqual(releaseFromPath('D:\\tools\\matlab\\bin\\win64\\MATLAB.exe'), null);
assert.strictEqual(releaseFromPath(''), null);

// Locations ([code] DefaultAppDataLocator.m of the MATLAB MCP Server Toolbox).
assert.strictEqual(sessionFilePath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'),
  path.join('C:\\Users\\u\\AppData\\Roaming', 'MathWorks', 'MATLAB MCP Server', 'v1', 'sessionDetails.json'));
assert.strictEqual(sessionFilePath({ HOME: '/home/u' }, 'linux'), path.join('/home/u', '.MathWorks', 'MATLABMCPServer', 'v1', 'sessionDetails.json'));
assert.strictEqual(sessionFilePath({ HOME: '/Users/u' }, 'darwin'), path.join('/Users/u', 'Library', 'Application Support', 'MathWorks', 'MATLAB MCP Server', 'v1', 'sessionDetails.json'));
assert.strictEqual(sessionFilePath({ MCW_SESSION_FILE: 'x.json', APPDATA: 'y' }, 'win32'), 'x.json');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-session-'));
const file = path.join(dir, 'sessionDetails.json');
const write = (v: unknown) => fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));

let r = readSharedSession(file);
assert.ok(!r.ok && r.reason === 'missing');

write('not json');
r = readSharedSession(file);
assert.ok(!r.ok && r.reason === 'invalid');

write({ port: 31515, certificate: 'C:\\cert.pem' });
r = readSharedSession(file);
assert.ok(!r.ok && r.reason === 'invalid', 'apiKey required');

// jsonencode(..., PrettyPrint=true) output, written with a BOM by some MATLAB writelines versions.
write('\uFEFF{\n  "port": 31515,\n  "certificate": "C:\\\\Users\\\\u\\\\cert.pem",\n  "apiKey": "abc",\n  "pid": 4242,\n  "basePath": "/"\n}');
r = readSharedSession(file, pid => pid === 4242);
assert.ok(r.ok, JSON.stringify(r));
if (r.ok) {
  assert.strictEqual(r.session.port, 31515);
  assert.strictEqual(r.session.certificate, 'C:\\Users\\u\\cert.pem');
  assert.strictEqual(r.session.apiKey, 'abc');
  assert.strictEqual(r.session.pid, 4242);
  assert.strictEqual(r.session.basePath, '/');
}
r = readSharedSession(file, () => false);
assert.ok(!r.ok && r.reason === 'stale', 'MATLAB process gone');

// An installation folder without the release in its name: matlabroot/VersionInfo.xml tells it.
const root = path.join(dir, 'MATLAB', 'current');
fs.mkdirSync(path.join(root, 'bin', 'win64'), { recursive: true });
fs.writeFileSync(path.join(root, 'VersionInfo.xml'), '<?xml version="1.0"?>\n<MathWorks_version_info>\n  <version>26.2.0</version>\n  <release>R2026b</release>\n</MathWorks_version_info>\n');
assert.strictEqual(releaseFromInstall(path.join(root, 'bin', 'win64', 'MATLAB.exe') + '\r\n'), 'R2026b');
assert.strictEqual(releaseFromInstall(path.join(dir, 'elsewhere', 'matlab')), null);

fs.rmSync(dir, { recursive: true, force: true });
console.log('sharedSession: all assertions passed');

// ---- ownership: only the MATLAB the MATLAB extension in this VS Code window started (incident of 23-11-2026) ----
{
  const t = parseProcessTable([
    '100 1 Code.exe',              // extension host (process.pid)
    '200 100 node.exe',            // the official language server
    '300 200 MATLAB.exe',          // its MATLAB launcher
    '35272 300 MATLAB.exe',        // the user's MATLAB
    '70808 9 matlab-mcp-server.exe',
    '94380 70808 MATLAB.exe',      // started by the MCP server when the shared one was gone
    '60740 94380 MATLAB.exe',
    '777 1 MATLAB.exe',            // a MATLAB desktop / another window
    '5 6 a', '6 5 b',              // a loop (reused process ids)
    '',
    '  42   41 /usr/local/MATLAB/R2024a/bin/glnxa64/MATLAB',
  ].join('\r\n'));
  assert.deepStrictEqual(ownership(35272, 100, t), { ours: true });
  assert.deepStrictEqual(ownership(300, 100, t), { ours: true });
  assert.deepStrictEqual(ownership(60740, 100, t), { ours: false, startedBy: 'matlab-mcp-server.exe (process 70808)' });
  assert.deepStrictEqual(ownership(777, 100, t), { ours: false, startedBy: 'a process that has ended' });
  assert.deepStrictEqual(ownership(12345, 100, t), { ours: false, startedBy: 'an unknown process' });
  assert.deepStrictEqual(ownership(100, 100, t), { ours: false, startedBy: 'Code.exe (process 100)' }, 'the host itself is not a MATLAB it started');
  assert.strictEqual(processChain(5, t).length, 2, 'stops at a loop');
  assert.strictEqual(t.get(42)?.name, 'MATLAB', 'name without its folder');
}
// processTable reads the real process list: this process and its parent are in it.
(async () => {
  const t = await processTable();
  assert.ok(t.get(process.pid)?.ppid === process.ppid, `own process in the table (${t.size} processes)`);
})().catch(e => { console.error(e); process.exit(1); });
