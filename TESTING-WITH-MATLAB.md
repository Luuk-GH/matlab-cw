# Testing with real MATLAB

**Status (2026-11-20):** the spike passes on MATLAB R2026b with MATLAB extension 1.3.16 (attach, commands, output,
errors, input(), pause, K>>, interrupt, completion, help, figures, the session core end to end). **The Command Window
itself (the .vsix in VS Code) has not been tried with real MATLAB yet**: that is what sections 1–6 are for. All automated tests use a fake MATLAB
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

## 5b. Run from the editor

- [ ] **5b.1** In `error_demo.m` press **F5** → `>> run('…error_demo.m')` and the error appear in *MATLAB CW*; the
  official MATLAB terminal does **not** come to the front; the cursor stays in the editor. *If the terminal still
  runs it:* the MATLAB extension's own F5 binding won — check *Preferences: Open Keyboard Shortcuts*, search `f5`.
- [ ] **5b.2** Put the cursor in a `%%` section, **Ctrl+Enter** → `>> % file.m: section "…"` and only that section runs.
- [ ] **5b.3** Select a line, **Shift+Enter** → it runs in *MATLAB CW*.
- [ ] **5b.4** Turn off `matlabCommandWindow.runInCommandWindow` → F5 goes to the MATLAB terminal again.
- [ ] **5b.5** Type `run('ask_input.m')` in the **MATLAB terminal** → our window shows "MATLAB is waiting for input()…
  Answer it there", its input line does not switch to answering. Answer in the terminal; the output appears there.

## 6. Robustness

- [ ] **6.1** Close VS Code while connected → MATLAB of the official extension is unaffected until it closes itself; no leftover `node`/language-server processes after ~10 s.
- [ ] **6.2** A MATLAB desktop (not the extension's) that ran `shareMATLABSession()` → our window connects to it (the most recently shared MATLAB wins).
- [ ] **6.3** Restricted Mode (untrusted folder) → "needs a trusted workspace", nothing connects.
- [ ] **6.4** Folder with spaces and non-ASCII characters → links still open.
- [ ] **6.5** `figure; plot(1:10)` from our window → figure appears; prompt returns.

## Verified with the spike (R2026b, extension 1.3.16, 2026-11-20)

- Attaching works with the loader's fix (`src/backend/lsLoader.ts`, RESEARCH.md §8, 3a): connected in ≈ 1.3 s.
- Prompt states and event order (S2–S4), feval result and error shapes (S5), K>> and fevals at K>> (S6, S13),
  `input()` (S7; its prompt is not printed as output, S8), help/which text (S10), interrupt within ≈ 0.4 s (S12),
  completion (S14), streaming (S15), `pause` (S16), multi-line code (S17), `clc` (S18), figures (S21), the session
  core end to end (S24); MATLAB keeps running after we disconnect (A2).
- Errors arrive as plain text without hyperlinks, `feature('hotlinks')` is false in this session (S9, S22): links come
  from our own parsing of `Error in … (line N)`.
- Once, an interrupt was ignored (after a figure and a K>> round); a second one stopped MATLAB at once. The session now
  re-sends the interrupt after 2 s and 5 s while the same command still runs. Not reproducible in isolation.

## Verified with the integration tests on real MATLAB (`npm run test:real`, 41 checks, 2026-11-20)

Connecting, output, red errors without markers, yellow warnings, error links (clicking opens the file at the line),
the hidden `run()` frame, long output collapsing, history, completion (variables, struct fields), help tooltip, usage
hint, highlighting, `input()` answering, `keyboard`/`dbcont`, Stop, `clc`, Run File / Run Selection / Run Section
from the editor (the editor keeps the focus), an `input()` from another client left to that client (5b.5),
disconnect/reconnect. Passed 4 runs in a row with the official MATLAB extension attached to the same MATLAB.
Screenshots: `docs/screenshots/` (`npm run demo:screenshots`).

Added 2026-11-21 (48 checks, 3 runs in a row): signature help (`linspace(0, ` → `linspace(x1,x2,n)` with `x2`,
"Point interval"; `plot(` → `plot(Y,LineSpec,options)`, "1 of N", Alt+Down), Esc closes it before clearing the
line, output stays before the next echo, Run File echoes the script name. The real-MATLAB tests run on a temporary
copy of `test/workspace`, so breakpoints set on the project's files (seen: one in `long_loop.m`) do not stop them.

## Still unverified

1. The Command Window UI with real MATLAB: everything in sections 1–6.
2. That the official MATLAB terminal keeps working normally while we are attached (1.5). Seen by the user: output of
   the terminal's commands goes only to the terminal, but `input()` prompts reach every window, and an answer typed in
   either window is accepted (now handled: 5b.5).
3. Which F5/Ctrl+Enter/Shift+Enter binding wins against the MATLAB extension's own (5b.1); VS Code does not document
   the order between two extensions' bindings for the same key.
4. That the official extension's own features are undisturbed while we are attached (1.10).
5. Warning markers (S11 events recorded, not yet checked in the UI: 2.3).
6. Behaviour after MATLAB restarts, VS Code closes, or several MATLABs are shared (1.9, 6.1, 6.2).
8. A "ping" sound reported with Ctrl+Enter (Run Section) on a multi-section script. MATLAB's side is clean (no
   errors, no bell characters, normal prompts for multi-line sections); the source is not found yet.
7. Releases other than R2026b (the release decides the protocol version, see RESEARCH.md §8, 3a).
