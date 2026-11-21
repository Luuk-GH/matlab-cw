// Serves the recorded demo material (default <tmp>/mcw-demo-video) on 127.0.0.1 for compose.html, and saves the
// video that page posts to /upload?name=<file> into <dir>/out. Usage: node scripts/video/server.mjs [dir] [port]
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const dir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'mcw-demo-video'));
const port = Number(process.argv[3] ?? 8765);
const types = { '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/upload') {
    const name = path.basename(url.searchParams.get('name') || 'video.bin');
    const file = fs.createWriteStream(path.join(dir, 'out', name));
    req.pipe(file);
    file.on('finish', () => { res.end(`saved ${name}`); console.log(`saved ${path.join(dir, 'out', name)}`); });
    return;
  }
  const file = path.join(dir, decodeURIComponent(url.pathname === '/' ? '/compose.html' : url.pathname));
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${dir} on http://localhost:${port}/`));
