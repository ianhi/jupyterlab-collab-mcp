/**
 * KernelClient: a long-lived multiplexed WebSocket to a single Jupyter kernel.
 *
 * Phase 1 scope: one persistent `/api/kernels/{id}/channels` socket per
 * kernelId. Concurrent `run()` calls are multiplexed by `msg_id`: each run
 * has its own header msg_id and only consumes messages whose
 * `parent_header.msg_id` matches. The kernel still executes serially, but
 * callers don't need to coordinate — they just `await client.run(code, ms)`.
 *
 * Timeouts reject the specific run only; the kernel keeps running the cell
 * (that orphan path is the seam Phase 2 turns into the handoff mechanism).
 * WebSocket close/error rejects every in-flight run because the kernel is
 * gone or unreachable.
 */
import WebSocketImpl from "ws";
import crypto from "node:crypto";
import {
  stripAnsi,
  type ExecutionResult,
  type NotebookOutput,
} from "./helpers.js";
import type { JupyterConfig } from "./connection.js";

/**
 * Minimal WebSocket surface KernelClient depends on. The real `ws` library
 * implements this, and tests can substitute a stub.
 */
export interface KernelWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => KernelWebSocket;

const defaultFactory: WebSocketFactory = (url) =>
  new WebSocketImpl(url) as unknown as KernelWebSocket;

interface InFlightRun {
  msgId: string;
  outputs: NotebookOutput[];
  textParts: string[];
  images: { data: string; mimeType: string }[];
  htmlParts: string[];
  status: "ok" | "error";
  executionCount: number | null;
  resolve: (r: ExecutionResult) => void;
  reject: (e: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

type WSState = "idle" | "connecting" | "open" | "closed";

export interface KernelClientOptions {
  /** Inject a WebSocket factory (defaults to real `ws`). */
  wsFactory?: WebSocketFactory;
  /**
   * Optional callback fired exactly once when this client's WS closes (either
   * remote close, error, or local `close()`). The pool uses this to evict the
   * client so the next `run()` opens a fresh socket.
   */
  onClose?: (reason: string) => void;
  /** How long to wait for the WS to open before failing pending runs. */
  openTimeoutMs?: number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

export class KernelClient {
  private readonly _kernelId: string;
  private readonly config: JupyterConfig;
  private readonly wsFactory: WebSocketFactory;
  private readonly onCloseCb: ((reason: string) => void) | undefined;
  private readonly openTimeoutMs: number;

  private ws: KernelWebSocket | null = null;
  private state: WSState = "idle";
  private openWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly inFlight = new Map<string, InFlightRun>();
  private _lastActivityAt = Date.now();
  private closeNotified = false;

  constructor(
    kernelId: string,
    config: JupyterConfig,
    options: KernelClientOptions = {}
  ) {
    this._kernelId = kernelId;
    this.config = config;
    this.wsFactory = options.wsFactory ?? defaultFactory;
    this.onCloseCb = options.onClose;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  }

  get kernelId(): string {
    return this._kernelId;
  }

  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  isHealthy(): boolean {
    return this.state === "open" && this.ws !== null;
  }

  run(code: string, timeoutMs: number): Promise<ExecutionResult> {
    // Kick off WS open synchronously so the pool sees a connecting client
    // even before the caller awaits — tests and idle eviction both rely on
    // `factoryCalls`/state being observable on the same tick.
    const opening = this.ensureOpen();
    return opening.then(() => this.sendRequest(code, timeoutMs));
  }

  private sendRequest(code: string, timeoutMs: number): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve, reject) => {
      const msgId = crypto.randomUUID();
      const run: InFlightRun = {
        msgId,
        outputs: [],
        textParts: [],
        images: [],
        htmlParts: [],
        status: "ok",
        executionCount: null,
        resolve,
        reject,
        timeoutId: null,
      };
      this.inFlight.set(msgId, run);

      const timeoutSecs = Math.max(1, Math.round(timeoutMs / 1000));
      run.timeoutId = setTimeout(() => {
        // Reject only this run; the WS stays open and the kernel keeps
        // executing this cell. Phase 2 will turn the orphan into a handoff.
        if (this.inFlight.delete(msgId)) {
          run.reject(new Error(`Execution timeout after ${timeoutSecs} seconds`));
        }
      }, timeoutMs);

      const msg = {
        header: {
          msg_id: msgId,
          msg_type: "execute_request",
          username: "claude",
          session: crypto.randomUUID(),
          date: new Date().toISOString(),
          version: "5.3",
        },
        parent_header: {},
        metadata: {},
        content: {
          code,
          silent: false,
          store_history: true,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: true,
        },
        buffers: [],
        channel: "shell",
      };

      try {
        this.ws!.send(JSON.stringify(msg));
        this._lastActivityAt = Date.now();
      } catch (err) {
        if (this.inFlight.delete(msgId)) {
          if (run.timeoutId) clearTimeout(run.timeoutId);
          run.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  close(reason: string = "client closed"): void {
    this.failAllInFlight(reason);
    this.failAllOpenWaiters(new Error(reason));
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (this.state !== "closed") {
      this.state = "closed";
      try {
        ws?.close();
      } catch {
        // Ignore — already torn down
      }
      this.notifyClose(reason);
    }
  }

  private ensureOpen(): Promise<void> {
    if (this.state === "open") return Promise.resolve();
    if (this.state === "closed") {
      return Promise.reject(new Error("KernelClient is closed"));
    }
    if (this.state === "connecting") {
      return new Promise<void>((resolve, reject) => {
        this.openWaiters.push({ resolve, reject });
      });
    }

    // state === "idle": open lazily
    this.state = "connecting";
    const url = `${this.config.wsUrl}/api/kernels/${this._kernelId}/channels?token=${this.config.token}`;
    let ws: KernelWebSocket;
    try {
      ws = this.wsFactory(url);
    } catch (err) {
      this.state = "closed";
      const e = err instanceof Error ? err : new Error(String(err));
      this.notifyClose(`open failed: ${e.message}`);
      throw e;
    }
    this.ws = ws;

    ws.on("open", () => {
      if (this.openTimer) {
        clearTimeout(this.openTimer);
        this.openTimer = null;
      }
      this.state = "open";
      this._lastActivityAt = Date.now();
      const waiters = this.openWaiters;
      this.openWaiters = [];
      for (const w of waiters) w.resolve();
    });

    ws.on("message", (data: unknown) => {
      this._lastActivityAt = Date.now();
      let msg: any;
      try {
        // `data` is typically a Buffer or string from the `ws` library.
        const str =
          typeof data === "string"
            ? data
            : (data as { toString(): string }).toString();
        msg = JSON.parse(str);
      } catch {
        return;
      }
      const parentMsgId = msg?.parent_header?.msg_id;
      if (!parentMsgId) return;
      const run = this.inFlight.get(parentMsgId);
      if (!run) return; // not ours (or already timed out / completed)
      this.ingest(run, msg);
    });

    ws.on("error", (err: Error) => {
      this.handleSocketDown(`ws error: ${err?.message ?? String(err)}`);
    });

    ws.on("close", () => {
      this.handleSocketDown("ws closed");
    });

    this.openTimer = setTimeout(() => {
      if (this.state === "connecting") {
        this.handleSocketDown(`open timeout after ${this.openTimeoutMs}ms`);
      }
    }, this.openTimeoutMs);

    return new Promise<void>((resolve, reject) => {
      this.openWaiters.push({ resolve, reject });
    });
  }

  private ingest(run: InFlightRun, msg: any): void {
    switch (msg.msg_type) {
      case "stream":
        run.outputs.push({
          output_type: "stream",
          name: msg.content.name,
          text: msg.content.text,
        });
        run.textParts.push(stripAnsi(msg.content.text || ""));
        break;

      case "execute_result":
        run.outputs.push({
          output_type: "execute_result",
          execution_count: msg.content.execution_count,
          data: msg.content.data,
          metadata: msg.content.metadata || {},
        });
        run.textParts.push(stripAnsi(msg.content.data?.["text/plain"] || ""));
        if (msg.content.data?.["image/png"]) {
          run.images.push({
            data: msg.content.data["image/png"],
            mimeType: "image/png",
          });
        }
        if (msg.content.data?.["image/jpeg"]) {
          run.images.push({
            data: msg.content.data["image/jpeg"],
            mimeType: "image/jpeg",
          });
        }
        if (msg.content.data?.["text/html"]) {
          run.htmlParts.push(msg.content.data["text/html"]);
        }
        break;

      case "display_data":
        run.outputs.push({
          output_type: "display_data",
          data: msg.content.data,
          metadata: msg.content.metadata || {},
        });
        run.textParts.push(stripAnsi(msg.content.data?.["text/plain"] || ""));
        if (msg.content.data?.["image/png"]) {
          run.images.push({
            data: msg.content.data["image/png"],
            mimeType: "image/png",
          });
        }
        if (msg.content.data?.["image/jpeg"]) {
          run.images.push({
            data: msg.content.data["image/jpeg"],
            mimeType: "image/jpeg",
          });
        }
        if (msg.content.data?.["text/html"]) {
          run.htmlParts.push(msg.content.data["text/html"]);
        }
        break;

      case "error":
        run.status = "error";
        run.outputs.push({
          output_type: "error",
          ename: msg.content.ename,
          evalue: msg.content.evalue,
          traceback: msg.content.traceback,
        });
        run.textParts.push(
          stripAnsi(`${msg.content.ename}: ${msg.content.evalue}`)
        );
        break;

      case "execute_reply": {
        run.executionCount = msg.content.execution_count ?? run.executionCount;
        if (run.timeoutId) clearTimeout(run.timeoutId);
        this.inFlight.delete(run.msgId);
        run.resolve({
          status: run.status,
          executionCount: run.executionCount,
          outputs: run.outputs,
          text: run.textParts.join(""),
          images: run.images,
          html: run.htmlParts,
        });
        break;
      }
    }
  }

  private handleSocketDown(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.failAllInFlight(reason);
    this.failAllOpenWaiters(new Error(reason));
    this.ws = null;
    this.notifyClose(reason);
  }

  private failAllInFlight(reason: string): void {
    if (this.inFlight.size === 0) return;
    const runs = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const run of runs) {
      if (run.timeoutId) clearTimeout(run.timeoutId);
      run.reject(new Error(`kernel ${this._kernelId}: ${reason}`));
    }
  }

  private failAllOpenWaiters(err: Error): void {
    if (this.openWaiters.length === 0) return;
    const waiters = this.openWaiters;
    this.openWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  private notifyClose(reason: string): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    if (this.onCloseCb) {
      try {
        this.onCloseCb(reason);
      } catch {
        // Pool callbacks must not poison the client.
      }
    }
  }
}
