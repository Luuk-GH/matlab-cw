// A local relay between the MathWorks language server (started with --matlabUrl) and the web connector of an
// EXISTING MATLAB (the one the official MATLAB extension runs, made reachable with shareMATLABSession()).
//
// Why: the language server's "remote MATLAB" mode opens a plain Faye client on the given URL, without the
// `mwapikey` header and without trusting MATLAB's self-signed certificate (read from MatlabCommunicationManager.js,
// v1.3.16). For MATLABs it launches itself it does both (https://localhost:<port>/messageservice/async, header
// mwapikey, ca = connector certificate). This relay adds exactly those two things, the same job matlab-proxy does
// for MATLAB in a browser. HTTP requests (long polling) and WebSocket upgrades are both relayed.
//
// Security: listens on 127.0.0.1 only, on a random port, and only forwards requests under a random secret path
// prefix, so other local programs cannot use it to reach MATLAB without knowing the prefix.
// No VS Code dependency; tested in scripts/connectorProxy.test.ts against a fake HTTPS connector.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';

export interface ConnectorTarget {
  /** connector.securePort() of the MATLAB to attach to. */
  port: number;
  /** connector.getCertificateLocation(): the PEM file MATLAB's connector serves (used as the trusted CA). */
  certificate: string;
  /** The connector's API key (sent as the `mwapikey` header). */
  apiKey: string;
  /** URL path prefix of the connector, '' for a desktop MATLAB. */
  basePath?: string;
  /** Host name to connect to (default localhost, resolved to 127.0.0.1). */
  host?: string;
}

export interface RunningProxy {
  /** URL to give the language server as --matlabUrl. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startConnectorProxy(target: ConnectorTarget, log: (m: string) => void = () => undefined): Promise<RunningProxy> {
  const ca = fs.readFileSync(target.certificate);
  const prefix = '/' + crypto.randomBytes(16).toString('hex');
  const base = (target.basePath ?? '').replace(/\/+$/, '');
  const host = '127.0.0.1';
  const servername = target.host ?? 'localhost';
  const sockets = new Set<net.Socket>();

  /** Map an incoming path to the connector path, or undefined when it is not under our secret prefix. */
  const targetPath = (url: string | undefined): string | undefined => {
    if (!url || !url.startsWith(prefix + '/')) { return undefined; }
    return base + url.slice(prefix.length);
  };
  const forwardHeaders = (h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
    const out: http.OutgoingHttpHeaders = { ...h, host: `${servername}:${target.port}`, mwapikey: target.apiKey };
    delete out.origin;   // the connector may reject foreign origins; the language server is not a browser
    return out;
  };

  const server = http.createServer((req, res) => {
    const path = targetPath(req.url);
    if (!path) { res.writeHead(404).end(); return; }
    const up = https.request({
      host, port: target.port, servername, ca, method: req.method, path, headers: forwardHeaders(req.headers),
    }, upRes => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', e => {
      log(`connector request failed: ${e.message}`);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); }
      res.end(`connector unreachable: ${e.message}`);
    });
    req.pipe(up);
  });

  server.on('upgrade', (req, client: net.Socket, head: Buffer) => {
    const path = targetPath(req.url);
    if (!path) { client.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const up = tls.connect({ host, port: target.port, servername, ca }, () => {
      const headers = forwardHeaders(req.headers);
      const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) { continue; }
        for (const one of Array.isArray(v) ? v : [v]) { lines.push(`${k}: ${one}`); }
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) { up.write(head); }
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(client); sockets.add(up);
    const end = () => { client.destroy(); up.destroy(); sockets.delete(client); sockets.delete(up); };
    up.on('error', e => { log(`connector websocket failed: ${e.message}`); end(); });
    client.on('error', end);
    up.on('close', end);
    client.on('close', end);
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as net.AddressInfo).port;
  log(`connector relay on 127.0.0.1:${port} -> ${servername}:${target.port}${base}`);
  return {
    url: `http://127.0.0.1:${port}${prefix}/messageservice/async`,
    port,
    close: () => new Promise(resolve => {
      for (const s of sockets) { s.destroy(); }
      server.close(() => resolve());
    }),
  };
}
