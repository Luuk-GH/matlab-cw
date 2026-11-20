// A minimal JSON-RPC 2.0 peer over a message transport (Node IPC: process.send / 'message' events), which is how
// vscode-languageserver's `--node-ipc` mode exchanges messages (one JSON object per message, no headers).
// No VS Code dependency; unit-tested through the fake language server.

export interface MessageTransport {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; }

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, (params: any) => void>();
  private requestHandler: (method: string, params: unknown) => unknown = () => null;
  private closed = false;

  constructor(private readonly transport: MessageTransport, private readonly log: (m: string) => void = () => undefined) {
    transport.onMessage(m => this.receive(m));
  }

  /** Handle notifications with this method name (one handler per name). */
  onNotification(method: string, handler: (params: any) => void): void { this.notificationHandlers.set(method, handler); }

  /** Answer requests the other side sends (workspace/configuration, window/workDoneProgress/create, ...). */
  onRequest(handler: (method: string, params: unknown) => unknown): void { this.requestHandler = handler; }

  notify(method: string, params?: unknown): void {
    if (this.closed) { return; }
    this.transport.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  request<T>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) { return Promise.reject(new Error('connection closed')); }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: v => resolve(v as T), reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      }
      this.pending.set(id, p);
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** The transport is gone: fail all outstanding requests. */
  close(reason = 'connection closed'): void {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) { return; }
    const m = raw as { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    if (m.method !== undefined && m.id !== undefined) {
      // A request from the other side.
      let result: unknown = null;
      try { result = this.requestHandler(m.method, m.params); } catch (e) { this.log(`request ${m.method} failed: ${(e as Error).message}`); }
      Promise.resolve(result).then(r => this.transport.send({ jsonrpc: '2.0', id: m.id, result: r ?? null }),
        e => this.transport.send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e) } }));
      return;
    }
    if (m.method !== undefined) {
      const h = this.notificationHandlers.get(m.method);
      if (h) {
        try { h(m.params); } catch (e) { this.log(`notification ${m.method} handler failed: ${(e as Error).stack ?? e}`); }
      }
      return;
    }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) { return; }
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) { p.reject(new Error(m.error.message)); } else { p.resolve(m.result); }
    }
  }
}
