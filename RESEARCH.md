# Research: driving an interactive MATLAB session from a VS Code extension (Windows)

> **Update (2026-11-20, scope change):** the extension is now *only* a Command Window that **attaches to the MATLAB the
> official extension already runs** — no second MATLAB, no Workspace view, Run commands or MCP server (MathWorks'
> extension and Agentic Toolkit cover those). The chosen design is in **§8**; §1–§7 are the original research, kept
> for the reasoning (their recommendation of a separate MATLAB is superseded).

Date: 2026-11-20. Sources: the MathWorks repositories `mathworks/MATLAB-extension-for-vscode` and
`mathworks/MATLAB-language-server` (both **v1.3.16, 2026-11-12, MIT licence**), `matlab/matlab-mcp-core-server`
(BSD-style), `mathworks/matlab-proxy` and `mathworks/jupyter-matlab-proxy` (MathWorks reference-architecture licence),
and MathWorks documentation as far as it is known to me. **No MATLAB was available**: nothing below was run against
MATLAB. Statements marked *(docs)* come from documentation, *(code)* from reading the open-source code, *(guess)* are
inferences that the spike must check.

## 1. What the official MATLAB extension already does (v1.3.16)

Read from its `CHANGELOG.md`, `package.json` and source *(code)*:

| Feature | Official extension | Consequence for this project |
|---|---|---|
| MATLAB terminal (pseudoterminal, highlighting since 1.3.13, yellow warnings, Ctrl+C, history, Tab completion) | yes | Our Command Window must add what a terminal can't: HTML output, links, collapsible output, completion pop-up, hover help. |
| Run File (F5), Run Section (Ctrl+Enter), Run Selection (Shift+Enter), Interrupt (Ctrl+C) | yes, in its own MATLAB | Our run commands run in *our* session. **No default keybindings that clash** (see §6). |
| Debugger (breakpoints, stepping, variables), Pause button | yes (`matlab` debug type) | **Do not build a debug adapter.** Our session still shows `K>>` when code stops (e.g. `keyboard`, `dbstop`). |
| Workspace browser (`workspaceBrowserSidebarView`, rename/sort/delete, since 1.3.12) and Variable viewer (1.3.14) | yes, for **its** MATLAB | Our Workspace view is still needed: it is the only view of *our* session's variables (different process). Named "Companion Workspace" to avoid confusion. |
| Test explorer, projects, `edit`/`open` in VS Code, `clc`, `input` prompt | yes | `edit` integration is a later nice-to-have for us. |
| Public extension API for other extensions | **no** (`activate` returns `void`) | We cannot borrow its MATLAB session (see §4). |

So the gap this project fills: a richer Command Window, a Workspace view of the same session, Run commands into that
session, and an MCP server so AI agents share it.

## 2. How the official extension talks to MATLAB *(code)*

1. The extension starts the **MATLAB language server** (`server/out/index.js`, Node) with node IPC.
2. The language server launches MATLAB (`MatlabSession.ts`):
   `matlab.exe -log -memmgr release -noAppIcon -nosplash -r "<cd + addpath + initmatlabls(outFile)>" -nodesktop -noDisplayDesktop -wait [-sd folder] [-licmode file]`.
   On Windows `-noDisplayDesktop` is MathWorks' workaround for the console window that `-nodesktop` would open.
3. Inside MATLAB, `initmatlabls.m` starts a *communication manager* (`+matlabls/+internal/CommunicationManager.p`,
   P-code) on top of MATLAB's built-in connector, writes `{pid, port, certFile, release}` to `outFile`, adds
   shadows of `clc`, `edit`, `input` and `restoredefaultpath`, and starts a 5-minute "exit if nobody connects" timer.
4. The server connects through `MatlabCommunicationManager.js` (minified) and an **MVM** layer (`src/mvm/impl/MVM.js`,
   obfuscated). `MVMServer.ts` exposes the MVM to the extension as **plain JSON-RPC notifications**:

| Direction | Notification | Payload |
|---|---|---|
| client → server | `matlab/request` | – (start MATLAB when the connection timing is `onDemand`) |
| client → server | `evalRequest` | `{requestId, command, isUserEval, capabilitiesToRemove?}` |
| client → server | `fevalRequest` | `{requestId, functionName, nargout, args, isUserEval, capabilitiesToRemove?}` |
| client → server | `interruptRequest`, `unpauseRequest` | – |
| client → server | `setBreakpointRequest` / `clearBreakpointRequest` | `{requestId, fileName, lineNumber, condition?}` |
| client → server | `TerminalCompletionRequest` | `{requestId, code, offset}` (MATLAB's own completion engine) |
| server → client | `evalResponse` / `fevalResponse` | `{requestId}` / `{requestId, result}` (result may be an `MVMError` `{error:{id,msg}}`) |
| server → client | `text` | `{text, stream}` – stream 0 = stdout, otherwise stderr; warnings start with `[\b` |
| server → client | `mvmPromptChange` | `{state, isIdle}` – state ∈ INITIALIZING, READY, BUSY, DEBUG, INPUT, PAUSE, MORE, COMPLETING_BLOCK |
| server → client | `mvmInputPrompt` | the prompt string of `input()` |
| server → client | `clc`, `DebuggingStateChange` (boolean), `mvmStateChange` `{state: connected/disconnected, release}` |
| server → client | `TerminalCompletionResponse` | `{requestId, result}` |
| server → client | `matlab/connection/update/server`, `matlab/launchfailed` | connection status / launch errors |

   The official terminal answers `input()` by sending the typed line as another `evalRequest` while the state is
   INPUT, and a PAUSE state (from `pause` with no argument) with `unpauseRequest`.
5. The language server is a standalone program with documented command-line flags (`--stdio | --node-ipc | --socket`,
   `--matlabInstallPath`, `--matlabConnectionTiming onStart|onDemand|never`, `--matlabLaunchCommandArgs`,
   `--matlabUrl`, `--indexWorkspace`). Other editors (Neovim, Sublime, Emacs) run it the same way.

## 3. Candidates

| | A. Our own copy of the MathWorks language server (MVM notifications) | B. MATLAB-side server (`matlab -r` script + `tcpserver`/Java socket + `evalc`) | C. MATLAB Engine API (Python `matlab.engine`; Java similar) | D. Borrow the official extension's session |
|---|---|---|---|---|
| Streaming output | **yes**, `text` events while code runs *(code)* | no with `evalc` (output only at the end); `diary`/`-logfile` tailing is possible but laggy and mixes in everything *(guess)* | no: `eval(..., stdout=StringIO)` fills the buffer when the call returns *(docs)* | – |
| Idle / busy | `mvmPromptChange` READY/BUSY *(code)* | our loop knows *(design)* | future `done()` *(docs)* | – |
| `input()` | INPUT state + `mvmInputPrompt`; answer with `evalRequest` *(code)* | needs our own `input` shadow that asks over the socket | no stdin; `input` blocks or errors *(guess)* | – |
| `keyboard` / `K>>` | DEBUG state; evals run in the debug frame *(code; frame semantics: guess)* | nested `K>>` reads the hidden console: **hangs** the loop | no | – |
| Interrupt | `interruptRequest` *(code)* | `GenerateConsoleCtrlEvent` into MATLAB's console (like the Octave helper) *(guess)* | `FutureResult.cancel()` (only between statements?) *(docs/guess)* | – |
| Breakpoints | `setBreakpointRequest` or `dbstop` | `dbstop` works but stopping hangs the loop | no | – |
| Completion | `TerminalCompletionRequest` = MATLAB's own engine *(code)* | `who`/`fieldnames`/`which` helpers | same helpers | – |
| Startup time | MATLAB start (≈10–40 s) + connector *(guess)* | MATLAB start | MATLAB start; `connect_matlab` to a shared session is fast | – |
| Versions | R2021b+ for MVM features (extension requirement) *(docs/code: release gate in extension)* | any with Java (pre-R2025a) or `tcpserver` (R2021a+) | Python engine ships per release; Python version must match the release's supported list *(docs)* | – |
| Extra installs | none beyond the official extension (we run its `server/out/index.js`) | none | `pip install matlabengine==<release>` + a matching Python | – |
| Licensing | normal MATLAB licence; the language server can show MathWorks sign-in if MATLAB is not activated *(code)* | normal | normal | – |
| Stability risk | the notification names are **internal** between the server and the official extension; they may change in any release. Mitigated by using the server that ships with the installed official extension and a version check | only documented MATLAB functions | documented API | **Not possible**: no extension API, the language server talks only to its own client over private IPC |
| Second MATLAB process | yes (one for the official extension, one for us) | yes | yes, unless the user runs `matlab.engine.shareEngine` in their desktop MATLAB | – |

Also considered:
- **MathWorks MCP server** (`matlab-mcp-core-server`, Go): starts or attaches to MATLAB through MATLAB's embedded
  connector (`shareMATLABSession()` in a running MATLAB, R2023a+). It gives agents a MATLAB, but not *the* session the
  user sees in VS Code, and no Command Window. Possible interop: run `shareMATLABSession()` in our session so the
  official MCP server attaches to it — listed as an option, not built.
- **matlab-proxy / Jupyter MATLAB kernel**: use the same embedded connector over HTTP (`/messageservice/json/secure`,
  `FEvalRequest`). Undocumented internals with a restrictive repository licence; no advantage over A.
- **C++ Engine**: needs a compiler; unsigned binaries are blocked by Smart App Control on this PC (see the Octave
  spike). Rejected.

## 4. Can we avoid a second MATLAB process?

Not with the official extension as it is: it exposes no API, and its language server accepts exactly one client over
node IPC. Options for the user:
- accept two processes (default; memory cost ≈ 1–2 GB);
- set the official extension's `MATLAB.matlabConnectionTiming` to `onDemand`/`never`, which delays or disables its
  MATLAB (losing the features that need MATLAB there: linting details, its terminal, debugger, Workspace browser);
- later: ask MathWorks for an extension API (an issue on `mathworks/MATLAB-extension-for-vscode`), then add a backend
  that uses it. The backend interface (`src/backend/types.ts`) is designed so that this is a new class, not a rewrite.

## 5. Recommendation

**Candidate A.** Spawn our own instance of the MathWorks language server that ships with the installed official
extension (`<extension>/server/out/index.js`, launched with `--node-ipc --matlabConnectionTiming=onDemand`), and talk
to it with a small hand-written JSON-RPC client using only the MVM notifications above. It is the only option with
streaming output, real prompt states (including INPUT, DEBUG and PAUSE), interrupt and MATLAB's own completion, it is
what MathWorks itself uses on Windows (hidden window handled), and it needs no extra installs. Nothing is copied from
MathWorks: we run the user's installed copy. A setting (`matlabCompanion.languageServerPath`) can point to another
copy; the automated tests point it to the fake.

Risks and how the design contains them:
- The notification protocol is internal → one file (`src/backend/lsBackend.ts`) knows it; the fake
  (`test/fake/fakeLanguageServer.js`) documents every assumption; the spike checks each one.
- Semantics we could not read from code (does a hidden `feval` change the prompt state? in which workspace does
  `feval` run at `K>>`? exact error text) → the session core does not depend on them more than necessary (jobs finish
  on their response *or* the next idle prompt), and the spike measures them.
- Fallback if the spike fails: candidate B (MATLAB-side socket server with an `input` shadow and
  `GenerateConsoleCtrlEvent` interrupt) behind the same interface. The MATLAB helper functions are already plain
  functions returning JSON, usable by B unchanged.

## 6. Coexisting with the official extension

- Language id: we contribute **no language**; everything keys on the official `matlab` id (`editorLangId == matlab`).
- Commands: all ours are `matlabCompanion.*`; the official ones are `matlab.*` (runFile, runSection, runSelection,
  interrupt, openCommandWindow, wsb.*, ...).
- Keybindings: the official extension binds F5, Ctrl+Enter, Shift+Enter and Ctrl+C in MATLAB editors, and Delete/F2/Ctrl+D
  in its Workspace view. We bind **only F9** (Run Selection in the companion session; unused by the official extension,
  and MATLAB's own desktop key for it) and Delete in *our* Workspace view. README explains how to move F5/Ctrl+Enter
  to the companion with user keybindings.
- Views: our activity-bar container and panel use our own ids; our Workspace view is titled "Companion Workspace".
- Debug type, language server, grammar: none contributed.

## 7. Getting real MATLAB for testing (your choice)

1. **A PC with MATLAB** (R2021b or newer) and the official extension installed: run the spike (`spike/README.md`,
   ≈ 30 min), then `TESTING-WITH-MATLAB.md`. Best option; everything can be checked.
2. **MATLAB trial licence on this PC** (30 days, mathworks.com/campaigns/products/trials.html): same as 1, and lets
   me iterate directly. Note Smart App Control is on here; MATLAB is signed, so that should be fine *(guess)*.
3. **GitHub Actions with `matlab-actions/setup-matlab`**: free for public repositories, but the automatic licence is a
   *batch* licence for `matlab-batch` / `matlab -batch` (non-interactive) *(docs)*. The language server launches
   MATLAB with `-r`/`-nodesktop`, which that licence does not cover *(guess)*, so CI can at most check that our MATLAB
   helper functions parse and return the right JSON (`matlab -batch "run('spike/helpers_selftest.m')"`), not the
   interactive session.

## 8. Attaching to the existing MATLAB (the chosen design)

Read from code, not run against MATLAB:

1. **`shareMATLABSession()`** (MathWorks' *MATLAB MCP Server Toolbox* 0.5.0, installed by the MATLAB Agentic Toolkit or
   `matlab-mcp-server --setup-matlab`; R2023a+) calls `connector.ensureServiceOn()` and writes
   `{port: connector.securePort(), certificate: connector.getCertificateLocation(), apiKey, pid, basePath}` to
   `%APPDATA%\MathWorks\MATLAB MCP Server\v1\sessionDetails.json` (macOS: `~/Library/Application Support/MathWorks/MATLAB MCP Server`,
   Linux: `~/.MathWorks/MATLABMCPServer`). The API key is MATLAB's existing connector key
   (`connector.internal.getConfig("apiKey")`); a new one is generated only when none is set, so sharing should not
   disturb the official extension's own connection *(code; must be checked: S1/A2)*.
2. **The language server's engine client** (`MatlabCommunicationManager.js` + `MVM.js`) is a Faye/Bayeux client. For a
   MATLAB it launches itself it connects to `https://localhost:<port>/messageservice/async` with header `mwapikey` and
   the connector certificate as CA. Its **`--matlabUrl`** mode ("connect to an existing MATLAB") opens a plain Faye
   client on the given URL — no key, no CA — and publishes `matlabls/connection/startup`. The engine (`MVM`) and all MVM
   notifications (§2) work the same in both modes; on shutdown the remote session only closes the connection
   (`RemoteMatlabSession.shutdown`), it never quits MATLAB *(code)*.
3. **So:** this extension reads the session file, starts a relay on `127.0.0.1` (random port, secret path prefix) that
   forwards HTTP and WebSocket traffic to the connector adding `mwapikey` and trusting the certificate (what
   matlab-proxy does for browsers), and starts its own instance of the official extension's language server with
   `--matlabUrl=<relay>`. The rest of the extension (session core, Command Window) is unchanged and talks the MVM
   notifications of §2.
4. **Why it should coexist:** the official extension's MATLAB already ran `initmatlabls` (the language server's MATLAB
   side: communication manager, `input`/`clc` shadows, completion helpers), which our language server instance needs in
   remote mode. MATLAB's engine service is designed for several clients (MATLAB Online uses it) *(guess)*.

Alternatives considered for the Command Window on an existing MATLAB:
- *shareMATLABSession + MathWorks' evaluation function* (`matlab_mcp.mcpEval` → `matlab.internal.editor.evaluateSynchronousRequest`,
  what the MCP server uses): output only after the code finishes, no `input()`, no `K>>`, no interrupt. Rejected: worse
  than the existing terminal.
- *Our own Faye client + reimplementing the MVM protocol* from the obfuscated `MVM.js`: avoids the language server, but
  means reverse-engineering obfuscated code. Kept as a fallback if `--matlabUrl` mode turns out not to work.
- *Bundling MathWorks' `MVM.js`/`MatlabCommunicationManager.js`* (MIT): possible, but the installed language server
  already contains them and stays updated with the official extension.

Open questions (spike checks): does a second engine client get its own output only, or everyone's (A1)? Does
`matlabls/connection/startup` from a second client disturb the first? Does the official terminal keep working while we
are attached and after we disconnect (A2)? Does completion/help work in remote mode (S10, S14)?
