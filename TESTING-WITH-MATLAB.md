# Testing with real MATLAB

**Nothing in this extension has run against real MATLAB yet.** All automated tests use a fake MATLAB
(`test/fake/fakeLanguageServer.js`) and a fake web connector (`test/fake/fakeConnector.js`). This checklist is for the
first person with MATLAB. Work top to bottom. For every failure, note the step number, what you saw, and copy the
**MATLAB Command Window** output (View → Output → *MATLAB Command Window*).

Setup: Windows, MATLAB R2023a or newer, VS Code with the official MATLAB extension (`MathWorks.language-matlab`),
MathWorks' MATLAB MCP Server Toolbox (via the MATLAB Agentic Toolkit), and
`matlab-command-window-community-0.1.0.vsix` installed (Extensions view → ⋯ → *Install from VSIX…*). Copy the files
from `test/workspace/` into a test folder and open it in VS Code.

Code locations: session file `src/backend/sharedSession.ts`; relay `src/backend/connectorProxy.ts`; language server
backend `src/backend/lsBackend.ts`; session state machine `src/matlabSession.ts`; VS Code glue `src/session.ts`;
Command Window `src/commandWindow/provider.ts` (extension side) and `src/commandWindow/webview/main.ts` (rendering,
links, input line).

## 0. Spike first (≈ 30 min)

- [ ] **0.1** Run the spike: `spike/README.md`. Send me `spike/results/spike-*.md` and `.json`.

If S1 (attach) fails, stop here and send the files: the attach route itself needs work.

## 1. Connecting

- [ ] **1.1** Open a `.m` file; the MATLAB extension starts MATLAB. Status bar shows `MATLAB CW` with a disconnected-plug icon.
- [ ] **1.2** Open the *MATLAB CW* panel **before** sharing → it says "No shared MATLAB session found…" with the
  `shareMATLABSession()` hint. Nothing hangs.
- [ ] **1.3** In the MATLAB extension's terminal run `shareMATLABSession()` → within ~3 s the panel says
  "Connecting…", then "Connected to MATLAB R20xx (process N), shared with the MATLAB extension." and a `>>` prompt.
  *If not:* Output → MATLAB Command Window (`[ls]` lines, `connector relay` lines). Code: `LsBackend.start`, `connectorProxy.ts`.
- [ ] **1.4** Task Manager: still **one** `MATLAB.exe` (plus the official one only). No new MATLAB window appeared.
- [ ] **1.5** The official MATLAB terminal still works while connected (type `1+1` there).
- [ ] **1.6** `a = 5` in our window, then `a` in the official terminal → `a = 5` (same workspace), and vice versa.
- [ ] **1.7** Note whether output of commands typed in the official terminal also appears in our window (spike A1).
- [ ] **1.8** *Disconnect* (panel title bar) → "Disconnected. MATLAB keeps running…"; the official terminal still works; `a` still exists. *Connect* → connected again.
- [ ] **1.9** Restart MATLAB from the official extension (or close and reopen VS Code) → our window says the connection
  ended; run `shareMATLABSession()` again → it reconnects by itself.
- [ ] **1.10** The official extension's own features still work while we are attached: Run (F5), Run Section, debugger, Workspace browser, linting.

## 2. Commands, output, errors

- [ ] **2.1** `x = magic(4)` → echoed as `>> x = magic(4)`, then the matrix, formatted as in MATLAB.
- [ ] **2.2** `y = q + 1` → `Unrecognized function or variable 'q'.` in **red**.
- [ ] **2.3** `warning('careful')` → `Warning: careful` in **yellow** (no stray `[` / `]`). *If not:* `WARNING_MARKS` in `lsBackend.ts`, spike S11.
- [ ] **2.4** `disp('héllo ü')` → accented characters correct.
- [ ] **2.5** `for k = 1:5, disp(k), pause(0.5), end` → numbers appear one by one (streaming).
- [ ] **2.6** Select output with the mouse and copy it (Ctrl+C with a selection copies, it does not interrupt).

## 3. Links

- [ ] **3.1** `run('error_demo.m')` → the message, then `Error in error_demo (line 3)` as a **link** that opens
  `error_demo.m` at line 3; the `Error in run (line …)` frame is hidden. *If not:* spike S9; `FRAME`, `HELPER_FRAME` in `webview/main.ts`, `anchors.ts`.
- [ ] **3.2** A file with `x = [1 2` → the parse error's `File: … Line: 1` part is a link.
- [ ] **3.3** An error inside a function file → `Error using …` / `Error in myfun (line N)` open the function file.
- [ ] **3.4** `which mean_of` → the printed path is a link.

## 4. Input line

- [ ] **4.1** Long output collapses: `for k = 1:100, disp(k), end` → *▸ Show all 100 lines*.
- [ ] **4.2** Shift+Enter adds a line; Enter runs the block: `a = 1;` Shift+Enter `b = a + 1` Enter → `b = 2`.
- [ ] **4.3** History: type `x` then ↑ → last command starting with `x`; ↓ back; Esc clears. History survives reloading the window.
- [ ] **4.4** Highlighting of keywords, `'…'` and `"…"` strings, `% comments`, numbers; `a'` is a transpose.
- [ ] **4.5** Completion: `s = struct('alpha', 1);` then `s.` + Ctrl+Space → `alpha`; `lins` + Tab → `linspace` (spike S14).
- [ ] **4.6** Hover `zeros` in the input line → usage lines and "Create array of all zeros" (spike S10; parser `src/language/helpText.ts`).
- [ ] **4.7** Type `linspace(` → the first usage form under the input line.
- [ ] **4.8** While MATLAB is busy (`pause(5)`), hover/completion do nothing and nothing hangs.
- [ ] **4.9** `clc` and the *Clear* button clear the window.

## 5. Prompts that must never hang

- [ ] **5.1** `run('ask_input.m')` → input line shows `Enter a number:`; type `7` → `You typed 7`; the echo shows the prompt once. *(spike S7/S8; `stdinEcho`)*
- [ ] **5.2** `s = input('Name: ', 's')` → `abc` → `s = 'abc'`.
- [ ] **5.3** `pause; disp('go')` → "Paused: press Enter to continue"; Enter → `go`.
- [ ] **5.4** `keyboard` → `K>>`; `dbcont` → `>>`.
- [ ] **5.5** Set a breakpoint with the **official** debugger (gutter) in `mean_of.m`, call `mean_of([1 2 3])` from our window → our prompt shows `K>>`; the official debug view opens too (same MATLAB). Step with the debugger; our window follows. `dbquit` → `>>`.
- [ ] **5.6** Stop: `run('long_loop.m')`, press **Stop** → `>>` within ~1 s; `n` still exists.
- [ ] **5.7** Stop while `input()` waits → back to `>>`.
- [ ] **5.8** Queue: `pause(3)`, then `disp(1)` and `disp(2)` while busy → after 3 s, `1` then `2`.
- [ ] **5.9** A long command started in the **official** terminal → our window shows busy and its Stop button interrupts it.

## 6. Robustness

- [ ] **6.1** Close VS Code while connected → MATLAB of the official extension is unaffected until it closes itself; no leftover `node`/language-server processes after ~10 s.
- [ ] **6.2** A MATLAB desktop (not the extension's) that ran `shareMATLABSession()` → our window connects to it (the most recently shared MATLAB wins).
- [ ] **6.3** Restricted Mode (untrusted folder) → "needs a trusted workspace", nothing connects.
- [ ] **6.4** Folder with spaces and non-ASCII characters → links still open.
- [ ] **6.5** `figure; plot(1:10)` from our window → figure appears; prompt returns.

## Still unverified (as of 0.1.0)

1. That the language server's `--matlabUrl` mode works against MATLAB's connector through our relay (S1), including the WebSocket transport.
2. That a second engine client can attach next to the official extension's, without disturbing it (A1, A2, 1.5, 1.10), including the `matlabls/connection/startup` message our instance sends.
3. Whether output of the official terminal's commands reaches our window (A1).
4. `shareMATLABSession()` reusing the existing connector key (so the official extension's connection keeps working).
5. The internal notification protocol (`RESEARCH.md` §2) and event order (S2–S4); feval shapes (S5).
6. K>> behaviour and fevals at K>> (S6, S13); `input()` prompt echo (S7, S8).
7. Error text, hyperlinks, warning markers (S9, S11, S22); the `run` frame filter.
8. Help text format and completion results in remote mode (S10, S14).
9. Interrupt latency (S12); multi-line eval (S17); figures (S21).
10. Behaviour after MATLAB restarts, VS Code closes, or several MATLABs are shared (1.9, 6.1, 6.2).
