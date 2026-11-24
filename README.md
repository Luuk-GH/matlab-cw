# MATLAB Command Window

A better Command Window for the official MATLAB extension for VS Code: HTML output with clickable error links,
a completion pop-up (also for file and folder names), a Command History pop-up, help tooltips and a Stop button. It
**attaches to the MATLAB the official extension in the same VS Code window runs**, so there is one MATLAB, one
workspace, shared with the MATLAB terminal, Run (F5), the
debugger and the Workspace browser of the official extension, and with AI agents using MathWorks' MCP server.

> **Not affiliated with or endorsed by MathWorks.** MATLAB is a registered trademark of The MathWorks, Inc.
> This extension needs the official MATLAB extension (`MathWorks.language-matlab`) and a licensed MATLAB.

> **Status: preview.** Verified on MATLAB R2026b with MATLAB extension 1.3.16 (the spike and the integration tests
> pass against the real MATLAB); other releases are untested. See `TESTING-WITH-MATLAB.md`.

## What it does

The *MATLAB CW* tab in the bottom panel:

- **Output:** select and copy with the mouse, errors in red, warnings in yellow, `clc` clears it. Long output is
  shown in full (`matlabCommandWindow.collapseLongOutput` collapses it to *Show all N lines*). The frames of `run`
  (how Run File runs a script) are left out of error and warning stacks.
- **Links:** `Error in myfun (line 12)`, `Error using …`, `File: … Line: …` and file paths open the file at that line.
- **Input line** with MATLAB highlighting and a blinking cursor: **Enter** runs, **Shift+Enter** adds a line,
  **Esc** clears.
- **Command History pop-up**, like MATLAB's: **↑** lists earlier commands that start with what you typed (a command
  repeated right after itself shows once, as `2x`). **↑/↓** move, **Shift+↑/↓** select several, **Enter** runs them in
  order, **→** (or ←, Tab) puts them on the line to edit, **Esc** closes; typing narrows the list; double-click runs.
  Turn off `matlabCommandWindow.historyPopup` to recall commands on the line with ↑/↓ instead.
- **Completion pop-up** from MATLAB itself (variables, fields, functions; **Ctrl+Space** or **Tab**) and a **help
  tooltip** when you hover a name, with a **Documentation** link (the page MATLAB's own `doc` would open, in your
  browser).
- **Hover help in `.m` files**, from the same MATLAB `help`: usage forms, description, links to the documentation and
  the defining file. MathWorks' extension gives signature help while typing but no hover. Works while the Command
  Window is connected and MATLAB is idle or at K>> (answers are kept, so names seen before also work while it runs);
  nothing goes over the network until you click Documentation. Setting `matlabCommandWindow.editorHover`.
- **File and folder names**, like the MATLAB desktop: in an argument that MATLAB's function signatures declare as a
  file or folder (`load('`, `cd `, `addpath('`, `genpath('`, `readtable('`, `imread('`, …) the pop-up lists the
  matching names in MATLAB's current folder, folders first. Accepting a folder (`data\`) lists what is inside it.
- **Load a `.mat` file**: drop it on the Command Window from Windows Explorer, or right-click it in the VS Code
  Explorer → *Load into MATLAB Command Window*. Dragging from the VS Code Explorer onto the Command Window is not
  possible: VS Code and Chromium keep drags inside VS Code out of webviews. A dropped file arrives without its path,
  so the Command Window looks for it (same name, size and date) in MATLAB's current folder and your workspace folders
  and loads that file; if it is not there, it asks before loading a copy.
  Other files are ignored.
- **Signature help** like the editor's: while you type a call, a box shows MATLAB's own forms of the function
  (`plot(Y,LineSpec,options)  1 of 6`), the current argument in bold, and what it is (`y-coordinates`,
  `scalar | vector | matrix`). **Alt+↑/↓** or a click on "1 of 6" shows the other forms, **Esc** closes it. Functions
  without signature data (your own) show their help line instead. All of this only asks MATLAB when it is idle.
- **Stop** button (or Ctrl+C in the input line) while code runs. Enter queues the next command: queued commands show
  dimmed under the output (*queued*) until they run; hover one and click **×** to drop it. Stop drops them all.
- **Never hangs:** `input()` switches the input line to answering, `pause` waits for Enter, `keyboard`/breakpoints
  give a `K>>` prompt. An `input()` or `pause` from a command started elsewhere (the MATLAB terminal) is left to
  that window, because MATLAB sends a command's output only to the window that started it.
- **Run from the editor into the Command Window:** in a `.m` file **F5** runs the file, **Ctrl+Enter** the current
  `%%` section, **Shift+Enter** the selection (also in the editor's Run menu and context menu). The editor keeps the
  focus; a file shows as its name (`>> myscript`). When code stops at a breakpoint or asks for `input()`, the Command
  Window stays in front instead of the MATLAB terminal. Turn off `matlabCommandWindow.runInCommandWindow` to give all of this back
  to the MATLAB extension.

- **Workspace beside it:** the first time the Command Window opens, the MATLAB extension's *Workspace* view is put
  next to it in the panel (VS Code does not let you drop it there yourself). Move it anywhere afterwards; VS Code
  remembers. `matlabCommandWindow.workspaceBesideCommandWindow` off moves it back to the MATLAB side bar.
- **Only this window's MATLAB:** it connects only to a MATLAB started by the MATLAB extension in the same VS Code
  window. A MATLAB that another client shared (for example one that MathWorks' MCP server starts when the shared one
  is gone, or the MATLAB of another VS Code window) is refused with a message saying who started it.

Everything else (debugger, Workspace, tests, linting, AI agents) stays with MathWorks' tools.

## Setup

1. Install the official **MATLAB** extension and MathWorks' **MATLAB Agentic Toolkit** (it installs the
   *MATLAB MCP Server Toolbox*, which provides `shareMATLABSession`; R2023a or newer). Without the toolkit:
   `matlab-mcp-server --setup-matlab`.
2. Install this extension: Extensions view → **⋯ → Install from VSIX…** → `matlab-command-window-<version>.vsix`.
3. Open a `.m` file so the MATLAB extension starts MATLAB. In its **MATLAB terminal**, run once per MATLAB session:

   ```matlab
   shareMATLABSession()
   ```

4. Open the **MATLAB CW** panel (or *MATLAB Command Window: Show*). It connects by itself and says
   "Connected to MATLAB R20xx…".

`shareMATLABSession()` is the same command MathWorks' MCP server uses to attach agents to an existing MATLAB, so one
call serves both. When MATLAB restarts, run it again; the Command Window reconnects automatically.

## How it works (no second MATLAB)

```
MATLAB extension ── its language server ──┐
                                          ├── the same MATLAB (shared with shareMATLABSession())
this extension ── its own language server ┘   via MATLAB's web connector
   (from the MATLAB extension, started with --matlabUrl, through a small local relay)
```

`shareMATLABSession()` writes the address, certificate and access key of MATLAB's built-in web connector to
`%APPDATA%\MathWorks\MATLAB MCP Server\v1\sessionDetails.json`. This extension starts a second instance of the
official extension's language server in its "connect to an existing MATLAB" mode, through a relay on `127.0.0.1` that
adds the access key, and drives MATLAB with the same engine messages the official terminal uses. Disconnecting never
quits MATLAB. Nothing is added to your MATLAB path. Details: `RESEARCH.md`.

## Commands and settings

| Command | |
|---|---|
| *MATLAB Command Window: Show* | Open the panel and connect. |
| *… Connect to Shared MATLAB* / *… Disconnect* | Also in the panel's title bar. Disconnect leaves MATLAB running. |
| *… Interrupt* | Stop the running code (also the Stop button). |
| *… Run File / Run Section / Run Selection in Command Window* | F5 / Ctrl+Enter / Shift+Enter in a `.m` file. |
| *… Copy shareMATLABSession() Command* | For pasting into the MATLAB terminal. |

| Setting | Default | |
|---|---|---|
| `matlabCommandWindow.autoConnect` | `true` | Connect when the panel is shown; reconnect when `shareMATLABSession()` runs again. |
| `matlabCommandWindow.editorHover` | `true` | Hover a name in a `.m` file for its MATLAB help. |
| `matlabCommandWindow.runInCommandWindow` | `true` | F5, Ctrl+Enter and Shift+Enter in `.m` files run in the Command Window instead of the MATLAB extension's terminal. Ctrl+Enter and Shift+Enter also at K>> (F5 stays *Continue*). Run Selection adds the code to the Command History. |
| `matlabCommandWindow.historyPopup` | `true` | ↑ opens the Command History pop-up; off: ↑/↓ recall on the line. |
| `matlabCommandWindow.collapseLongOutput` | `false` | Collapse output longer than 40 lines once its command finishes. |
| `matlabCommandWindow.workspaceBesideCommandWindow` | `true` | Put the MATLAB *Workspace* view beside the Command Window (once); off moves it back. |
| `matlabCommandWindow.languageServerPath` | (the official extension's) | Language server to use (`…/server/out/index.js`). |

## Troubleshooting

- **"No shared MATLAB session found"**: run `shareMATLABSession()` in the MATLAB terminal (step 3).
- **"…is no longer running"**: MATLAB was restarted; run `shareMATLABSession()` again.
- **"The shared MATLAB (process N) was started by …, not by the MATLAB extension in this VS Code window"**: the last
  `shareMATLABSession()` came from another MATLAB (an MCP server's, a MATLAB desktop, another VS Code window). Run
  `shareMATLABSession()` again in this window's MATLAB terminal.
- **Undefined function `shareMATLABSession`**: install the MATLAB Agentic Toolkit / MCP Server Toolbox (step 1).
- Log: View → Output → *MATLAB Command Window*.
- Restricted Mode: connecting needs a trusted workspace.

## Development

```
npm install
npm run compile            # type-check and bundle
npm run package            # build matlab-command-window-<version>.vsix
npm run test:unit          # pure logic, session file, connector relay
npm run test:fake          # session core + backend against the fake language server and fake connector
npm run test:integration   # end to end in a separate VS Code instance, against the fakes
npm run test:vsix          # the same, from the packaged .vsix in a fresh profile
npm run test:real          # the integration tests against the real MATLAB shared with shareMATLABSession()
npm run demo:screenshots   # screenshots of the Command Window on the real MATLAB -> docs/screenshots/
npm run demo:video         # records the demo; then node scripts/video/server.mjs and open http://localhost:8765/
                           # in a browser; it writes %TEMP%/mcw-demo-video/out/mcw-demo.mp4 (scripts/video/compose.html)
npm run spike:build        # rebuild spike/matlab-spike.js (see spike/README.md)
```

## Licence

MIT. Parts are adapted from the author's GNU Octave extension. No MathWorks code is included: the MathWorks language
server is run from the user's installed official extension.
