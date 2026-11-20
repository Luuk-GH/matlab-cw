# Spike: 30 minutes on a PC with MATLAB

Goal: find out whether the Command Window can attach to the MATLAB that the official MATLAB extension runs (see
`RESEARCH.md` §8), and record the exact messages so the fake MATLAB can be corrected. Nothing is sent anywhere;
everything stays in `spike/results/`. The spike adds a temporary folder to the MATLAB path and removes it at the end.

## What you need (≈ 5 min)

- Windows PC with **MATLAB R2023a or newer** (licensed).
- **VS Code** with the official **MATLAB extension** (`MathWorks.language-matlab`).
- MathWorks' **MATLAB MCP Server Toolbox** in that MATLAB (installed by the MATLAB Agentic Toolkit, or
  `matlab-mcp-server --setup-matlab`). Check: `which shareMATLABSession` in MATLAB prints a path.
- **Node.js 18+** (`node --version`). No Node? VS Code's own runtime works too, see step 4b.
- This repository (at least `spike/matlab-spike.js`).

## Steps (≈ 10 min)

1. In VS Code, open any `.m` file so the MATLAB extension starts MATLAB (wait until its MATLAB terminal shows `>>`).
2. In that **MATLAB terminal**, run:

   ```matlab
   shareMATLABSession()
   ```

3. Open PowerShell in the repository folder.
4. Run the spike:

   ```powershell
   node spike\matlab-spike.js
   ```

   4b. Without Node, using VS Code's runtime:

   ```powershell
   $env:ELECTRON_RUN_AS_NODE = '1'; & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" spike\matlab-spike.js; Remove-Item Env:ELECTRON_RUN_AS_NODE
   ```

   Options: `--server <path>\server\out\index.js` to pick a language server, `--no-figure` to skip the figure check,
   `--no-manual` to skip the step where you type in the MATLAB terminal.
5. **When it says `>>> NOW`** (check A1): type `disp('hello from the official terminal')` in VS Code's MATLAB terminal
   and press Enter. Note whether the MATLAB terminal still works normally while the spike is attached.
6. During check **S21** a figure window titled "MATLAB companion spike" should appear for about 2 seconds.
7. At the end (check **A2**) type `1+1` in the MATLAB terminal: it must still answer.
8. Send me the two files in `spike\results\` (`spike-<time>.md` and `spike-<time>.json`, the full message trace).

The run takes 1–2 minutes plus the manual steps. If it hangs for more than 3 minutes on one check, press Ctrl+C:
partial results are still written. If **S1** fails, the attach approach needs another route; send the files anyway.

## What the checks mean

| ID | Question | Why it matters |
|---|---|---|
| S1 | Can our language server instance attach to the shared MATLAB (relay + `--matlabUrl`)? | The whole design. |
| A1 | Does output of commands typed in the official MATLAB terminal also reach us? Does that terminal keep working? | Coexistence. |
| S2 | Which prompt states (and `isIdle`) arrive for a simple command? | Busy/idle detection. |
| S3 | Does `evalResponse` come before or after the final READY prompt? | When a command counts as finished. |
| S4 | Do hidden `feval`s change the prompt state? | Help/completion must not flicker the busy state. |
| S5 | Exact shape of `feval` results (`pwd`, `who`) and errors. | Help, completion fallback. |
| S6 | `keyboard`/K>>: DEBUG state, commands at K>>, when evalResponses arrive. | K>> prompt. |
| S7/S8 | `input()`: prompt string, INPUT state, answering; is the prompt also printed? | The window must not hang. |
| S9 | Error text of a failing script: frames, hyperlinks, stream. | Clickable "Error in ..." links. |
| S10 | `help`/`which` text through `feval`. | Help tooltip and usage hint. |
| S11 | Warning markers, display layout. | Yellow warnings, rendering. |
| S12 | Interrupt during `pause(30)` and a busy loop. | Stop button. |
| S13 | Do `feval`s at K>> see the stopped frame? | Completion while debugging. |
| S14 | MATLAB's own completion in remote mode: labels and kinds. | Completion pop-up. |
| S15 | Does output stream while code runs? | Live output. |
| S16 | `pause` without argument: PAUSE state, `unpauseRequest`. | Enter continues. |
| S17 | Multi-line code in one eval. | Shift+Enter blocks. |
| S18 | `clc` event. | Clearing the window. |
| S21 | Figures appear and the prompt returns. | Plotting. |
| S22 | `feature('hotlinks')`, `which` output. | Links. |
| S24 | The extension's session core end to end on real MATLAB. | Everything combined. |
| A2 | After we disconnect, the shared MATLAB is still running (and the MATLAB terminal still works). | Never break the user's session. |

Dry run without MATLAB (checks the spike script itself, through the fake connector and fake language server):
see `scripts/` or run `npm run test:fake`. In a dry run S6, S7, S13 and S24 fail by design (the fake cannot call
function files or `evalc`).

Rebuild after changing `spike/spike.ts`: `npm run spike:build`.
