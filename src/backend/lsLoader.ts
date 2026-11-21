// Runs the official MATLAB extension's language server with one small in-memory fix for --matlabUrl mode.
//
// [code, verified with MATLAB R2026b + MATLAB extension 1.3.16] In --matlabUrl mode the language server's
// RemoteMatlabSession never sets `matlabRelease`. The MVM layer picks its protocol implementation from that release
// (MVM._detectImpl), throws "No valid MATLAB release detected when trying to attach", and swallows the error: the
// Faye connection reports "connected" but the engine never becomes ready (no mvmStateChange 'connected').
//
// The loader reads the server bundle, sets `matlabRelease` from MCW_MATLAB_RELEASE in RemoteMatlabSession.initialize,
// and runs the patched bundle in place of the original (same file name, so its relative requires keep working).
// The installed extension's files are never modified. If the code to patch is not found (another extension version),
// the loader prints PATCH_MISSING_MARKER on stderr and runs the bundle unpatched; the backend then fails fast.
//
// It is run as `node -e LOADER_SOURCE <serverPath> <server args...>`, so no extra file has to ship.

export const PATCH_MISSING_MARKER = 'MCW_LOADER_PATCH_MISSING';

/**
 * The release the MVM layer is told in --matlabUrl mode when the real one cannot be read from the MATLAB process.
 * [code + verified] The release selects the protocol implementation (R2021b, R2022a, R2022b, or the default one) and,
 * in the default one, the API version: 23a -> r23a0, 23b -> r23b0, anything else -> r24a0. R2026b accepts only
 * r24a0 or v7_0 (it refused r23a0), so a wrong guess fails. R2024a or newer all map to r24a0.
 * The backend asks MATLAB for its real release once connected.
 */
export const FALLBACK_RELEASE = 'R2024a';

export const LOADER_SOURCE = `
const fs = require('fs'), path = require('path'), Module = require('module');
const serverPath = path.resolve(process.argv[1]);
process.argv = [process.argv[0], serverPath, ...process.argv.slice(2)];
let src = fs.readFileSync(serverPath, 'utf8');
const anchor = /(class RemoteMatlabSession extends AbstractMatlabSession\\s*\\{\\s*initialize\\s*\\(\\s*matlabConnection\\s*\\)\\s*\\{)/;
if (anchor.test(src)) {
  src = src.replace(anchor, '$1 this.matlabRelease = process.env.MCW_MATLAB_RELEASE || null;');
} else {
  process.stderr.write('${PATCH_MISSING_MARKER}\\n');
}
const m = new Module(serverPath, null);
m.filename = serverPath;
m.paths = Module._nodeModulePaths(path.dirname(serverPath));
process.mainModule = m;
require.main = m;
m._compile(src, serverPath);
`;
