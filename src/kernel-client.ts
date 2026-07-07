/**
 * KernelClient: a long-lived multiplexed WebSocket to a single Jupyter kernel.
 *
 * In addition to multiplexing concurrent runs by `msg_id`, each run is tracked
 * as a `Run` state machine: `queued -> running -> completed | failed`, with an
 * extra `handed_off` terminal-for-the-caller state for slow runs.
 *
 * `run(code, opts)` supports two modes:
 *  - `timeoutMs` only (legacy): hard deadline; rejects on exceed.
 *  - `handoffAfterMs` provided: if the run hasn't terminated after
 *    `handoffAfterMs`, resolves with `kind: "handoff"` carrying the
 *    accumulated partial output and the `run_id`. The Run keeps living
 *    inside the client and will transition to `completed`/`failed` when
 *    the kernel finally responds. Subscribers can register via
 *    `onRunSettled` to be notified.
 *
 * Retention: at most MAX_RETAINED_RUNS finished runs kept (LRU), and completed
 * runs older than COMPLETED_RUN_TTL_MS are evicted (both env-configurable).
 * In-flight (queued/running/handed_off) runs are never evicted.
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

export type RunState =
  | "queued"
  | "running"
  | "completed"
  | "handed_off"
  | "failed";

/**
 * A single execute_request lifecycle. Mutable while in-flight; callers
 * should treat it as a snapshot when reading.
 */
export interface Run {
  id: string; // == msgId; exposed externally as run_id
  kernelId: string;
  state: RunState;
  startedAt: number;
  completedAt?: number;
  outputs: NotebookOutput[];
  executionCount: number | null;
  status: "ok" | "error";
  text: string;
  images: { data: string; mimeType: string }[];
  html: string[];
  /** Final error message if state === "failed". */
  errorMessage?: string;
  /**
   * True if this run was at some point returned to the caller as a handoff
   * (i.e. `RunOutcome` with kind === "handoff"). Even after the run later
   * completes, this flag stays set so the notification layer can know it
   * needs to push a `<channel>` tag.
   */
  wasHandedOff: boolean;
}

/** Partial result returned when a run is handed off mid-execution. */
export interface PartialResult {
  status: "ok" | "error";
  executionCount: number | null;
  outputs: NotebookOutput[];
  text: string;
  images: { data: string; mimeType: string }[];
  html: string[];
}

export type RunOutcome =
  | { kind: "result"; runId: string; result: ExecutionResult }
  | { kind: "handoff"; runId: string; partial: PartialResult };

/**
 * Internal in-flight record. Wraps the user-facing `Run` snapshot plus
 * the pending Promise machinery.
 */
interface InFlightRun {
  run: Run;
  /** Resolver used by `run()`. Set to `null` after first resolution. */
  outcomeResolve: ((o: RunOutcome) => void) | null;
  outcomeReject: ((e: Error) => void) | null;
  /** Whether this run was handed off (i.e. resolved with kind: "handoff"). */
  wasHandedOff: boolean;
  hardTimer: ReturnType<typeof setTimeout> | null;
  handoffTimer: ReturnType<typeof setTimeout> | null;
  /** True if caller passed `handoffAfterMs`. */
  handoffEnabled: boolean;
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

export interface RunOptions {
  /** Hard timeout: reject the run if it doesn't finish in this time. */
  timeoutMs?: number;
  /** If set, resolve with `kind: "handoff"` after this many ms instead of rejecting. */
  handoffAfterMs?: number;
  /**
   * Jupyter `store_history` flag (default true). Set false for internal/tooling
   * runs (e.g. kernel-capture install/readback) so they don't bump the kernel's
   * execution_count or appear in In/Out history. Stream output is unaffected.
   */
  storeHistory?: boolean;
}

const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
/** How often to re-send the kernel_info probe until the kernel replies. */
const KERNEL_INFO_RETRY_MS = 500;

/** Parse a positive-integer env override, falling back to `dflt` when unset/invalid. */
function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/**
 * Retention limits for finished runs (in-flight runs are never counted or
 * evicted). Overridable via env for long multi-hour agent sessions:
 *   JUPYTER_MCP_MAX_RETAINED_RUNS   (default 500)
 *   JUPYTER_MCP_RUN_TTL_MS          (default 120 min)
 */
export const MAX_RETAINED_RUNS = envInt("JUPYTER_MCP_MAX_RETAINED_RUNS", 500);
export const COMPLETED_RUN_TTL_MS = envInt(
  "JUPYTER_MCP_RUN_TTL_MS",
  120 * 60 * 1000
);

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
  /**
   * Retry timer for the kernel_info readiness probe. While the WS is open but
   * the kernel hasn't replied to kernel_info yet, we re-send periodically to
   * defeat the ZMQ slow-joiner race (a probe sent before the kernel's channels
   * are subscribed is silently dropped).
   */
  private kernelInfoTimer: ReturnType<typeof setInterval> | null = null;

  private readonly inFlight = new Map<string, InFlightRun>();
  /** Insertion-ordered map of all known runs (LRU eviction from the front). */
  private readonly runs = new Map<string, Run>();
  private readonly settledListeners = new Set<(run: Run) => void>();

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

  /**
   * Submit `code` for execution. Returns a `RunOutcome` describing whether
   * the run completed inline or was handed off.
   *
   * Overloads:
   *   - `run(code, timeoutMs)` — numeric form: hard deadline only.
   *   - `run(code, opts)` — options form with optional `handoffAfterMs`.
   */
  run(code: string, opts: RunOptions): Promise<RunOutcome>;
  // Legacy numeric form retained for older callers.
  run(code: string, timeoutMs: number): Promise<RunOutcome>;
  run(
    code: string,
    optsOrTimeout: RunOptions | number
  ): Promise<RunOutcome> {
    const opts: RunOptions =
      typeof optsOrTimeout === "number"
        ? { timeoutMs: optsOrTimeout }
        : optsOrTimeout;
    // Kick off WS open synchronously so the pool sees a connecting client
    // even before the caller awaits — tests and idle eviction both rely on
    // `factoryCalls`/state being observable on the same tick.
    const opening = this.ensureOpen();
    return opening.then(() => this.sendRequest(code, opts));
  }

  getRun(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  /**
   * True if any run is queued, running, or handed_off (i.e. the kernel may
   * still produce output for it). Handed-off runs stay in `inFlight` until the
   * kernel finally responds, so this also guards against idle-evicting a client
   * whose slow run hasn't landed yet.
   */
  hasActiveRuns(): boolean {
    return this.inFlight.size > 0;
  }

  /** Most-recent-first list of recent runs. */
  recentRuns(): Run[] {
    return [...this.runs.values()].reverse();
  }

  /**
   * Register a callback fired whenever a run reaches a terminal kernel state
   * (completed/failed). Note: handed-off runs fire when they later complete,
   * not at the handoff moment.
   */
  onRunSettled(cb: (run: Run) => void): () => void {
    this.settledListeners.add(cb);
    return () => {
      this.settledListeners.delete(cb);
    };
  }

  private sendRequest(code: string, opts: RunOptions): Promise<RunOutcome> {
    return new Promise<RunOutcome>((resolve, reject) => {
      const msgId = crypto.randomUUID();
      const run: Run = {
        id: msgId,
        kernelId: this._kernelId,
        state: "queued",
        startedAt: Date.now(),
        outputs: [],
        textParts: undefined as never, // placeholder, see textParts on inFlight
        text: "",
        images: [],
        html: [],
        status: "ok",
        executionCount: null,
        wasHandedOff: false,
      } as Run;
      // `textParts` is internal accumulation; store it on the run record so
      // we can recompute `text` lazily, but expose only `text`.
      (run as any)._textParts = [] as string[];

      const inflight: InFlightRun = {
        run,
        outcomeResolve: resolve,
        outcomeReject: reject,
        wasHandedOff: false,
        hardTimer: null,
        handoffTimer: null,
        handoffEnabled: opts.handoffAfterMs !== undefined,
      };
      this.inFlight.set(msgId, inflight);
      this.recordRun(run);

      const hardTimeoutMs = opts.timeoutMs;
      if (
        hardTimeoutMs !== undefined &&
        opts.handoffAfterMs === undefined
      ) {
        // Legacy: hard reject after timeoutMs.
        const secs = Math.max(1, Math.round(hardTimeoutMs / 1000));
        inflight.hardTimer = setTimeout(() => {
          if (this.inFlight.delete(msgId)) {
            run.state = "failed";
            run.completedAt = Date.now();
            run.errorMessage = `Execution timeout after ${secs} seconds`;
            this.fireSettled(run);
            inflight.outcomeReject?.(new Error(run.errorMessage));
            inflight.outcomeReject = null;
            inflight.outcomeResolve = null;
          }
        }, hardTimeoutMs);
      }

      if (opts.handoffAfterMs !== undefined) {
        inflight.handoffTimer = setTimeout(() => {
          // Hand off — but keep the in-flight entry alive.
          if (!inflight.outcomeResolve) return;
          inflight.wasHandedOff = true;
          run.wasHandedOff = true;
          run.state = "handed_off";
          const partial: PartialResult = {
            status: run.status,
            executionCount: run.executionCount,
            outputs: [...run.outputs],
            text: run.text,
            images: [...run.images],
            html: [...run.html],
          };
          inflight.outcomeResolve({ kind: "handoff", runId: msgId, partial });
          inflight.outcomeResolve = null;
          inflight.outcomeReject = null;
        }, opts.handoffAfterMs);

        // If timeoutMs is also provided alongside handoffAfterMs, treat it
        // as a hard upper bound that fails the still-running run.
        if (
          hardTimeoutMs !== undefined &&
          hardTimeoutMs > opts.handoffAfterMs
        ) {
          inflight.hardTimer = setTimeout(() => {
            if (this.inFlight.delete(msgId)) {
              run.state = "failed";
              run.completedAt = Date.now();
              run.errorMessage = `Execution hard timeout after ${hardTimeoutMs}ms`;
              this.fireSettled(run);
              if (inflight.outcomeReject) {
                inflight.outcomeReject(new Error(run.errorMessage));
                inflight.outcomeReject = null;
                inflight.outcomeResolve = null;
              }
            }
          }, hardTimeoutMs);
        }
      }

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
          store_history: opts.storeHistory ?? true,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: true,
        },
        buffers: [],
        channel: "shell",
      };

      try {
        this.ws!.send(JSON.stringify(msg));
        run.state = "running";
        this._lastActivityAt = Date.now();
      } catch (err) {
        if (this.inFlight.delete(msgId)) {
          this.clearTimers(inflight);
          run.state = "failed";
          run.completedAt = Date.now();
          run.errorMessage = err instanceof Error ? err.message : String(err);
          this.fireSettled(run);
          inflight.outcomeReject?.(
            err instanceof Error ? err : new Error(String(err))
          );
          inflight.outcomeReject = null;
          inflight.outcomeResolve = null;
        }
      }
    });
  }

  close(reason: string = "client closed"): void {
    this.failAllInFlight(reason);
    this.failAllOpenWaiters(new Error(reason));
    this.clearConnectTimers();
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
      this._lastActivityAt = Date.now();
      // The socket being open does NOT mean the kernel is ready to receive:
      // its ZMQ channels may not be subscribed yet, so an execute_request sent
      // now can be silently dropped (slow-joiner race). Stay in "connecting"
      // and probe with kernel_info_request until we get a reply — only then do
      // we resolve openWaiters and let queued runs send their requests.
      this.sendKernelInfoRequest();
      if (!this.kernelInfoTimer) {
        this.kernelInfoTimer = setInterval(() => {
          if (this.state === "connecting") this.sendKernelInfoRequest();
        }, KERNEL_INFO_RETRY_MS);
        this.kernelInfoTimer.unref?.();
      }
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
      // Readiness handshake: the first kernel_info_reply confirms the kernel's
      // channels are live. Resolve any waiters and start dispatching runs.
      if (msg?.msg_type === "kernel_info_reply") {
        this.markReady();
        return;
      }
      const parentMsgId = msg?.parent_header?.msg_id;
      if (!parentMsgId) return;
      const inflight = this.inFlight.get(parentMsgId);
      if (!inflight) return; // not ours (or already timed out / completed)
      this.ingest(inflight, msg);
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

  /** Clear the connection-phase timers (open deadline + kernel_info retry). */
  private clearConnectTimers(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    if (this.kernelInfoTimer) {
      clearInterval(this.kernelInfoTimer);
      this.kernelInfoTimer = null;
    }
  }

  /** Send a kernel_info_request on the shell channel to probe readiness. */
  private sendKernelInfoRequest(): void {
    if (!this.ws) return;
    const msg = {
      header: {
        msg_id: crypto.randomUUID(),
        msg_type: "kernel_info_request",
        username: "claude",
        session: crypto.randomUUID(),
        date: new Date().toISOString(),
        version: "5.3",
      },
      parent_header: {},
      metadata: {},
      content: {},
      buffers: [],
      channel: "shell",
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Socket went down mid-probe; the close/error handlers will recover.
    }
  }

  /**
   * Transition from "connecting" to "open" once the kernel has proven it can
   * receive on its channels (kernel_info_reply). Idempotent: extra replies are
   * ignored.
   */
  private markReady(): void {
    if (this.state !== "connecting") return;
    this.clearConnectTimers();
    this.state = "open";
    this._lastActivityAt = Date.now();
    const waiters = this.openWaiters;
    this.openWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private ingest(inflight: InFlightRun, msg: any): void {
    const run = inflight.run;
    const textParts: string[] = (run as any)._textParts;
    switch (msg.msg_type) {
      case "stream":
        run.outputs.push({
          output_type: "stream",
          name: msg.content.name,
          text: msg.content.text,
        });
        textParts.push(stripAnsi(msg.content.text || ""));
        run.text = textParts.join("");
        break;

      case "execute_result":
        run.outputs.push({
          output_type: "execute_result",
          execution_count: msg.content.execution_count,
          data: msg.content.data,
          metadata: msg.content.metadata || {},
        });
        textParts.push(stripAnsi(msg.content.data?.["text/plain"] || ""));
        run.text = textParts.join("");
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
          run.html.push(msg.content.data["text/html"]);
        }
        break;

      case "display_data":
        run.outputs.push({
          output_type: "display_data",
          data: msg.content.data,
          metadata: msg.content.metadata || {},
        });
        textParts.push(stripAnsi(msg.content.data?.["text/plain"] || ""));
        run.text = textParts.join("");
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
          run.html.push(msg.content.data["text/html"]);
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
        textParts.push(
          stripAnsi(`${msg.content.ename}: ${msg.content.evalue}`)
        );
        run.text = textParts.join("");
        break;

      case "execute_reply": {
        run.executionCount = msg.content.execution_count ?? run.executionCount;
        this.clearTimers(inflight);
        this.inFlight.delete(run.id);
        run.state = "completed";
        run.completedAt = Date.now();

        const result: ExecutionResult = {
          status: run.status,
          executionCount: run.executionCount,
          outputs: run.outputs,
          text: run.text,
          images: run.images,
          html: run.html,
        };

        // If we already handed off, only fire settled listeners — caller
        // already got their handoff outcome.
        if (inflight.outcomeResolve) {
          inflight.outcomeResolve({ kind: "result", runId: run.id, result });
          inflight.outcomeResolve = null;
          inflight.outcomeReject = null;
        }
        this.fireSettled(run);
        this.sweepRetention();
        break;
      }
    }
  }

  private handleSocketDown(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.clearConnectTimers();
    this.failAllInFlight(reason);
    this.failAllOpenWaiters(new Error(reason));
    this.ws = null;
    this.notifyClose(reason);
  }

  private failAllInFlight(reason: string): void {
    if (this.inFlight.size === 0) return;
    const entries = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const inflight of entries) {
      this.clearTimers(inflight);
      const run = inflight.run;
      run.state = "failed";
      run.completedAt = Date.now();
      run.errorMessage = `kernel ${this._kernelId}: ${reason}`;
      const err = new Error(run.errorMessage);
      if (inflight.outcomeReject) {
        inflight.outcomeReject(err);
        inflight.outcomeReject = null;
        inflight.outcomeResolve = null;
      }
      this.fireSettled(run);
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

  private clearTimers(inflight: InFlightRun): void {
    if (inflight.hardTimer) {
      clearTimeout(inflight.hardTimer);
      inflight.hardTimer = null;
    }
    if (inflight.handoffTimer) {
      clearTimeout(inflight.handoffTimer);
      inflight.handoffTimer = null;
    }
  }

  private fireSettled(run: Run): void {
    for (const cb of this.settledListeners) {
      try {
        cb(run);
      } catch {
        // Listener errors must not poison the client.
      }
    }
  }

  private recordRun(run: Run): void {
    this.runs.set(run.id, run);
    this.sweepRetention();
  }

  /**
   * Enforce retention policy:
   *  - In-flight runs (queued/running/handed_off) are never evicted.
   *  - Completed/failed runs older than COMPLETED_RUN_TTL_MS are evicted.
   *  - LRU cap of MAX_RETAINED_RUNS (only counts terminal-for-history runs).
   */
  private sweepRetention(): void {
    const now = Date.now();
    // First, TTL eviction.
    for (const [id, run] of this.runs) {
      if (this.isTerminalForHistory(run)) {
        if (
          run.completedAt !== undefined &&
          now - run.completedAt > COMPLETED_RUN_TTL_MS
        ) {
          this.runs.delete(id);
        }
      }
    }
    // Then, LRU cap: drop oldest terminal-for-history entries.
    while (this.runs.size > MAX_RETAINED_RUNS) {
      let evicted = false;
      for (const [id, run] of this.runs) {
        if (this.isTerminalForHistory(run)) {
          this.runs.delete(id);
          evicted = true;
          break;
        }
      }
      if (!evicted) break; // only in-flight runs left; can't evict
    }
  }

  private isTerminalForHistory(run: Run): boolean {
    return run.state === "completed" || run.state === "failed";
  }
}
