// Unit checks for finding the session shared with shareMATLABSession(). Run: npm run test:unit
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSharedSession, sessionFilePath } from '../src/backend/sharedSession';

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

fs.rmSync(dir, { recursive: true, force: true });
console.log('sharedSession: all assertions passed');
