/**
 * Connection and state management for JupyterLab.
 *
 * Handles configuration, LSP integration, notebook connection via y-websocket,
 * and kernel execution.
 */

import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import crypto from "node:crypto";
import { type ExecutionResult } from "./helpers.js";
import { KernelClient } from "./kernel-client.js";
import { notifyHandoffComplete } from "./notifications.js";
import { backfillRunOutputs } from "./handoff-targets.js";
import { persistRun } from "./run-store.js";
import { ensureCaptureInstalled } from "./kernel-capture.js";
import { trackHumanActivity } from "./human-activity.js";

// ============================================================================
// Instance identity — unique per MCP server process
// ============================================================================

/** Unique identifier for this MCP server instance. Stable for the process lifetime. */
export const instanceId = crypto.randomUUID();

// ============================================================================
// State and config
// ============================================================================

// Dynamic configuration - set via connect_jupyter tool
export type JupyterConfig = {
  host: string;
  port: number;
  token: string;
  /**
   * Base HTTP URL including any proxy path prefix (no trailing slash).
   * e.g. "http://localhost:8888" or "https://cluster.coiled.io/proxy/abc".
   */
  baseUrl: string;
  /**
   * Base WebSocket URL including any proxy path prefix (no trailing slash).
   * e.g. "ws://localhost:8888" or "wss://cluster.coiled.io/proxy/abc".
   */
  wsUrl: string;
};

export let jupyterConfig: JupyterConfig | null = null;

/**
 * Set or clear the Jupyter configuration.
 * Must be called from the connect_jupyter tool handler since ES module
 * `export let` bindings can only be reassigned from within the declaring module.
 */
export function setJupyterConfig(config: JupyterConfig | null): void {
  jupyterConfig = config;
  // Force a fresh RTC probe against the new connection (or clear it on
  // disconnect) so a stale value never leaks across servers.
  rtcAvailable = null;
}

export function getConfig() {
  if (!jupyterConfig) {
    throw new Error(
      "Not connected to JupyterLab. Use connect_jupyter tool first with your JupyterLab URL."
    );
  }
  return jupyterConfig;
}

export function isJupyterConnected(): boolean {
  return jupyterConfig !== null;
}

// ============================================================================
// LSP Integration (optional - gracefully degrades if not available)
// ============================================================================

export interface LspStatus {
  available: boolean;
  servers: Map<string, { status: string; spec: any }>;
}

export let lspStatus: LspStatus = { available: false, servers: new Map() };

// ============================================================================
// Real-time-collaboration (jupyter-collaboration) availability
// ============================================================================

// Whether the connected server has the `jupyter-collaboration` extension.
// null = not probed yet. Cell-level tools require this; kernel tools do not.
export let rtcAvailable: boolean | null = null;

export function setRtcAvailable(value: boolean | null): void {
  rtcAvailable = value;
}

/**
 * Probe whether the `jupyter-collaboration` server extension is installed by
 * hitting the (PUT-only) collaboration session route with a GET:
 *   - 405 (Method Not Allowed) → route exists, extension installed.
 *   - 404 (Not Found) → route unregistered, extension absent.
 *   - anything else (auth redirect/login shell, proxy 200, 5xx) or a network
 *     error → inconclusive; leave the result unknown (null) so we never record
 *     a false verdict and callers fall back to the per-request 404
 *     disambiguation in `requestCollabSession`.
 */
export async function checkRtcAvailability(): Promise<boolean | null> {
  try {
    const res = await apiFetch("/api/collaboration/session/_probe.ipynb");
    if (res.status === 405) rtcAvailable = true;
    else if (res.status === 404) rtcAvailable = false;
    else rtcAvailable = null;
  } catch {
    rtcAvailable = null;
  }
  return rtcAvailable;
}

export async function checkLspAvailability(): Promise<LspStatus> {
  const config = getConfig();
  try {
    const url = new URL(`${config.baseUrl}/lsp/status`);
    url.searchParams.set("token", config.token);
    const response = await fetch(url.toString());
    if (response.ok) {
      const data = await response.json();
      const servers = new Map<string, { status: string; spec: any }>();
      if (data.sessions) {
        for (const [name, session] of Object.entries(data.sessions as Record<string, any>)) {
          servers.set(name, { status: session.status, spec: session.spec });
        }
      }
      lspStatus = { available: true, servers };
      return lspStatus;
    }
  } catch {
    // LSP not available - that's fine
  }
  lspStatus = { available: false, servers: new Map() };
  return lspStatus;
}

// Send LSP request via WebSocket and wait for response
export async function lspRequest(
  languageServer: string,
  method: string,
  params: any,
  timeoutMs: number = 5000
): Promise<any> {
  const config = getConfig();

  return new Promise((resolve, reject) => {
    const wsUrl = `${config.wsUrl}/lsp/ws/${languageServer}?token=${config.token}`;
    const ws = new WebSocket(wsUrl);
    const msgId = Date.now();
    let timeoutId: ReturnType<typeof setTimeout>;

    ws.on("open", () => {
      timeoutId = setTimeout(() => {
        ws.close();
        reject(new Error(`LSP request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const request = {
        jsonrpc: "2.0",
        id: msgId,
        method,
        params,
      };
      ws.send(JSON.stringify(request));
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === msgId) {
          clearTimeout(timeoutId);
          ws.close();
          if (msg.error) {
            reject(new Error(msg.error.message || "LSP error"));
          } else {
            resolve(msg.result);
          }
        }
        // Ignore notifications (no id) - they're not our response
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    ws.on("close", () => {
      clearTimeout(timeoutId);
      reject(new Error("WebSocket closed unexpectedly before LSP response"));
    });
  });
}

// Get the appropriate language server for a file
export function getLanguageServerForFile(path: string): string | null {
  if (path.endsWith(".ipynb") || path.endsWith(".py")) {
    // Check for available Python language servers in order of preference
    for (const server of ["pylsp", "pyright", "python-lsp-server"]) {
      if (lspStatus.servers.has(server)) {
        return server;
      }
    }
  }
  return null;
}

// ============================================================================
// Connection cache
// ============================================================================

// Cache of connected notebooks
export const connectedNotebooks = new Map<
  string,
  { doc: Y.Doc; provider: WebsocketProvider; kernelId?: string }
>();

/**
 * Get the Y.Doc for a connected notebook path, if available.
 * Useful for callers that need the doc without going through getNotebookCells.
 */
export function getDocForPath(path: string): Y.Doc | undefined {
  return connectedNotebooks.get(path)?.doc;
}

// ============================================================================
// Jupyter API helpers
// ============================================================================

// XSRF state: Jupyter Server protects POST/PUT/DELETE/PATCH with an _xsrf cookie
// that must be echoed back as an X-XSRFToken header. We do one GET on first use
// to receive the cookie, then attach it to every subsequent state-changing call.
let xsrfCookie: string | null = null;
let xsrfToken: string | null = null;

function resetXsrf() {
  xsrfCookie = null;
  xsrfToken = null;
}

async function ensureXsrf(): Promise<void> {
  if (xsrfToken && xsrfCookie) return;
  const config = getConfig();
  // The lab root sets the _xsrf cookie; /api/me does not.
  const url = new URL(`${config.baseUrl}/`);
  url.searchParams.set("token", config.token);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `token ${config.token}` },
  });
  const setCookie =
    typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const sc of setCookie) {
    const m = sc.match(/_xsrf=([^;]+)/);
    if (m) {
      xsrfToken = m[1];
      xsrfCookie = `_xsrf=${m[1]}`;
      return;
    }
  }
}

export async function apiFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const config = getConfig();
  // Concatenate so any proxy prefix in baseUrl is preserved
  // (`new URL(endpoint, base)` replaces base's pathname).
  const normalized = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = new URL(`${config.baseUrl}${normalized}`);
  url.searchParams.set("token", config.token);

  const method = (options.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";

  if (isStateChanging) {
    await ensureXsrf();
  }

  const headers = new Headers(options.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `token ${config.token}`);
  }
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (isStateChanging && xsrfCookie && xsrfToken) {
    if (!headers.has("Cookie")) headers.set("Cookie", xsrfCookie);
    if (!headers.has("X-XSRFToken")) headers.set("X-XSRFToken", xsrfToken);
  }

  const response = await fetch(url.toString(), { ...options, headers });
  // If XSRF was rejected (e.g. cookie expired), drop our cached pair so the
  // next attempt re-fetches it. Caller still sees the 403.
  if (response.status === 403 && isStateChanging) {
    resetXsrf();
  }
  return response;
}

export interface NotebookSession {
  path: string;
  kernelId?: string;
}

export async function listNotebookSessions(): Promise<NotebookSession[]> {
  const response = await apiFetch("/api/sessions");
  if (!response.ok) {
    throw new Error(`Failed to list sessions: ${response.statusText}`);
  }

  const sessions: any[] = await response.json();
  // Deduplicate by path (same notebook can have multiple sessions)
  const seen = new Set<string>();
  return sessions
    .filter((s) => s.type === "notebook")
    .map((s) => ({ path: s.path, kernelId: s.kernel?.id }))
    .filter((s) => {
      if (seen.has(s.path)) return false;
      seen.add(s.path);
      return true;
    });
}

interface CollabSession {
  format: string;
  type: string;
  fileId: string;
  sessionId: string;
}

/**
 * Check whether a notebook file exists via the Jupyter contents API,
 * without fetching its content. Used to disambiguate a 404 from the
 * real-time-collaboration endpoint: a missing file vs. the
 * `jupyter-collaboration` server extension not being installed (which
 * leaves `/api/collaboration/*` unrouted and returns 404 for any path).
 */
export async function notebookFileExists(path: string): Promise<boolean> {
  try {
    const res = await apiFetch(
      `/api/contents/${encodeURIComponent(path)}?content=0`
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Thrown when cell-level (RTC) tools are used against a server that lacks
 * the `jupyter-collaboration` extension. Carries no special behaviour — it
 * exists so the actionable message lives in one place. */
export function rtcUnavailableError(path: string): Error {
  return new Error(
    `Real-time collaboration is unavailable on this JupyterLab server, so cell-level ` +
      `tools cannot open '${path}'. The notebook exists and kernel tools (e.g. execute_code) ` +
      `work, but cell-indexed tools (get_notebook_content, execute_cell, insert_cell, ` +
      `batch_insert_cells, …) require the 'jupyter-collaboration' server extension.\n` +
      `Fix: 'pip install jupyter-collaboration' (or 'conda install -c conda-forge ` +
      `jupyter-collaboration'), then restart JupyterLab and reconnect.`
  );
}

export async function requestCollabSession(path: string): Promise<CollabSession> {
  // If we already learned at connect time that RTC is unavailable, fail fast
  // with the actionable error rather than issuing a request we know will 404.
  if (rtcAvailable === false) {
    throw rtcUnavailableError(path);
  }

  const response = await apiFetch(
    `/api/collaboration/session/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      body: JSON.stringify({ format: "json", type: "notebook" }),
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      // A 404 here is ambiguous only when we never got a definitive RTC verdict
      // at connect time. The collaboration route is registered iff
      // `jupyter-collaboration` is installed; without it the server 404s for
      // *every* path. If the connect-time probe was inconclusive
      // (rtcAvailable === null), disambiguate with a contents-API existence
      // check so we can give an accurate, actionable error instead of the
      // misleading "Notebook not found". If RTC was confirmed present
      // (rtcAvailable === true), a 404 can only mean the file is genuinely
      // missing, so skip the extra round-trip.
      if (rtcAvailable === null && (await notebookFileExists(path))) {
        throw rtcUnavailableError(path);
      }
      throw new Error(`Notebook '${path}' not found. Check the path and try again.`);
    }
    throw new Error(
      `Failed to request session for '${path}': ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

// ============================================================================
// Notebook connection and operations
// ============================================================================

/**
 * In-flight connects keyed by path. Without this, two callers requesting the
 * SAME uncached notebook both miss the cache (the check is separated from the
 * cache write by several awaits: session request, sync wait, awareness wait),
 * both build a WebsocketProvider joining the same room, and the second's
 * `connectedNotebooks.set` orphans the first — leaking a socket, a duplicate
 * "Claude Code" presence, and its awareness/doc listeners. Coalescing on this
 * map makes concurrent callers await one shared connect.
 */
const connectingNotebooks = new Map<
  string,
  Promise<{ doc: Y.Doc; provider: WebsocketProvider }>
>();

export function connectToNotebook(
  path: string,
  kernelId?: string
): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
  // Check cache
  const cached = connectedNotebooks.get(path);
  if (cached) {
    return Promise.resolve(cached);
  }

  // Coalesce with any connect already in flight for this same path.
  const inFlight = connectingNotebooks.get(path);
  if (inFlight) return inFlight;

  const promise = establishConnection(path, kernelId).finally(() => {
    connectingNotebooks.delete(path);
  });
  connectingNotebooks.set(path, promise);
  return promise;
}

async function establishConnection(
  path: string,
  kernelId?: string
): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
  const config = getConfig();

  // A sync-timeout / connection-error usually means the collaboration room hit
  // a transient server-side startup failure (see ISSUE-pycrdt-yroom-start-stop-race:
  // a YRoom that is started and torn down concurrently crashes and the client
  // just times out). The room is typically recreated cleanly, so a short
  // backoff-then-retry recovers instead of surfacing the timeout to the agent.
  // Backoff-gated (not immediate) so we don't add reconnect churn that would
  // widen the very race we're recovering from.
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { doc, provider } = await openSyncedProvider(path, config);
      return finishConnection(path, kernelId, doc, provider);
    } catch (err) {
      lastErr = err;
      // Only retry transient room-startup failures; permanent errors
      // (notebook not found, RTC extension absent) should fail fast.
      const msg = err instanceof Error ? err.message : String(err);
      const transient = msg.includes("Sync timeout") || msg.includes("Connection error");
      if (!transient || attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

/** One connect attempt: request the session, open the provider, await sync. */
async function openSyncedProvider(
  path: string,
  config: JupyterConfig
): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
  // Request collaboration session
  const session = await requestCollabSession(path);

  // Create Y.Doc
  const doc = new Y.Doc();

  // Build room ID and connect
  const roomId = `${session.format}:${session.type}:${session.fileId}`;
  const roomUrl = `${config.wsUrl}/api/collaboration/room`;

  const provider = new WebsocketProvider(roomUrl, roomId, doc, {
    params: {
      sessionId: session.sessionId,
      token: config.token,
    },
  });

  // Wait for sync BEFORE setting awareness (ensures proper broadcast)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      provider.destroy();
      reject(new Error("Sync timeout after 10 seconds"));
    }, 10000);

    provider.on("sync", (synced: boolean) => {
      if (synced) {
        clearTimeout(timeout);
        resolve();
      }
    });

    provider.on("connection-error", (event: any) => {
      clearTimeout(timeout);
      provider.destroy();
      reject(new Error(`Connection error: ${event.message || event}`));
    });
  });

  return { doc, provider };
}

/** Wire awareness/activity, settle presence, and cache a synced connection. */
async function finishConnection(
  path: string,
  kernelId: string | undefined,
  doc: Y.Doc,
  provider: WebsocketProvider
): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
  // Set awareness AFTER sync with all required fields for JupyterLab collaborators panel
  // Note: JupyterLab only looks for the "user" field with User.IIdentity structure
  provider.awareness.setLocalStateField("user", {
    username: "claude-code",
    name: "Claude Code",
    display_name: "Claude Code",
    initials: "CC",
    color: "#ff6b6b",
    instance_id: instanceId,
  });

  // Start tracking human edit-activity so focus checks can distinguish an
  // actively-edited cell from one whose cursor is merely parked there.
  trackHumanActivity(doc, provider);

  // Awareness (remote cursors/presence) syncs on a separate channel from the
  // document and lands a beat AFTER the initial 'sync'. Reading getStates() the
  // instant sync resolves often shows zero remote peers even when a human is
  // actively in the notebook — which makes get_user_focus report "nobody here"
  // and, more dangerously, lets checkHumanFocus green-light an edit into a cell
  // the human occupies. Give remote awareness a brief window to arrive. This
  // early-exits the moment any peer appears, so it only ever costs wall-clock
  // when nobody else is actually connected — and only once per notebook (the
  // connection is cached below).
  await waitForRemoteAwareness(provider, 1500);

  // Cache connection
  connectedNotebooks.set(path, { doc, provider, kernelId });

  return { doc, provider };
}

/**
 * Resolve once the provider's awareness reports at least one remote peer, or
 * after `timeoutMs`, whichever comes first. Bounds the one-time cold-connect
 * delay while making presence/focus reads reliable.
 */
function waitForRemoteAwareness(
  provider: WebsocketProvider,
  timeoutMs: number
): Promise<void> {
  const awareness = provider.awareness;
  const hasRemotePeer = () => {
    for (const clientId of awareness.getStates().keys()) {
      if (clientId !== awareness.clientID) return true;
    }
    return false;
  };

  if (hasRemotePeer()) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      awareness.off("change", onChange);
      resolve();
    };
    const onChange = () => {
      if (hasRemotePeer()) done();
    };
    const timer = setTimeout(done, timeoutMs);
    awareness.on("change", onChange);
  });
}

// ============================================================================
// Forced save (verified persistence to disk)
// ============================================================================

// lib0 var-uint / var-string codec — the wire format jupyter-collaboration uses
// for its RAW control messages (see jupyter_server_ydoc/handlers.py on_message).
// Exported for protocol tests.
export function encodeVarUint(n: number): number[] {
  const bytes: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return bytes;
}
export function encodeVarString(s: string): number[] {
  const utf8 = Buffer.from(s, "utf8");
  return [...encodeVarUint(utf8.length), ...utf8];
}
export function decodeVarUint(buf: Buffer, offset: number): [number, number] {
  let n = 0;
  let shift = 0;
  let o = offset;
  for (;;) {
    const b = buf[o++];
    n += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [n, o];
}

/**
 * Force jupyter-collaboration to flush the notebook's live room to disk NOW and
 * report whether it actually persisted. Sends the same RAW "save" control
 * message the browser's Ctrl+S uses (MessageType.RAW=2, "save", <id>), which
 * triggers `_save_to_disc(save_now=True)` server-side, and reads the JSON reply
 * ({status: "success"|"skipped"|"failed"}).
 *
 * Uses a dedicated short-lived socket rather than the pooled y-websocket
 * provider: the provider is vanilla y-websocket, which would mis-handle the RAW
 * reply (message type 2 collides with y-protocol's auth message).
 */
export async function saveNotebook(
  path: string,
  timeoutMs = 10000
): Promise<{ status: string }> {
  const config = getConfig();
  const session = await requestCollabSession(path);
  const roomId = `${session.format}:${session.type}:${session.fileId}`;
  const RAW = 2;
  const saveId = 1;
  const url =
    `${config.wsUrl}/api/collaboration/room/${roomId}` +
    `?sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(config.token)}`;
  const message = Buffer.from([
    ...encodeVarUint(RAW),
    ...encodeVarString("save"),
    ...encodeVarUint(saveId),
  ]);

  return new Promise<{ status: string }>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;

    // Close the transient socket a beat AFTER we've resolved. Joining the room
    // adds us to its broadcast set; closing the instant we get the save reply
    // leaves the server writing the next broadcast frame into a dead socket
    // (logs a harmless tornado WebSocketClosedError). A short unref'd drain lets
    // those in-flight frames flush first. Never blocks the caller.
    const closeSoon = () => {
      setTimeout(() => {
        try {
          ws.close(1000);
        } catch {
          /* ignore */
        }
      }, 250).unref?.();
    };
    const closeNow = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    const settleResolve = (status: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status });
      closeSoon();
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeNow();
      reject(err);
    };
    const timer = setTimeout(
      () => settleReject(new Error(`save_notebook timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    ws.on("open", () => ws.send(message));
    ws.on("message", (data: WebSocket.Data) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      try {
        const [type, o1] = decodeVarUint(buf, 0);
        if (type !== RAW) return; // not a control message; ignore sync/awareness
        const [len, o2] = decodeVarUint(buf, o1);
        const obj = JSON.parse(buf.subarray(o2, o2 + len).toString("utf8"));
        if (obj?.type === "save" && obj?.responseTo === saveId) {
          settleResolve(String(obj.status ?? "unknown"));
        }
      } catch {
        // Ignore anything we can't parse as our save reply.
      }
    });
    ws.on("error", (err) => settleReject(err instanceof Error ? err : new Error(String(err))));
    ws.on("close", () =>
      settleReject(new Error("save_notebook socket closed before a save reply"))
    );
  });
}

// ============================================================================
// Kernel execution — long-lived KernelClient pool
// ============================================================================

/**
 * Pool of long-lived kernel clients keyed by kernelId. Each client owns a
 * single multiplexed WebSocket to /api/kernels/{id}/channels. Callers should
 * always go through `executeCode()` / `getKernelClient()` so eviction and
 * close-handling stay consistent.
 */
export const kernelClients = new Map<string, KernelClient>();

/**
 * Idle eviction window. A client whose `lastActivityAt` is older than this
 * is closed and removed on the next sweep so we don't leak sockets for
 * kernels the user has forgotten about.
 */
// Idle eviction closes a pooled kernel client after this long with no activity.
// Overridable via JUPYTER_MCP_IDLE_EVICTION_MS for long agent sessions.
const IDLE_EVICTION_MS = (() => {
  const raw = process.env.JUPYTER_MCP_IDLE_EVICTION_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5 * 60 * 1000;
})();
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

let idleSweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureIdleSweep(): void {
  if (idleSweepTimer) return;
  idleSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [kernelId, client] of kernelClients) {
      // Never evict a client that still has a queued/running/handed_off run —
      // closing it would mark a live computation as failed and discard its
      // (still-arriving) output. Only reap genuinely idle clients.
      if (client.hasActiveRuns()) continue;
      if (now - client.lastActivityAt > IDLE_EVICTION_MS) {
        client.close("idle eviction");
        // onClose handler removes from the map, but be defensive.
        kernelClients.delete(kernelId);
      }
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  // Don't keep the process alive solely for the sweep.
  idleSweepTimer.unref?.();
}

/**
 * Return the pooled KernelClient for `kernelId`, creating one if needed.
 * The client's WebSocket opens lazily on first `run()`.
 */
export function getKernelClient(kernelId: string): KernelClient {
  const existing = kernelClients.get(kernelId);
  if (existing) return existing;

  const config = getConfig();
  const client = new KernelClient(kernelId, config, {
    onClose: () => {
      // Remove only if the entry still points at *this* client — a fresh
      // client may have replaced it already.
      if (kernelClients.get(kernelId) === client) {
        kernelClients.delete(kernelId);
      }
    },
  });
  // Push channel notification when a previously handed-off run finishes.
  // Runs that complete inline never had `wasHandedOff === true`, so they
  // produce no notification.
  client.onRunSettled((run) => {
    if (!run.wasHandedOff) return;
    // Durably cache the final output so get_cell_run_output can still serve it
    // after the in-memory record is evicted / the client is reaped / the MCP
    // restarts. Fire-and-forget; failures never block the notification.
    persistRun(run);
    // Backfill the originating notebook cell's outputs (if we registered
    // a target for this run). Silent no-op when the notebook was
    // disconnected or the cell was deleted.
    try {
      backfillRunOutputs(run);
    } catch {
      // Don't let a y-doc mutation error block the notification.
    }
    notifyHandoffComplete({
      run_id: run.id,
      kernel_id: run.kernelId,
      status: run.status,
      execution_count: run.executionCount,
      first_line: run.text ? run.text.split("\n")[0].slice(0, 120) : undefined,
    });
  });
  kernelClients.set(kernelId, client);
  ensureIdleSweep();
  return client;
}

/**
 * Close and remove the pooled client for `kernelId`, if any. Has no caller —
 * a kernel's client is otherwise reaped only by idle eviction or socket close.
 * Available for restart_kernel/disconnect flows to force-drop a client.
 */
export function closeKernelClient(kernelId: string, reason: string = "explicit close"): void {
  const client = kernelClients.get(kernelId);
  if (!client) return;
  kernelClients.delete(kernelId);
  client.close(reason);
}

/**
 * Execute `code` on `kernelId` and resolve with the collected outputs.
 *
 * Thin wrapper over a pooled `KernelClient` — the WebSocket is opened once
 * per kernel and reused. Contract: rejects on timeout, returns ExecutionResult
 * on success or kernel-side error.
 */
export async function executeCode(
  kernelId: string,
  code: string,
  timeoutMs: number = 30000,
  opts: { storeHistory?: boolean } = {}
): Promise<ExecutionResult> {
  const outcome = await getKernelClient(kernelId).run(code, {
    timeoutMs,
    storeHistory: opts.storeHistory,
  });
  if (outcome.kind === "result") return outcome.result;
  // No handoffAfterMs was passed, so this branch is unreachable in practice.
  throw new Error(
    `Unexpected handoff outcome for non-handoff executeCode (run_id=${outcome.runId})`
  );
}

/**
 * Execute `code` with optional graceful handoff. Returns the full RunOutcome
 * so the handler can decide how to report partial-vs-complete to the agent.
 */
export async function executeCodeWithHandoff(
  kernelId: string,
  code: string,
  opts: { timeoutMs?: number; handoffAfterMs?: number }
): Promise<import("./kernel-client.js").RunOutcome> {
  const client = getKernelClient(kernelId);
  // Kernel-side capture makes a handoff-eligible run's output survive a mid-run
  // disconnect (see kernel-capture.ts). Fire — do NOT await: this queues the
  // one-time harness install just ahead of the user's run on the socket (the
  // kernel is single-threaded FIFO, so the harness installs first and the run
  // is captured), while adding zero latency to the user's run. Best-effort.
  if (opts.handoffAfterMs !== undefined) {
    void ensureCaptureInstalled(kernelId);
  }
  const outcome = await client.run(code, opts);
  // On handoff, durably snapshot the still-running run so its state survives an
  // MCP restart / dropped socket. It's re-persisted with final output when the
  // run later settles (see onRunSettled). Fire-and-forget.
  if (outcome.kind === "handoff") {
    const run = client.getRun(outcome.runId);
    if (run) persistRun(run);
  }
  return outcome;
}

/** Look up a run across every pooled KernelClient (or just one if kernelId is supplied). */
export function findRun(
  runId: string,
  kernelId?: string
): { client: KernelClient; run: import("./kernel-client.js").Run } | undefined {
  if (kernelId) {
    const client = kernelClients.get(kernelId);
    if (!client) return undefined;
    const run = client.getRun(runId);
    return run ? { client, run } : undefined;
  }
  for (const client of kernelClients.values()) {
    const run = client.getRun(runId);
    if (run) return { client, run };
  }
  return undefined;
}

/**
 * Enumerate recent runs across every pooled KernelClient (or just one if
 * `kernelId` is supplied), most-recent-first. Lets a caller discover run_ids
 * and their states instead of blindly holding an id that may be gone.
 */
export function listRuns(
  kernelId?: string
): { client: KernelClient; run: import("./kernel-client.js").Run }[] {
  const clients = kernelId
    ? ([kernelClients.get(kernelId)].filter(Boolean) as KernelClient[])
    : [...kernelClients.values()];
  const out: { client: KernelClient; run: import("./kernel-client.js").Run }[] = [];
  for (const client of clients) {
    for (const run of client.recentRuns()) out.push({ client, run });
  }
  return out;
}

// ============================================================================
// Execution output cache (for filter_output tool)
// ============================================================================

export interface CachedExecution {
  text: string;           // full unfiltered output text
  images: { data: string; mimeType: string }[];
  executionId: string;    // short ID for multi-agent safety
  cellIndex?: number;
  cellId?: string;
  timestamp: number;
}

// Keyed by notebook path (stores most recent execution per path)
const executionCache = new Map<string, CachedExecution>();
// Also keyed by executionId for direct lookup
const executionCacheById = new Map<string, CachedExecution>();

export function cacheExecution(path: string, result: { text: string; images: { data: string; mimeType: string }[]; cellIndex?: number; cellId?: string }): string {
  const executionId = crypto.randomUUID().slice(0, 8);
  const cached: CachedExecution = {
    text: result.text,
    images: result.images,
    executionId,
    cellIndex: result.cellIndex,
    cellId: result.cellId,
    timestamp: Date.now(),
  };
  executionCache.set(path, cached);
  executionCacheById.set(executionId, cached);

  // Evict old entries (keep last 50)
  if (executionCacheById.size > 50) {
    const oldest = [...executionCacheById.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, executionCacheById.size - 50);
    for (const [id] of oldest) executionCacheById.delete(id);
  }

  return executionId;
}

export function getCachedExecution(path: string, executionId?: string): CachedExecution | undefined {
  if (executionId) {
    return executionCacheById.get(executionId);
  }
  return executionCache.get(path);
}
