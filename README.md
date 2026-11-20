# MATLAB Command Window (community)

A better Command Window for the official MATLAB extension for VS Code: HTML output with clickable error links,
collapsible output, a completion pop-up, help tooltips and a Stop button. It **attaches to the MATLAB the official
extension already runs**, so there is one MATLAB, one workspace, shared with the MATLAB terminal, Run (F5), the
debugger and the Workspace browser of the official extension, and with AI agents using MathWorks' MCP server.

> **Not affiliated with or endorsed by MathWorks.** MATLAB is a registered trademark of The MathWorks, Inc.
> This extension needs the official MATLAB extension (`MathWorks.language-matlab`) and a licensed MATLAB.

> **Status: preview, untested with real MATLAB.** Everything was built and tested against a fake MATLAB; see
> `TESTING-WITH-MATLAB.md` for what has to be checked with a real installation.

## What it does

The *MATLAB CW* tab in the bottom panel:

- **Output:** select and copy with the mouse, errors in red, warnings in yellow, long output collapses
  (*Show all N lines*), `clc` clears it.
- **Links:** `Error in myfun (line 12)`, `Error using …`, `File: … Line: …` and file paths open the file at that line.
- **Input line** with MATLAB highlighting: **Enter** runs, **Shift+Enter** adds a line, **↑/↓** recall earlier
  commands that start with what you typed, **Esc** clears.
- **Completion pop-up** from MATLAB itself (variables, fields, functions; **Ctrl+Space** or **Tab**), a **help
  tooltip** when you hover a name, and the **usage** of the function you are calling under the input line. These only
  ask MATLAB when it is idle.
- **Stop** button (or Ctrl+C in the input line) while code runs; Enter queues the next command.
- **Never hangs:** `input()` switches the input line to answering, `pause` waits for Enter, `keyboard`/breakpoints
  give a `K>>` prompt.

Everything else (Run File/Section, debugger, Workspace, tests, linting, AI agents) stays with MathWorks' tools.

## Setup

1. Install the official **MATLAB** extension and MathWorks' **MATLAB Agentic Toolkit** (it installs the
   *MATLAB MCP Server Toolbox*, which provides `shareMATLABSession`; R2023a or newer). Without the toolkit:
   `matlab-mcp-server --setup-matlab`.
2. Install this extension: Extensions view → **⋯ → Install from VSIX…** → `matlab-command-window-community-<version>.vsix`.
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
| *… Copy shareMATLABSession() Command* | For pasting into the MATLAB terminal. |

| Setting | Default | |
|---|---|---|
| `matlabCommandWindow.autoConnect` | `true` | Connect when the panel is shown; reconnect when `shareMATLABSession()` runs again. |
| `matlabCommandWindow.languageServerPath` | (the official extension's) | Language server to use (`…/server/out/index.js`). |

## Troubleshooting

- **"No shared MATLAB session found"**: run `shareMATLABSession()` in the MATLAB terminal (step 3).
- **"…is no longer running"**: MATLAB was restarted; run `shareMATLABSession()` again.
- **Undefined function `shareMATLABSession`**: install the MATLAB Agentic Toolkit / MCP Server Toolbox (step 1).
- Log: View → Output → *MATLAB Command Window*.
- Restricted Mode: connecting needs a trusted workspace.

## Development

```
npm install
npm run compile            # type-check and bundle
npm run package            # build matlab-command-window-community-<version>.vsix
npm run test:unit          # pure logic, session file, connector relay
npm run test:fake          # session core + backend against the fake language server and fake connector
npm run test:integration   # end to end in a separate VS Code instance, against the fakes
npm run test:vsix          # the same, from the packaged .vsix in a fresh profile
npm run spike:build        # rebuild spike/matlab-spike.js (see spike/README.md)
```

## Licence

MIT. Parts are adapted from the author's GNU Octave extension. No MathWorks code is included: the MathWorks language
server is run from the user's installed official extension.
