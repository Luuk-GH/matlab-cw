// Takes screenshots of the Command Window against the real shared MATLAB (Windows): starts a maximized Extension
// Development Host running dist/demo.test.js, and captures the screen whenever the demo reaches a stage.
// Screenshots go to docs/screenshots/. Needs a MATLAB shared with shareMATLABSession() and the official extension.
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(os.tmpdir(), 'mcw-demo-vscode');
const marks = path.join(base, 'marks');
const outDir = path.join(root, 'docs', 'screenshots');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(marks, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
// A clean, maximized window.
fs.mkdirSync(path.join(base, 'user-data', 'User'), { recursive: true });
fs.writeFileSync(path.join(base, 'user-data', 'User', 'settings.json'), JSON.stringify({
  'window.newWindowDimensions': 'maximized',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
}, null, 1));

const extDir = path.join(os.homedir(), '.vscode', 'extensions');
const official = fs.readdirSync(extDir).filter(d => /^mathworks\.language-matlab-\d/.test(d)).sort().pop();
if (!official) { console.error('The official MATLAB extension is not installed.'); process.exit(2); }

const capture = path.join(base, 'capture.ps1');
// Brings the demo window (the Code.exe whose command line names our user-data folder) to the front, maximized,
// and captures just that window.
fs.writeFileSync(capture, `param([string]$out, [string]$marker)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[W]::SetProcessDPIAware() | Out-Null
$ids = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like "*$marker*" } | ForEach-Object { $_.ProcessId }
$p = Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw 'demo window not found' }
$h = $p.MainWindowHandle
[W]::ShowWindow($h, 3) | Out-Null
[W]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)   # lets us take the foreground
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
# A maximized window extends a few pixels past the screen edges: trim them.
$pad = 8
$x = $r.Left + $pad; $y = $r.Top + $pad; $w = $r.Right - $r.Left - 2 * $pad; $hh = $r.Bottom - $r.Top - 2 * $pad
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
`);

const codeExe = process.env.VSCODE_EXE ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const env = { ...process.env, MCW_IT_RESULT: path.join(base, 'result.txt'), MCW_ANY_MATLAB: '1', MCW_DEMO_DIR: marks,
  MCW_LANGUAGE_SERVER: path.join(extDir, official, 'server', 'out', 'index.js') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MCW_SESSION_FILE;
const child = spawn(codeExe, [
  `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'dist', 'demo.test.js')}`,
  `--user-data-dir=${path.join(base, 'user-data')}`, `--extensions-dir=${path.join(base, 'extensions')}`,
  '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
  path.join(root, 'test', 'workspace'),
], { stdio: 'ignore', env });

const taken = new Set();
const timer = setInterval(() => {
  for (const f of fs.readdirSync(marks)) {
    const m = /^stage-(\d+)\.txt$/.exec(f);
    if (!m || taken.has(m[1])) { continue; }
    taken.add(m[1]);
    const name = fs.readFileSync(path.join(marks, f), 'utf8').trim();
    const png = path.join(outDir, `${m[1].padStart(2, '0')}-${name}.png`);
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', capture, png, 'mcw-demo-vscode']);
    console.log(`captured ${png}`);
    fs.writeFileSync(path.join(marks, `shot-${m[1]}.txt`), 'ok');
  }
}, 300);
const deadline = setTimeout(() => { console.error('demo timed out'); child.kill(); }, 240000);
child.on('exit', code => {
  clearInterval(timer); clearTimeout(deadline);
  const done = path.join(marks, 'done.txt');
  console.log(fs.existsSync(done) ? fs.readFileSync(done, 'utf8') : '(demo did not finish)');
  process.exit(code ?? 1);
});
