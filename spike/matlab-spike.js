"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// spike/spike.ts
var fs3 = __toESM(require("fs"));
var os2 = __toESM(require("os"));
var path2 = __toESM(require("path"));

// src/backend/lsBackend.ts
var import_child_process = require("child_process");
var import_events = require("events");

// src/backend/connectorProxy.ts
var crypto = __toESM(require("crypto"));
var fs = __toESM(require("fs"));
var http = __toESM(require("http"));
var https = __toESM(require("https"));
var tls = __toESM(require("tls"));
async function startConnectorProxy(target, log = () => void 0) {
  const ca = fs.readFileSync(target.certificate);
  const prefix = "/" + crypto.randomBytes(16).toString("hex");
  const base = (target.basePath ?? "").replace(/\/+$/, "");
  const host = "127.0.0.1";
  const servername = target.host ?? "localhost";
  const sockets = /* @__PURE__ */ new Set();
  const targetPath = (url) => {
    if (!url || !url.startsWith(prefix + "/")) {
      return void 0;
    }
    return base + url.slice(prefix.length);
  };
  const forwardHeaders = (h) => {
    const out = { ...h, host: `${servername}:${target.port}`, mwapikey: target.apiKey };
    delete out.origin;
    return out;
  };
  const server = http.createServer((req, res) => {
    const path3 = targetPath(req.url);
    if (!path3) {
      res.writeHead(404).end();
      return;
    }
    const up = https.request({
      host,
      port: target.port,
      servername,
      ca,
      method: req.method,
      path: path3,
      headers: forwardHeaders(req.headers)
    }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on("error", (e) => {
      log(`connector request failed: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end(`connector unreachable: ${e.message}`);
    });
    req.pipe(up);
  });
  server.on("upgrade", (req, client, head) => {
    const path3 = targetPath(req.url);
    if (!path3) {
      client.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const up = tls.connect({ host, port: target.port, servername, ca }, () => {
      const headers = forwardHeaders(req.headers);
      const lines = [`${req.method} ${path3} HTTP/${req.httpVersion}`];
      for (const [k, v] of Object.entries(headers)) {
        if (v === void 0) {
          continue;
        }
        for (const one of Array.isArray(v) ? v : [v]) {
          lines.push(`${k}: ${one}`);
        }
      }
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) {
        up.write(head);
      }
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(client);
    sockets.add(up);
    const end = () => {
      client.destroy();
      up.destroy();
      sockets.delete(client);
      sockets.delete(up);
    };
    up.on("error", (e) => {
      log(`connector websocket failed: ${e.message}`);
      end();
    });
    client.on("error", end);
    up.on("close", end);
    client.on("close", end);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve2();
    });
  });
  const port = server.address().port;
  log(`connector relay on 127.0.0.1:${port} -> ${servername}:${target.port}${base}`);
  return {
    url: `http://127.0.0.1:${port}${prefix}/messageservice/async`,
    port,
    close: () => new Promise((resolve2) => {
      for (const s of sockets) {
        s.destroy();
      }
      server.close(() => resolve2());
    })
  };
}

// src/backend/jsonRpc.ts
var JsonRpcPeer = class {
  constructor(transport, log = () => void 0) {
    this.transport = transport;
    this.log = log;
    transport.onMessage((m) => this.receive(m));
  }
  transport;
  log;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  notificationHandlers = /* @__PURE__ */ new Map();
  requestHandler = () => null;
  closed = false;
  /** Handle notifications with this method name (one handler per name). */
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }
  /** Answer requests the other side sends (workspace/configuration, window/workDoneProgress/create, ...). */
  onRequest(handler) {
    this.requestHandler = handler;
  }
  notify(method, params) {
    if (this.closed) {
      return;
    }
    this.transport.send(params === void 0 ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }
  request(method, params, timeoutMs = 0) {
    if (this.closed) {
      return Promise.reject(new Error("connection closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve2, reject) => {
      const p = { resolve: (v) => resolve2(v), reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  /** The transport is gone: fail all outstanding requests. */
  close(reason = "connection closed") {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
  receive(raw) {
    if (typeof raw !== "object" || raw === null) {
      return;
    }
    const m = raw;
    if (m.method !== void 0 && m.id !== void 0) {
      let result = null;
      try {
        result = this.requestHandler(m.method, m.params);
      } catch (e) {
        this.log(`request ${m.method} failed: ${e.message}`);
      }
      Promise.resolve(result).then(
        (r) => this.transport.send({ jsonrpc: "2.0", id: m.id, result: r ?? null }),
        (e) => this.transport.send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: String(e) } })
      );
      return;
    }
    if (m.method !== void 0) {
      const h = this.notificationHandlers.get(m.method);
      if (h) {
        try {
          h(m.params);
        } catch (e) {
          this.log(`notification ${m.method} handler failed: ${e.stack ?? e}`);
        }
      }
      return;
    }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) {
        return;
      }
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        p.reject(new Error(m.error.message));
      } else {
        p.resolve(m.result);
      }
    }
  }
};

// src/backend/types.ts
var MatlabError = class extends Error {
  constructor(identifier, message) {
    super(message);
    this.identifier = identifier;
  }
  identifier;
};

// src/backend/lsBackend.ts
var KIND = { 5: "f", 10: "f", 6: "v", 14: "k" };
var WARNING_MARKS = /\[\x08|\]\x08/g;
var LsBackend = class extends import_events.EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
  }
  opts;
  child;
  peer;
  nextId = 1;
  evals = /* @__PURE__ */ new Map();
  fevals = /* @__PURE__ */ new Map();
  completions = /* @__PURE__ */ new Map();
  exited = false;
  /** Set while starting: a 'disconnected' status then means the connection failed. */
  onDisconnected;
  release = null;
  proxy;
  on(event, listener) {
    return super.on(event, listener);
  }
  log(m) {
    this.emit("log", m);
  }
  async start() {
    let matlabUrl;
    if (this.opts.attach) {
      this.proxy = await startConnectorProxy(this.opts.attach, (m) => this.log(m));
      matlabUrl = this.proxy.url;
    }
    try {
      return await this.launch(matlabUrl);
    } catch (e) {
      void this.proxy?.close();
      throw e;
    }
  }
  launch(matlabUrl) {
    const args = ["--node-ipc", "--matlabConnectionTiming=onDemand", "--indexWorkspace=false"];
    if (matlabUrl) {
      args.push(`--matlabUrl=${matlabUrl}`);
    }
    if (this.opts.matlabInstallPath) {
      args.push(`--matlabInstallPath=${this.opts.matlabInstallPath}`);
    }
    if (this.opts.matlabArgs) {
      args.push(`--matlabLaunchCommandArgs=${this.opts.matlabArgs}`);
    }
    this.log(`starting language server: ${this.opts.serverPath} ${args.map((a) => a.replace(/matlabUrl=.*$/, "matlabUrl=<relay>")).join(" ")}`);
    const env = { ...process.env, ...this.opts.env, ELECTRON_RUN_AS_NODE: "1" };
    const child = (0, import_child_process.fork)(this.opts.serverPath, args, {
      cwd: this.opts.cwd,
      execPath: this.opts.execPath ?? process.execPath,
      execArgv: [],
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    this.child = child;
    child.stdout?.on("data", (b) => this.log(`[ls] ${b.toString().trimEnd()}`));
    child.stderr?.on("data", (b) => this.log(`[ls err] ${b.toString().trimEnd()}`));
    const trace2 = this.opts.trace;
    const peer = new JsonRpcPeer({
      send: (m) => {
        trace2?.("->", m);
        try {
          child.send(m);
        } catch (e) {
          this.log(`send failed: ${e.message}`);
        }
      },
      onMessage: (l) => child.on("message", (m) => {
        trace2?.("<-", m);
        l(m);
      })
    }, (m) => this.log(m));
    this.peer = peer;
    peer.onRequest((method) => {
      if (method === "workspace/configuration") {
        return [{}];
      }
      return null;
    });
    peer.onNotification("text", (d) => {
      if (!d || typeof d.text !== "string") {
        return;
      }
      if (d.stream === 0 && d.text.startsWith("[\b")) {
        this.emit("output", d.text.replace(WARNING_MARKS, ""), "err");
        return;
      }
      this.emit("output", d.text.replace(WARNING_MARKS, ""), d.stream === 0 ? "out" : "err");
    });
    peer.onNotification("mvmPromptChange", (d) => this.emit("prompt", d.state, !!d.isIdle));
    peer.onNotification("mvmInputPrompt", (p) => this.emit("inputPrompt", typeof p === "string" ? p : String(p?.promptString ?? "")));
    peer.onNotification("clc", () => this.emit("clc"));
    peer.onNotification("evalResponse", (d) => {
      const done = this.evals.get(d?.requestId);
      if (done) {
        this.evals.delete(d.requestId);
        done();
      }
    });
    peer.onNotification("fevalResponse", (d) => {
      const p = this.fevals.get(d?.requestId);
      if (!p) {
        return;
      }
      this.fevals.delete(d.requestId);
      const err = fevalError(d.result);
      if (err) {
        p.reject(err);
      } else {
        p.resolve(fevalOutputs(d.result));
      }
    });
    peer.onNotification("TerminalCompletionResponse", (d) => {
      const done = this.completions.get(d?.requestId);
      if (done) {
        this.completions.delete(d.requestId);
        done(completionItems(d.result));
      }
    });
    peer.onNotification("matlab/connection/update/server", (d) => {
      this.log(`connection: ${JSON.stringify(d)}`);
      if (d?.connectionStatus === "disconnected") {
        this.onDisconnected?.();
      }
    });
    peer.onNotification("telemetry/logdata", () => {
    });
    peer.onNotification("window/logMessage", (d) => this.log(`[ls log] ${d?.message ?? ""}`));
    return new Promise((resolve2, reject) => {
      let settled = false;
      const fail = (reason) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(new Error(reason));
      };
      const timeoutMs = this.opts.startTimeoutMs ?? 18e4;
      const timer = setTimeout(() => fail(`MATLAB did not become ready within ${Math.round(timeoutMs / 1e3)} s.`), timeoutMs);
      this.onDisconnected = () => {
        if (!settled) {
          fail(this.opts.attach ? "Could not connect to the shared MATLAB." : "MATLAB disconnected during startup.");
        } else {
          this.lost("MATLAB disconnected");
        }
      };
      peer.onNotification("mvmStateChange", (d) => {
        this.log(`mvm state: ${JSON.stringify(d)}`);
        if (d?.state === "connected") {
          this.release = d.release ?? this.release;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve2({ release: this.release });
          }
        } else if (d?.state === "disconnected") {
          if (!settled) {
            fail("MATLAB disconnected during startup.");
          } else {
            this.lost("MATLAB disconnected");
          }
        }
      });
      peer.onNotification("matlab/launchfailed", (d) => {
        const msg = `MATLAB could not be launched: ${typeof d === "string" ? d : JSON.stringify(d)}`;
        if (!settled) {
          fail(msg);
        } else {
          this.lost(msg);
        }
      });
      peer.onNotification("feature/needsmatlab/nomatlab", () => fail("The language server did not find MATLAB. Set matlabCommandWindow.matlabInstallPath."));
      child.on("error", (e) => {
        fail(`language server could not start: ${e.message}`);
        this.lost(e.message);
      });
      child.on("exit", (code) => {
        fail(`language server exited (code ${code}) before MATLAB was ready.`);
        this.lost(`language server exited (code ${code})`);
      });
      void peer.request("initialize", {
        processId: process.pid,
        clientInfo: { name: "matlab-command-window-community" },
        rootUri: null,
        capabilities: {}
      }, 6e4).then(() => {
        peer.notify("initialized", {});
        peer.notify("matlab/request");
      }, (e) => fail(`language server did not initialize: ${e.message}`));
    });
  }
  eval(code) {
    if (this.exited || !this.peer) {
      return Promise.reject(new Error("MATLAB is not running"));
    }
    const requestId = `e${this.nextId++}`;
    return new Promise((resolve2) => {
      this.evals.set(requestId, resolve2);
      this.peer.notify("evalRequest", { requestId, command: code, isUserEval: true });
    });
  }
  feval(fn, nargout, args) {
    if (this.exited || !this.peer) {
      return Promise.reject(new Error("MATLAB is not running"));
    }
    const requestId = `f${this.nextId++}`;
    return new Promise((resolve2, reject) => {
      this.fevals.set(requestId, { resolve: resolve2, reject });
      this.peer.notify("fevalRequest", { requestId, functionName: fn, nargout, args, isUserEval: false });
    });
  }
  interrupt() {
    this.peer?.notify("interruptRequest");
  }
  /** Send any notification (the spike uses this to probe the protocol directly). */
  rawNotify(method, params) {
    this.peer?.notify(method, params);
  }
  unpause() {
    this.peer?.notify("unpauseRequest", {});
  }
  complete(code, offset) {
    if (this.exited || !this.peer) {
      return Promise.resolve(void 0);
    }
    const requestId = this.nextId++;
    return new Promise((resolve2) => {
      this.completions.set(requestId, resolve2);
      this.peer.notify("TerminalCompletionRequest", { requestId, code, offset });
      setTimeout(() => {
        if (this.completions.delete(requestId)) {
          resolve2(void 0);
        }
      }, 3e3);
    });
  }
  dispose() {
    const child = this.child;
    if (!child || this.exited) {
      return;
    }
    void this.peer?.request("shutdown", null, 3e3).then(() => this.peer?.notify("exit"), () => void 0);
    const proxy = this.proxy;
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill();
      }
      void proxy?.close();
    }, this.opts.attach ? 1500 : 5e3);
    this.lost("disposed");
  }
  lost(reason) {
    if (this.exited) {
      return;
    }
    this.exited = true;
    if (reason !== "disposed") {
      void this.proxy?.close();
    }
    this.peer?.close(reason);
    for (const done of this.evals.values()) {
      done();
    }
    this.evals.clear();
    for (const p of this.fevals.values()) {
      p.reject(new Error(reason));
    }
    this.fevals.clear();
    for (const done of this.completions.values()) {
      done(void 0);
    }
    this.completions.clear();
    this.emit("exit", reason);
  }
};
function fevalError(result) {
  const e = result?.error;
  if (!e || typeof e !== "object") {
    return void 0;
  }
  return new MatlabError(e.id ?? e.identifier ?? "", e.msg ?? e.message ?? "MATLAB error");
}
function fevalOutputs(result) {
  if (result && typeof result === "object" && !Array.isArray(result) && "result" in result) {
    const r = result.result;
    return Array.isArray(r) ? r : [r];
  }
  if (Array.isArray(result)) {
    return result;
  }
  return result === void 0 || result === null ? [] : [result];
}
function completionItems(result) {
  const items = Array.isArray(result) ? result : result?.items;
  if (!Array.isArray(items)) {
    return void 0;
  }
  return items.filter((i) => !!i && typeof i.label === "string").map((i) => ({ label: i.label, kind: KIND[i.kind ?? 0] ?? "F" }));
}

// src/backend/sharedSession.ts
var fs2 = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
function sessionFilePath(env = process.env, platform = process.platform) {
  if (env.MCW_SESSION_FILE) {
    return env.MCW_SESSION_FILE;
  }
  let dir;
  if (platform === "win32") {
    dir = path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "MathWorks", "MATLAB MCP Server");
  } else if (platform === "darwin") {
    dir = path.join(env.HOME ?? os.homedir(), "Library", "Application Support", "MathWorks", "MATLAB MCP Server");
  } else {
    dir = path.join(env.HOME ?? os.homedir(), ".MathWorks", "MATLABMCPServer");
  }
  return path.join(dir, "v1", "sessionDetails.json");
}
function readSharedSession(file = sessionFilePath(), alive = processAlive) {
  let text;
  let mtimeMs;
  try {
    text = fs2.readFileSync(file, "utf8");
    mtimeMs = fs2.statSync(file).mtimeMs;
  } catch {
    return { ok: false, reason: "missing", file, message: "No shared MATLAB session found." };
  }
  let d;
  try {
    d = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { ok: false, reason: "invalid", file, message: `The shared-session file is not valid JSON: ${file}` };
  }
  const port = Number(d.port), pid = Number(d.pid);
  const certificate = typeof d.certificate === "string" ? d.certificate : "";
  const apiKey = typeof d.apiKey === "string" ? d.apiKey : "";
  if (!port || !certificate || !apiKey) {
    return { ok: false, reason: "invalid", file, message: `The shared-session file lacks port, certificate or apiKey: ${file}` };
  }
  if (pid && !alive(pid)) {
    return { ok: false, reason: "stale", file, message: `The MATLAB that was shared (process ${pid}) is no longer running.` };
  }
  return {
    ok: true,
    session: { port, certificate, apiKey, pid, basePath: typeof d.basePath === "string" ? d.basePath : "", file, mtimeMs }
  };
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// src/matlabSession.ts
var import_events2 = require("events");

// src/commandQueue.ts
var CommandQueue = class {
  // the interpreter is at a prompt that accepts input
  /** `send` writes a job's line to the interpreter; it is called at most once per job, one job at a time. */
  constructor(send) {
    this.send = send;
  }
  send;
  pending = [];
  inFlight;
  open = false;
  /** The job whose line was sent and is waiting for its prompt. */
  get current() {
    return this.inFlight;
  }
  /** Jobs waiting to be sent (not counting the current one). */
  get waiting() {
    return this.pending.length;
  }
  /** Current plus waiting jobs. */
  get size() {
    return this.pending.length + (this.inFlight ? 1 : 0);
  }
  /** True when nothing is running or queued and the interpreter accepts input. */
  get idle() {
    return this.open && !this.inFlight && !this.pending.length;
  }
  /** True when the interpreter accepts input and no command (as opposed to a hidden query) is running or queued. */
  get commandFree() {
    return this.open && this.inFlight?.kind !== "command" && !this.pending.some((j) => j.kind === "command");
  }
  /**
   * Queue a job. Returns false (and does not keep the job) for a background job that cannot run right away;
   * the caller then reports it as skipped.
   */
  push(job) {
    if (job.kind === "background" && !this.commandFree) {
      return false;
    }
    this.pending.push(job);
    this.pump();
    return true;
  }
  /**
   * The interpreter showed a prompt (or became ready for the first time, with `open` true). Returns the job
   * that this prompt finished, if any, and sends the next job. `open` is false when the prompt does not take
   * new commands (e.g. the interpreter is shutting down). `beforeNext` runs after the current job is finished
   * (no longer counted in `size`) and before the next one is sent.
   */
  prompt(open = true, beforeNext) {
    const done = this.inFlight;
    this.inFlight = void 0;
    this.open = open;
    beforeNext?.(done);
    this.pump();
    return done;
  }
  /** Drop the jobs that have not been sent yet (e.g. after an interrupt). Returns them. */
  cancelWaiting() {
    return this.pending.splice(0);
  }
  /** Drop everything, including the current job (the interpreter is gone). Returns them, current first. */
  cancelAll() {
    const all = this.inFlight ? [this.inFlight, ...this.pending] : [...this.pending];
    this.inFlight = void 0;
    this.pending.length = 0;
    this.open = false;
    return all;
  }
  pump() {
    if (this.inFlight || !this.open) {
      return;
    }
    const next = this.pending.shift();
    if (!next) {
      return;
    }
    this.inFlight = next;
    this.send(next);
  }
};

// src/matlabSession.ts
var PROMPT_SETTLE_MS = 60;
var MatlabSession = class extends import_events2.EventEmitter {
  constructor(backend, log = () => void 0) {
    super();
    this.backend = backend;
    this.log = log;
    this.ready = new Promise((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.ready.catch(() => {
    });
    backend.on("output", (text, stream) => {
      if (this._state !== "exited") {
        this.emit("output", text, stream);
      }
    });
    backend.on("prompt", (state, isIdle) => this.onPrompt(state, isIdle));
    backend.on("inputPrompt", (p) => {
      this.inputPrompt = p;
    });
    backend.on("clc", () => this.emit("clear"));
    backend.on("exit", (reason) => this.handleExit(reason));
    backend.on("log", (m) => this.log(m));
  }
  backend;
  log;
  _state = "starting";
  queue = new CommandQueue((p) => this.send(p));
  lastPrompt = "INITIALIZING";
  inputPrompt = "";
  _release = null;
  ready;
  readyResolve;
  readyReject;
  on(event, listener) {
    return super.on(event, listener);
  }
  get state() {
    return this._state;
  }
  get release() {
    return this._release;
  }
  /** Jobs running or waiting. */
  get queuedCount() {
    return this.queue.size;
  }
  /** Start MATLAB. Resolves when it accepts commands. */
  async start() {
    try {
      const info = await this.backend.start();
      this._release = info.release;
    } catch (e) {
      this.readyReject(e);
      this.handleExit(e.message);
      throw e;
    }
    if (this._state === "exited") {
      const e = new Error("MATLAB exited during startup.");
      this.readyReject(e);
      throw e;
    }
    this.setState(this.lastPrompt === "DEBUG" ? "debug" : "idle");
    this.readyResolve();
    this.queue.prompt(true);
  }
  /**
   * Queue code to run as if typed at the prompt. Resolves with the prompt MATLAB showed afterwards
   * ('ready', 'debug' = stopped in the debugger at K>>, 'cancelled' = dropped by interrupt/exit).
   */
  sendLine(code, onSend) {
    if (this._state === "exited") {
      return Promise.resolve("cancelled");
    }
    return new Promise((resolve2) => {
      this.queue.push({ kind: "command", line: code, onSend, resolveCommand: resolve2 });
    });
  }
  /**
   * Call a MATLAB function without echo (a hidden query). A `background` query (completion, help tooltip) only
   * runs when MATLAB is idle with nothing queued; otherwise it resolves at once with `skipped`.
   */
  query(fn, args = [], opts = {}) {
    if (this._state === "exited") {
      return Promise.resolve({ ok: false, outputs: [], cancelled: true });
    }
    const skipped = { ok: false, outputs: [], skipped: true };
    if (opts.background && this._state !== "idle" && this._state !== "debug") {
      return Promise.resolve(skipped);
    }
    return new Promise((resolve2) => {
      const accepted = this.queue.push({
        kind: opts.background ? "background" : "query",
        line: fn,
        fn,
        args,
        nargout: opts.nargout ?? 1,
        resolveQuery: (r) => resolve2(r)
      });
      if (!accepted) {
        resolve2(skipped);
      }
    });
  }
  /** MATLAB's own completion (background: only when idle). */
  async complete(code, offset) {
    if (this._state !== "idle" && this._state !== "debug" || this.queue.size > 0 || !this.backend.complete) {
      return void 0;
    }
    return this.backend.complete(code, offset);
  }
  /** Answer input() (state 'input') or continue after pause (state 'pause'). False when nothing waits. */
  sendInput(text) {
    if (this._state === "input") {
      this.setState("busy");
      void this.backend.eval(text.replace(/\r?\n/g, " ")).catch(() => void 0);
      return true;
    }
    if (this._state === "pause") {
      this.setState("busy");
      this.backend.unpause();
      return true;
    }
    return false;
  }
  /** Ctrl+C: drop queued jobs and interrupt the running one. */
  interrupt() {
    if (this._state === "exited") {
      return;
    }
    for (const p of this.queue.cancelWaiting()) {
      this.finish(p, "cancelled");
    }
    this.backend.interrupt();
  }
  dispose() {
    this.backend.dispose();
    this.handleExit("stopped");
  }
  // ---------- internals ----------
  /** Called by the queue when it is this job's turn. */
  send(p) {
    if (p.kind === "command") {
      try {
        p.onSend?.();
      } catch (e) {
        this.log(`onSend failed: ${e.message}`);
      }
      this.setState("busy");
      p.sawBusy = false;
      this.backend.eval(p.line).then(() => this.onEvalResponse(p), () => this.finish(p, "cancelled"));
      return;
    }
    this.backend.feval(p.fn, p.nargout ?? 1, p.args ?? []).then(
      (outputs) => this.finishQuery(p, { ok: true, outputs }),
      (e) => this.finishQuery(p, e instanceof MatlabError ? { ok: false, outputs: [], error: e } : { ok: false, outputs: [], cancelled: true })
    );
  }
  onPrompt(state, isIdle) {
    this.lastPrompt = state;
    if (this._state === "exited" || this._state === "starting") {
      return;
    }
    const cur = this.queue.current;
    const command = cur?.kind === "command" ? cur : void 0;
    if (cur && !command) {
      return;
    }
    if (state === "INPUT") {
      this.setState("input");
      this.emit("input", "input", this.inputPrompt);
      this.inputPrompt = "";
      return;
    }
    if (state === "PAUSE") {
      this.setState("pause");
      this.emit("input", "pause", "");
      return;
    }
    if (isIdle || state === "READY" || state === "DEBUG") {
      const kind = state === "DEBUG" ? "debug" : "ready";
      if (command) {
        if (command.sawBusy) {
          this.finish(command, kind);
        }
        return;
      }
      this.setState(kind === "debug" ? "debug" : "idle");
      return;
    }
    if (command) {
      command.sawBusy = true;
    }
    this.setState("busy");
  }
  onEvalResponse(p) {
    if (p.finished) {
      return;
    }
    setTimeout(() => {
      if (p.finished) {
        return;
      }
      this.finish(p, this.lastPrompt === "DEBUG" ? "debug" : "ready");
    }, PROMPT_SETTLE_MS);
  }
  finish(p, kind) {
    if (p.finished) {
      return;
    }
    p.finished = true;
    if (this.queue.current === p) {
      if (kind !== "cancelled") {
        this.setState(kind === "debug" ? "debug" : "idle");
      }
      this.queue.prompt(this._state !== "exited", (done) => {
        done?.resolveCommand?.(kind);
        if (kind !== "cancelled") {
          this.emit("prompt", kind, false);
        }
      });
    } else {
      p.resolveCommand?.(kind);
    }
  }
  finishQuery(p, r) {
    if (p.finished) {
      return;
    }
    p.finished = true;
    if (this.queue.current === p) {
      this.queue.prompt(this._state !== "exited", (done) => {
        done?.resolveQuery?.(r);
        if (!r.cancelled) {
          this.emit("prompt", this._state === "debug" ? "debug" : "ready", true);
        }
      });
    } else {
      p.resolveQuery?.(r);
    }
  }
  setState(s) {
    if (this._state === s || this._state === "exited") {
      return;
    }
    this._state = s;
    this.emit("state", s);
  }
  handleExit(reason) {
    if (this._state === "exited") {
      return;
    }
    this.log(`MATLAB session ended: ${reason}`);
    this._state = "exited";
    this.emit("state", "exited");
    this.readyReject(new Error(`MATLAB exited: ${reason}`));
    for (const p of this.queue.cancelAll()) {
      p.finished = true;
      p.resolveCommand?.("cancelled");
      p.resolveQuery?.({ ok: false, outputs: [], cancelled: true });
    }
    this.emit("exit", reason);
  }
};

// spike/spike.ts
var argv = process.argv.slice(2);
var opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : void 0;
};
var T0 = Date.now();
var trace = [];
var results = [];
var lsLog = [];
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var now = () => Date.now() - T0;
function say(m) {
  console.log(`[${(now() / 1e3).toFixed(1)}s] ${m}`);
}
function findServer() {
  const explicit = opt("--server");
  if (explicit) {
    return path2.resolve(explicit);
  }
  const roots = [".vscode", ".vscode-insiders", ".cursor", ".windsurf"].map((d) => path2.join(os2.homedir(), d, "extensions"));
  const found = [];
  for (const r of roots) {
    let names = [];
    try {
      names = fs3.readdirSync(r);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = /^mathworks\.language-matlab-(\d+)\.(\d+)\.(\d+)/i.exec(n);
      const p = path2.join(r, n, "server", "out", "index.js");
      if (m && fs3.existsSync(p)) {
        found.push({ p, v: m.slice(1).map(Number) });
      }
    }
  }
  found.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return found[0]?.p;
}
var mark = (label) => {
  trace.push({ t: now(), dir: "##", msg: label });
  return trace.length;
};
var received = (from) => trace.slice(from).filter((e) => e.dir === "<-");
function short(e) {
  const m = e.msg ?? {};
  const p = m.params;
  let detail;
  switch (m.method) {
    case "text":
      detail = `stream=${p?.stream} ${JSON.stringify(p?.text)}`;
      break;
    case "mvmPromptChange":
      detail = `${p?.state} isIdle=${p?.isIdle}`;
      break;
    case "evalResponse":
    case "evalRequest":
      detail = `id=${p?.requestId}${p?.command !== void 0 ? " " + JSON.stringify(p.command) : ""}`;
      break;
    case "fevalResponse":
      detail = `id=${p?.requestId} result=${JSON.stringify(p?.result).slice(0, 400)}`;
      break;
    case "fevalRequest":
      detail = `id=${p?.requestId} ${p?.functionName}(${JSON.stringify(p?.args).slice(0, 200)}) nargout=${p?.nargout}`;
      break;
    default:
      detail = JSON.stringify(p ?? m.result ?? m.error ?? "").slice(0, 300);
  }
  return `${String(e.t).padStart(7)}ms ${e.dir} ${m.method ?? (m.id !== void 0 ? `response#${m.id}` : "?")} ${detail}`;
}
var eventsFrom = (from) => trace.slice(from).filter((e) => e.dir !== "##" && !/telemetry|logMessage|connection\/update/.test(e.msg?.method ?? "")).map(short);
async function waitMsg(from, pred, ms) {
  const end = Date.now() + ms;
  for (; ; ) {
    const hit = received(from).find((e) => pred(e.msg));
    if (hit) {
      return hit.msg;
    }
    if (Date.now() > end) {
      return void 0;
    }
    await sleep(20);
  }
}
var isPrompt = (state) => (m) => m.method === "mvmPromptChange" && (!state || m.params?.state === state);
var isIdlePrompt = (m) => m.method === "mvmPromptChange" && m.params?.isIdle === true;
var lastEvalId = (from) => [...trace.slice(from)].reverse().find((e) => e.dir === "->" && e.msg?.method === "evalRequest")?.msg.params.requestId;
var texts = (from) => received(from).filter((e) => e.msg.method === "text").map((e) => e.msg.params.text).join("");
function record(id, title, ok, finding, from, data) {
  results.push({ id, title, ok, finding, events: from !== void 0 ? eventsFrom(from) : void 0, data });
  say(`${id} ${ok === true ? "OK  " : ok === false ? "FAIL" : "INFO"} ${title}: ${finding}`);
}
async function probe(id, title, fn) {
  try {
    await fn();
  } catch (e) {
    record(id, title, false, `probe crashed: ${e.stack ?? e}`);
  }
}
async function main() {
  const server = findServer();
  if (!server) {
    console.error("Could not find the MATLAB extension's language server. Install the MATLAB extension (MathWorks.language-matlab) in VS Code, or pass --server <path to server\\out\\index.js>.");
    process.exit(2);
  }
  const lookup = readSharedSession();
  if (!lookup.ok) {
    console.error(`${lookup.message} (looked in ${lookup.file})
In VS Code, open a .m file so the MATLAB extension starts MATLAB, then in its MATLAB terminal run:  shareMATLABSession()
(It comes with MathWorks' MATLAB MCP Server Toolbox, installed by the MATLAB Agentic Toolkit or "matlab-mcp-server --setup-matlab".)`);
    process.exit(2);
  }
  const shared = lookup.session;
  const work = fs3.mkdtempSync(path2.join(os2.tmpdir(), "mcw-spike-"));
  writeProbeFiles(work);
  say(`language server: ${server}`);
  say(`shared MATLAB: process ${shared.pid}, connector port ${shared.port}, base path ${JSON.stringify(shared.basePath)} (${sessionFilePath()})`);
  say(`work folder (added to the MATLAB path during the spike): ${work}`);
  sharedPid = shared.pid;
  const backend = new LsBackend({
    serverPath: server,
    attach: shared,
    cwd: work,
    execPath: process.execPath,
    startTimeoutMs: 12e4,
    trace: (dir, msg) => trace.push({ t: now(), dir, msg })
  });
  backend.on("log", (m) => lsLog.push(`${now()}ms ${m}`));
  const session = new MatlabSession(backend, (m) => lsLog.push(`${now()}ms [session] ${m}`));
  let from = mark("S1");
  say("Attaching to the shared MATLAB\u2026");
  const t1 = Date.now();
  try {
    await session.start();
  } catch (e) {
    record("S1", "attach to the shared MATLAB (relay + language server with --matlabUrl)", false, e.message, from);
    return finish(server, work);
  }
  record(
    "S1",
    "attach to the shared MATLAB (relay + language server with --matlabUrl)",
    true,
    `connected after ${((Date.now() - t1) / 1e3).toFixed(1)} s, release ${session.release}`,
    from,
    { ms: Date.now() - t1, release: session.release }
  );
  await sleep(3e3);
  results[results.length - 1].events = eventsFrom(from);
  await backend.feval("addpath", 0, [work]).catch((e) => say(`addpath failed: ${e}`));
  if (!argv.includes("--no-manual")) {
    await probe("A1", "output of commands typed in the MATLAB extension's terminal reaches our window", async () => {
      from = mark("A1");
      say(">>> NOW: in VS Code's MATLAB terminal (the MATLAB extension's), type   disp('hello from the official terminal')   and press Enter. Waiting 45 s\u2026");
      const got = await waitMsg(from, (m) => m.method === "text" && /hello from the official terminal/.test(m.params?.text ?? ""), 45e3);
      const prompts = received(from).map((e) => e.msg).filter(isPrompt()).map((m) => m.params.state);
      record(
        "A1",
        "output of commands typed in the MATLAB extension's terminal reaches our window",
        got ? true : null,
        got ? "yes, the text arrived here too" : "no text arrived here within 45 s (either not typed, or each client only gets its own output)",
        from,
        { promptsSeen: prompts }
      );
    });
  }
  await probe("S2", "prompt states and output for a simple command", async () => {
    from = mark("S2");
    void backend.eval("spikeX = 1 + 1");
    const resp = await waitMsg(from, (m) => m.method === "evalResponse", 15e3);
    await sleep(500);
    const ev = received(from).map((e) => e.msg);
    const states = ev.filter(isPrompt()).map((m) => `${m.params.state}/${m.params.isIdle}`);
    record(
      "S2",
      "prompt states and output for a simple command",
      !!resp && /spikeX\s*=\s*\n*\s*2/.test(texts(from)),
      `prompt changes: ${states.join(" -> ") || "(none)"}; output ${JSON.stringify(texts(from))}`,
      from
    );
  });
  await probe("S3", "order of evalResponse and the final idle prompt", async () => {
    from = mark("S3");
    void backend.eval("pause(0.5)");
    await waitMsg(from, (m) => m.method === "evalResponse", 15e3);
    await sleep(500);
    const order = received(from).map((e) => e.msg).filter((m) => m.method === "evalResponse" || isIdlePrompt(m)).map((m) => m.method === "evalResponse" ? "evalResponse" : `prompt ${m.params.state}`);
    record("S3", "order of evalResponse and the final idle prompt", null, order.join(" then ") || "(no events)", from);
  });
  await probe("S4", "do hidden fevals change the prompt state?", async () => {
    from = mark("S4");
    const r = await backend.feval("pwd", 1, []);
    await sleep(300);
    const prompts = received(from).map((e) => e.msg).filter(isPrompt());
    record(
      "S4",
      "do hidden fevals change the prompt state?",
      null,
      prompts.length ? `yes: ${prompts.map((m) => m.params.state).join(" -> ")}` : "no prompt changes",
      from,
      r
    );
  });
  await probe("S5", "feval result and error shapes (pwd, who, an error)", async () => {
    from = mark("S5");
    const raw = (name) => received(from).filter((e) => e.msg.method === "fevalResponse").map((e) => e.msg.params.result).slice(-1)[0];
    const pwd = await backend.feval("pwd", 1, []).catch((e) => e);
    const pwdRaw = raw("pwd");
    const err = await backend.feval("mcw_no_such_function", 1, []).catch((e) => e);
    const errRaw = raw("err");
    const who = await backend.feval("who", 1, []).catch((e) => e);
    const whoRaw = raw("who");
    const ok = Array.isArray(pwd) && typeof pwd[0] === "string" && err instanceof Error && Array.isArray(who);
    record(
      "S5",
      "feval result and error shapes (pwd, who, an error)",
      ok,
      `pwd raw result ${JSON.stringify(pwdRaw)}; who raw ${JSON.stringify(whoRaw).slice(0, 300)}; error raw ${JSON.stringify(errRaw)}`,
      from,
      { pwdRaw, errRaw, whoRaw }
    );
  });
  await probe("S6", "keyboard / K>>: states, DebuggingStateChange, when evalResponses come", async () => {
    from = mark("S6");
    void backend.eval(`spike_keyboard_fn()`);
    const dbg = await waitMsg(from, isPrompt("DEBUG"), 15e3);
    const kbId = lastEvalId(from);
    await sleep(300);
    const mid = mark("S6 at K>>");
    void backend.eval("spikeInDebug = localVar * 2");
    await waitMsg(mid, (m) => m.method === "evalResponse", 1e4);
    await sleep(300);
    const cont = mark("S6 dbcont");
    void backend.eval("dbcont");
    await waitMsg(cont, isPrompt("READY"), 15e3);
    await sleep(500);
    const kbResp = received(from).some((e) => e.msg.method === "evalResponse" && e.msg.params.requestId === kbId);
    record(
      "S6",
      "keyboard / K>>: states, DebuggingStateChange, when evalResponses come",
      !!dbg,
      `DEBUG prompt: ${!!dbg}; command at K>> output ${JSON.stringify(texts(mid).slice(0, 200))}; original eval's evalResponse received after dbcont: ${kbResp}`,
      from
    );
  });
  await probe("S7", "input(): prompt string, INPUT state, answering with evalRequest", async () => {
    from = mark("S7");
    void backend.eval("spikeAnswer = input('Spike asks: ')");
    const inputPrompt = await waitMsg(from, (m) => m.method === "mvmInputPrompt", 1e4);
    const inState = await waitMsg(from, isPrompt("INPUT"), 1e4);
    await sleep(300);
    const printedPrompt = texts(from).includes("Spike asks");
    const ans = mark("S7 answer");
    void backend.eval("41 + 1");
    await waitMsg(ans, isPrompt("READY"), 1e4);
    await sleep(500);
    const v = await backend.feval("evalc", 1, ["disp(spikeAnswer)"]).catch((e) => e);
    record(
      "S7",
      "input(): prompt string, INPUT state, answering with evalRequest",
      !!inState && /42/.test(String(v)),
      `mvmInputPrompt ${JSON.stringify(inputPrompt?.params)}; INPUT state: ${!!inState}; value after answer: ${JSON.stringify(String(v)).slice(0, 80)}`,
      from
    );
    record("S8", "does MATLAB also print input()'s prompt as output text?", null, printedPrompt ? "yes (text event contains it)" : "no", from);
  });
  await probe("S9", "error text of a failing script run with run(): frames, hyperlinks, stream", async () => {
    from = mark("S9");
    void backend.eval(`run('${path2.join(work, "spike_error_demo.m").replace(/'/g, "''")}')`);
    await waitMsg(from, isPrompt("READY"), 15e3);
    await sleep(500);
    const errText = received(from).filter((e) => e.msg.method === "text").map((e) => `[stream ${e.msg.params.stream}] ${e.msg.params.text}`).join("");
    record(
      "S9",
      "error text of a failing script run with run(): frames, hyperlinks, stream",
      null,
      `${/<a href/.test(errText) ? "CONTAINS <a href> hyperlinks" : "plain text (no hyperlinks)"}; ${/Error in spike_error_demo \(line 3\)/.test(errText.replace(/<[^>]+>/g, "")) ? '"Error in spike_error_demo (line 3)" present' : "frame text differs"}`,
      from,
      errText
    );
  });
  await probe("S10", "help text through feval (format for the help tooltip)", async () => {
    from = mark("S10");
    const one = (v) => String(Array.isArray(v) ? v[0] : v);
    const zh = one(await backend.feval("help", 1, ["zeros"]).catch((e) => e));
    const zw = one(await backend.feval("which", 1, ["zeros"]).catch((e) => e));
    const uh = one(await backend.feval("help", 1, ["spike_documented"]).catch((e) => e));
    const uw = one(await backend.feval("which", 1, ["spike_documented"]).catch((e) => e));
    record(
      "S10",
      "help text through feval (format for the help tooltip)",
      zh.length > 20,
      `zeros which=${JSON.stringify(zw)}; first lines ${JSON.stringify(zh.split("\n").slice(0, 8).join("\n"))}; user function which=${JSON.stringify(uw)} help ${JSON.stringify(uh.slice(0, 120))}`,
      from,
      { zerosHelp: zh, zerosWhich: zw, userHelp: uh, userWhich: uw }
    );
  });
  await probe("S11", "warnings and default display formatting", async () => {
    from = mark("S11");
    void backend.eval(`warning('spike warning'); spikeM = magic(3), spikeS = struct('a', 1, 'b', 'text'), spikeStr = "hello"`);
    await waitMsg(from, isPrompt("READY"), 15e3);
    await sleep(500);
    record("S11", "warnings and default display formatting", null, "see raw events", from);
  });
  await probe("S12", "interrupt: pause(30) and a busy loop", async () => {
    from = mark("S12");
    void backend.eval("pause(30)");
    await waitMsg(from, isPrompt("BUSY"), 5e3);
    await sleep(1500);
    let t = Date.now();
    backend.interrupt();
    const r1 = await waitMsg(from, isPrompt("READY"), 15e3);
    const pauseMs = Date.now() - t;
    const from2 = mark("S12 loop");
    void backend.eval("spikeN = 0; while true, spikeN = spikeN + 1; end");
    await sleep(2e3);
    t = Date.now();
    backend.interrupt();
    const r2 = await waitMsg(from2, isPrompt("READY"), 15e3);
    const loopMs = Date.now() - t;
    await sleep(500);
    record(
      "S12",
      "interrupt: pause(30) and a busy loop",
      !!r1 && !!r2,
      `pause: ${r1 ? `READY after ${pauseMs} ms` : "NO READY within 15 s"}; loop: ${r2 ? `READY after ${loopMs} ms` : "NO READY within 15 s"}; printed ${JSON.stringify(texts(from)).slice(0, 200)}`,
      from
    );
  });
  await probe("S13", "fevals at K>> see the stopped frame (Workspace view while debugging)", async () => {
    from = mark("S13");
    void backend.eval("spike_keyboard_fn()");
    await waitMsg(from, isPrompt("DEBUG"), 15e3);
    await sleep(300);
    const v = await backend.feval("who", 1, []).catch((e) => e);
    const listed = JSON.stringify(v);
    const ev = await backend.feval("evalc", 1, ["localVar"]).catch((e) => e);
    void backend.eval("dbquit");
    await waitMsg(mark("S13 quit"), isPrompt("READY"), 15e3);
    record(
      "S13",
      "fevals at K>> see the stopped frame (completion/help while debugging)",
      /localVar/.test(listed),
      `who at K>> ${/localVar/.test(listed) ? "lists the function's localVar" : "does NOT list localVar (it sees another workspace)"}; evalc('localVar') -> ${JSON.stringify(String(ev)).slice(0, 120)}`,
      from,
      listed
    );
  });
  await probe("S14", "MATLAB's own completion (TerminalCompletionRequest)", async () => {
    from = mark("S14");
    await backend.eval("spikeStruct = struct('alpha', 1, 'beta', 2);");
    await sleep(300);
    const a = await backend.complete("spikeSt", 7);
    const b = await backend.complete("spikeStruct.al", 14);
    const c = await backend.complete("zer", 3);
    const raw = received(from).filter((e) => e.msg.method === "TerminalCompletionResponse").map((e) => e.msg.params);
    record(
      "S14",
      "MATLAB's own completion (TerminalCompletionRequest)",
      !!a?.some((x) => x.label === "spikeStruct") && !!c?.some((x) => x.label === "zeros"),
      `variables: ${JSON.stringify(a?.slice(0, 5))}; fields: ${JSON.stringify(b?.slice(0, 5))}; functions: ${JSON.stringify(c?.slice(0, 5))}`,
      from,
      raw
    );
  });
  await probe("S15", "streaming: output arrives while a command runs", async () => {
    from = mark("S15");
    const t = now();
    void backend.eval("for spikeK = 1:4, disp(spikeK), pause(0.5), end");
    await waitMsg(from, (m) => m.method === "evalResponse", 15e3);
    const times = received(from).filter((e) => e.msg.method === "text").map((e) => e.t - t);
    const spread = times.length >= 4 && times[times.length - 1] - times[0] >= 1e3;
    record("S15", "streaming: output arrives while a command runs", spread, `text event times (ms after send): ${times.join(", ")}`, from);
  });
  await probe("S16", "pause without argument: PAUSE state and unpauseRequest", async () => {
    from = mark("S16");
    void backend.eval("pause; disp('spike after pause')");
    const p = await waitMsg(from, isPrompt("PAUSE"), 8e3);
    await sleep(300);
    backend.unpause();
    const r = await waitMsg(from, isPrompt("READY"), 1e4);
    await sleep(300);
    record(
      "S16",
      "pause without argument: PAUSE state and unpauseRequest",
      !!p && !!r && /spike after pause/.test(texts(from)),
      `PAUSE state: ${!!p}; continued: ${/spike after pause/.test(texts(from))}`,
      from
    );
    if (!r) {
      backend.interrupt();
      await sleep(1e3);
    }
  });
  await probe("S17", "multi-line code in one evalRequest", async () => {
    from = mark("S17");
    void backend.eval("spikeA = 0;\nfor spikeK = 1:3\n    spikeA = spikeA + spikeK;\nend\ndisp(spikeA)\n%% a section marker\nfprintf('done %d\\n', spikeA);");
    await waitMsg(from, isPrompt("READY"), 15e3);
    await sleep(500);
    record("S17", "multi-line code in one evalRequest", /6/.test(texts(from)) && /done 6/.test(texts(from)), `output ${JSON.stringify(texts(from))}`, from);
  });
  await probe("S18", "clc event", async () => {
    from = mark("S18");
    void backend.eval("clc");
    const c = await waitMsg(from, (m) => m.method === "clc", 8e3);
    await waitMsg(from, isPrompt("READY"), 8e3);
    record("S18", "clc event", !!c, c ? "clc notification received" : "no clc notification", from);
  });
  if (!argv.includes("--no-figure")) {
    await probe("S21", "figures: does plotting work and return to the prompt?", async () => {
      from = mark("S21");
      const t = Date.now();
      void backend.eval("spikeFig = figure('Name', 'MATLAB companion spike'); plot(1:10); drawnow; pause(2); close(spikeFig)");
      const r = await waitMsg(from, isPrompt("READY"), 6e4);
      record(
        "S21",
        "figures: does plotting work and return to the prompt?",
        !!r,
        `${r ? `back at READY after ${Date.now() - t} ms` : "did not return within 60 s"} (watch the screen: a figure window should appear for 2 s)`,
        from
      );
    });
  }
  await probe("S22", "hotlinks setting and edit/which output", async () => {
    from = mark("S22");
    const h = await backend.feval("feature", 1, ["hotlinks"]).catch((e) => String(e));
    void backend.eval("which zeros, spike_missing_function_xyz");
    await waitMsg(from, isPrompt("READY"), 1e4);
    await sleep(300);
    record("S22", "hotlinks setting and edit/which output", null, `feature('hotlinks') = ${JSON.stringify(h)}`, from);
  });
  await probe("S24", "session core end to end (queue, input, keyboard, interrupt, queries)", async () => {
    from = mark("S24");
    const out = [];
    const sub = (t) => out.push(t);
    session.on("output", sub);
    const problems = [];
    const k1 = await session.sendLine("spikeQ = 7");
    if (k1 !== "ready") {
      problems.push(`sendLine -> ${k1}`);
    }
    const [a, b] = await Promise.all([session.sendLine("pause(0.3); disp('q-first')"), session.sendLine("disp('q-second')")]);
    if (a !== "ready" || b !== "ready" || out.join("").indexOf("q-first") > out.join("").indexOf("q-second")) {
      problems.push("queue order");
    }
    const asking = session.sendLine("spikeQ2 = input('session asks: ')");
    for (let i = 0; i < 100 && session.state !== "input"; i++) {
      await sleep(50);
    }
    if (session.state !== "input") {
      problems.push(`state ${session.state} instead of input`);
    } else {
      session.sendInput("3");
    }
    if (await asking !== "ready") {
      problems.push("input run did not finish ready");
    }
    const kb = await session.sendLine("spike_keyboard_fn()");
    if (kb !== "debug") {
      problems.push(`keyboard -> ${kb}`);
    }
    const q = await session.query("who", [], { background: true });
    if (!q.ok) {
      problems.push("query at K>> failed");
    }
    if (await session.sendLine("dbcont") !== "ready") {
      problems.push("dbcont did not end ready");
    }
    const long = session.sendLine("pause(20)");
    await sleep(1e3);
    session.interrupt();
    if (await long !== "ready") {
      problems.push("interrupt did not end ready");
    }
    if (session.state !== "idle") {
      problems.push(`final state ${session.state}`);
    }
    record(
      "S24",
      "session core end to end (queue, input, keyboard, interrupt, queries)",
      problems.length === 0,
      problems.length ? problems.join("; ") : "all steps behaved as the extension expects",
      from
    );
  });
  return finish(server, work, session);
}
function writeProbeFiles(dir) {
  fs3.writeFileSync(path2.join(dir, "spike_error_demo.m"), "% Fails on line 3.\nspikeE = 1;\nspikeE = spike_undefined_thing + spikeE;\n");
  fs3.writeFileSync(path2.join(dir, "spike_keyboard_fn.m"), "function spike_keyboard_fn()\n%SPIKE_KEYBOARD_FN  Stops at keyboard with a local variable.\nlocalVar = 21;\nkeyboard\ndisp(localVar)\nend\n");
  fs3.writeFileSync(path2.join(dir, "spike_documented.m"), "function y = spike_documented(x)\n%SPIKE_DOCUMENTED  Doubles X.\n%   Y = SPIKE_DOCUMENTED(X) returns 2*X.\ny = 2 * x;\nend\n");
}
var sharedPid = 0;
async function finish(server, work, session) {
  if (session && session.state !== "exited") {
    await session.query("rmpath", [work], { nargout: 0 }).catch(() => void 0);
  }
  session?.dispose();
  await sleep(3e3);
  if (sharedPid) {
    const alive = processAlive(sharedPid);
    results.push({
      id: "A2",
      title: "after we disconnect, the shared MATLAB keeps running",
      ok: alive,
      finding: alive ? `process ${sharedPid} still running \u2014 now check that the MATLAB extension's terminal still works (type 1+1 there)` : `process ${sharedPid} is GONE`
    });
    say(`A2 ${alive ? "OK  " : "FAIL"} after we disconnect, the shared MATLAB keeps running`);
  }
  const dir = path2.join(__dirname, "results");
  fs3.mkdirSync(dir, { recursive: true });
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const env = {
    date: (/* @__PURE__ */ new Date()).toISOString(),
    os: `${os2.type()} ${os2.release()} ${os2.arch()}`,
    node: process.version,
    server,
    extensionVersion: /language-matlab-([\d.]+)/i.exec(server)?.[1] ?? "unknown",
    work
  };
  fs3.writeFileSync(path2.join(dir, `spike-${stamp}.json`), JSON.stringify({ env, results, trace, lsLog }, null, 1));
  const md = [
    `# MATLAB companion spike results (${env.date})`,
    "",
    `- OS: ${env.os}, Node ${env.node}`,
    `- Language server: ${server} (extension ${env.extensionVersion})`,
    "",
    "| Check | Result | Finding |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.id} ${r.title} | ${r.ok === true ? "OK" : r.ok === false ? "**FAIL**" : "info"} | ${r.finding.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
    "## Raw events per check",
    ""
  ];
  for (const r of results) {
    md.push(`### ${r.id} ${r.title}`, "", "```", ...(r.events ?? []).slice(0, 120), "```", "");
    if (r.data !== void 0) {
      md.push("Data:", "```", JSON.stringify(r.data, null, 1).slice(0, 4e3), "```", "");
    }
  }
  md.push("## Language server log (last 200 lines)", "", "```", ...lsLog.slice(-200), "```", "");
  const mdFile = path2.join(dir, `spike-${stamp}.md`);
  fs3.writeFileSync(mdFile, md.join("\n"));
  say(`Results written to ${mdFile} (and the raw trace to the .json next to it).`);
  say(`${results.filter((r) => r.ok === true).length} OK, ${results.filter((r) => r.ok === false).length} FAIL, ${results.filter((r) => r.ok === null).length} info.`);
  process.exit(0);
}
process.on("SIGINT", () => {
  say("Interrupted; writing partial results.");
  void finish(findServer() ?? "?", "?");
});
main().catch((e) => {
  console.error(e);
  void finish(findServer() ?? "?", "?");
});
