# Changelog

## 0.2.1 (2026-11-24)

- Run Selection (Shift+Enter) adds the selected code to the Command History, like MATLAB's Evaluate Selection.
- Ctrl+Enter and Shift+Enter run in the Command Window also while debugging (at K>>, in the stopped workspace);
  before, they went to the MATLAB terminal. F5 is left to the debugger (*Continue*).
- Dropping `.mat` files works: VS Code blocked the drop. From Windows Explorer it now works directly (loaded from a
  temporary copy, as the webview gets no path); from the VS Code Explorer hold **Shift** while dropping (VS Code's
  rule for webviews), or right-click → *Load into MATLAB Command Window*.

## 0.2.0 (2026-11-24)

- Connects only to the MATLAB that the MATLAB extension in the same VS Code window started (its process descends
  from this window's extension host). A MATLAB that another client shared is refused with a message, instead of being
  followed: seen when MathWorks' MCP server started its own MATLAB after the shared one ended, and the Command Window
  silently switched to it.
- Command History pop-up on ↑, like MATLAB's: filtered by what is typed, `2x` for repeats, Shift+↑/↓ selects several,
  Enter runs, → puts on the line (setting `matlabCommandWindow.historyPopup`; off: inline recall as before). Repeated
  commands are now kept in the history.
- File and folder completion for arguments that MATLAB's function signatures declare as paths (`load('`, `cd `,
  `addpath('`, `readtable('`, …), from MATLAB's own completion data; accepting a folder lists its contents.
- Queued commands are shown (dimmed, *queued*) until they run; × drops one, Stop drops all.
- Drop a `.mat` file on the Command Window to load it.
- The MATLAB Workspace view is put beside the Command Window in the panel once (setting
  `matlabCommandWindow.workspaceBesideCommandWindow`).
- Long output is no longer collapsed by default (setting `matlabCommandWindow.collapseLongOutput`).
- `run` frames are also removed from warning backtraces (`In run (line 100)` without `>`).
- The cursor is visible: it was a 0.8 px black line on dark themes. A click anywhere in the window puts it in the
  input line.

## 0.1.0 (2026-11-20) — preview; spike passes on R2026b, Command Window UI not yet tested with real MATLAB

- Command Window webview attached to the MATLAB the official MATLAB extension runs (shared with
  `shareMATLABSession()`); no second MATLAB. Connect/disconnect, automatic reconnect when MATLAB is shared again.
- HTML output with links (`Error in … (line N)`, `Error using`, `File: … Line:`, paths, MATLAB hyperlinks), red errors,
  yellow warnings, collapsible long output, `clc`; CodeMirror input line with MATLAB highlighting, Enter / Shift+Enter,
  prefix-filtered history, completion from MATLAB, help tooltip, usage hint, Stop; `input()`, `pause` and `K>>` handled.
- Backend: a second instance of the official extension's language server in remote mode (`--matlabUrl`) behind a
  local relay that adds the connector's access key.
- First real run (R2026b): the connection worked but the engine never became ready, because the language server's
  `--matlabUrl` mode never sets the MATLAB release. Fixed in memory by a small loader (`src/backend/lsLoader.ts`);
  attaching now fails within seconds, with a clear message, instead of after 2 minutes. The release is read from the
  MATLAB process (it also selects the engine protocol version). The spike now passes on R2026b.
- Run File (F5), Run Section (Ctrl+Enter) and Run Selection (Shift+Enter) in `.m` files run in the Command Window
  instead of the MATLAB extension's terminal, keeping the focus in the editor (setting
  `matlabCommandWindow.runInCommandWindow`).
- An `input()`/`pause` started from another window (the MATLAB terminal) no longer takes over the Command Window's
  input line: MATLAB sends those prompts to every window but the output only to the one that started the command.
- Extension icon (a surface plot with a small LP record) and name without "(community)": the extension id is now
  `matlab-command-window` (uninstall the old `matlab-command-window-community`; its command history is not carried over).
- `input()` from a script run with F5 / Ctrl+Enter no longer jumps to the MATLAB terminal about half the time: the
  MATLAB extension's terminal also reveals itself on the INPUT state; the Command Window now takes the panel back.
- At a breakpoint the Command Window stays in front: the MATLAB extension shows its MATLAB terminal when its
  debugger starts; the Command Window takes the panel back (`matlabCommandWindow.runInCommandWindow`).
- More robust with other setups: the release is also read from `VersionInfo.xml` when the MATLAB folder's name does
  not contain it; a MATLAB extension version where the in-memory fix does not apply is tried anyway (it may have
  fixed the bug) instead of being refused. Simpler backend: attach mode only (the unused local-launch mode is gone).
- Signature help like the editor's parameter hints: MATLAB's own function forms with the current argument, its
  purpose and allowed values (from `matlabls.internal.getCompletions` of the MATLAB extension); Alt+Up/Down for
  other forms. Run File shows the script name instead of `run('<full path>')`.
- Fixed on real MATLAB: a late READY could finish the next command before its output arrived (output appeared after
  the next echo); after `dbcont` the session treated MATLAB as idle while the resumed command still ran.
- Fixed after testing on real MATLAB (R2026b): error text showed MATLAB's `{\b … }\b` markers; the hidden `run()`
  frame left its code and `^^^` lines behind; the `input()` prompt text was lost (MATLAB sends it as an array); the
  window stayed "busy" after a command started elsewhere; `keyboard` right after an `input()` answer could hang
  (MATLAB skipped the BUSY state); clicking an error link failed while another client briefly kept MATLAB busy.
- Stop re-sends the interrupt after 2 s and 5 s if the same command is still running (MATLAB ignored one once).
- Shorter waits: connecting gives up after 20 s (engine: 10 s after the connection is up); the spike bounds every
  step and stops after 4 minutes at most, cleaning up its path entries and never leaving MATLAB at K>>.
- Fake MATLAB language server and fake connector for automated tests; spike script for the first run with real MATLAB.
