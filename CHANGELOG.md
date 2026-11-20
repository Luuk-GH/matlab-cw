# Changelog

## 0.1.0 (2026-11-20) — preview, not yet tested with real MATLAB

- Command Window webview attached to the MATLAB the official MATLAB extension runs (shared with
  `shareMATLABSession()`); no second MATLAB. Connect/disconnect, automatic reconnect when MATLAB is shared again.
- HTML output with links (`Error in … (line N)`, `Error using`, `File: … Line:`, paths, MATLAB hyperlinks), red errors,
  yellow warnings, collapsible long output, `clc`; CodeMirror input line with MATLAB highlighting, Enter / Shift+Enter,
  prefix-filtered history, completion from MATLAB, help tooltip, usage hint, Stop; `input()`, `pause` and `K>>` handled.
- Backend: a second instance of the official extension's language server in remote mode (`--matlabUrl`) behind a
  local relay that adds the connector's access key.
- Fake MATLAB language server and fake connector for automated tests; spike script for the first run with real MATLAB.
