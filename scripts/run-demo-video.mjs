// Records the demo video's raw material (Windows): starts a maximized Extension Development Host running
// dist/demoVideo.test.js against the real shared MATLAB, and saves the window as JPEG frames (about 10 per second)
// from the moment the demo is ready until it is done. Output: <tmp>/mcw-demo-video/{frames/, frames.json,
// timeline.json, compose.html}. Then serve that folder (node scripts/video/server.mjs) and open compose.html in a
// browser to turn it into an MP4 (see scripts/video/compose.html).
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(os.tmpdir(), 'mcw-demo-video');
const marks = path.join(base, 'marks');
const frames = path.join(base, 'frames');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(marks, { recursive: true });
fs.mkdirSync(frames, { recursive: true });
fs.mkdirSync(path.join(base, 'user-data', 'User'), { recursive: true });
fs.writeFileSync(path.join(base, 'user-data', 'User', 'settings.json'), JSON.stringify({
  'window.newWindowDimensions': 'maximized',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.colorTheme': 'Default Dark Modern',
  'editor.fontSize': 15,
  'terminal.integrated.fontSize': 15,
  'window.commandCenter': false,
  'workbench.layoutControl.enabled': false,
}, null, 1));

const extDir = path.join(os.homedir(), '.vscode', 'extensions');
const official = fs.readdirSync(extDir).filter(d => /^mathworks\.language-matlab-\d/.test(d)).sort().pop();
if (!official) { console.error('The official MATLAB extension is not installed.'); process.exit(2); }

const loop = path.join(base, 'capture-loop.ps1');
fs.writeFileSync(loop, `param([string]$dir, [string]$marker, [string]$stop, [int]$fps)
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
function Front { [W]::ShowWindow($h, 3) | Out-Null; [W]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [IntPtr]::Zero); [W]::SetForegroundWindow($h) | Out-Null }
Front
Start-Sleep -Milliseconds 600
$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$pad = 8
$x = $r.Left + $pad; $y = $r.Top + $pad; $w = $r.Right - $r.Left - 2 * $pad; $hh = $r.Bottom - $r.Top - 2 * $pad
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 88L
$interval = [int](1000 / $fps)
$n = 0
while (-not (Test-Path $stop)) {
  $t0 = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $bmp.Save("$dir\\f_$t0.jpg", $codec, $ep)
  $n++
  if ($n % 40 -eq 0) { [W]::SetForegroundWindow($h) | Out-Null }
  $el = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() - $t0
  if ($el -lt $interval) { Start-Sleep -Milliseconds ($interval - $el) }
}
`);

const codeExe = process.env.VSCODE_EXE ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
// MCW_IT_RESULT turns on the webview's test hooks (provider.ts), which the demo drives.
const env = { ...process.env, MCW_DEMO_DIR: marks, MCW_IT_RESULT: path.join(base, 'result.txt'), MCW_ANY_MATLAB: '1', MCW_LANGUAGE_SERVER: path.join(extDir, official, 'server', 'out', 'index.js') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MCW_SESSION_FILE;
const child = spawn(codeExe, [
  `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'dist', 'demoVideo.test.js')}`,
  `--user-data-dir=${path.join(base, 'user-data')}`, `--extensions-dir=${path.join(base, 'extensions')}`,
  '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
  path.join(root, 'docs', 'video', 'workspace'),
], { stdio: 'ignore', env });

const stopFile = path.join(marks, 'stop.txt');
let recorder;
const timer = setInterval(() => {
  if (!recorder && fs.existsSync(path.join(marks, 'start.txt'))) {
    console.log('recording…');
    recorder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', loop, frames, 'mcw-demo-video', stopFile, '10'], { stdio: 'inherit' });
  }
  if (fs.existsSync(path.join(marks, 'timeline.json')) && !fs.existsSync(stopFile)) { fs.writeFileSync(stopFile, 'stop'); }
}, 200);
const deadline = setTimeout(() => { console.error('demo timed out'); fs.writeFileSync(stopFile, 'stop'); child.kill(); }, 300000);
child.on('exit', code => {
  clearInterval(timer); clearTimeout(deadline);
  fs.writeFileSync(stopFile, 'stop');
  const list = fs.readdirSync(frames).filter(f => f.endsWith('.jpg')).sort();
  fs.writeFileSync(path.join(base, 'frames.json'), JSON.stringify(list));
  if (fs.existsSync(path.join(marks, 'timeline.json'))) { fs.copyFileSync(path.join(marks, 'timeline.json'), path.join(base, 'timeline.json')); }
  fs.copyFileSync(path.join(root, 'scripts', 'video', 'compose.html'), path.join(base, 'compose.html'));
  fs.copyFileSync(path.join(root, 'media', 'icon.png'), path.join(base, 'icon.png'));
  const done = path.join(marks, 'done.txt');
  console.log(fs.existsSync(done) ? fs.readFileSync(done, 'utf8') : '(demo did not finish)');
  console.log(`${list.length} frames in ${frames}`);
  process.exit(code ?? 1);
});
