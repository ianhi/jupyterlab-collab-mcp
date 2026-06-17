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

export async function connectToNotebook(
  path: string,
  kernelId?: string
): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
  const config = getConfig();

  // Check cache
  const cached = connectedNotebooks.get(path);
  if (cached) {
    return cached;
  }

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

  // Cache connection
  connectedNotebooks.set(path, { doc, provider, kernelId });

  return { doc, provider };
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
const IDLE_EVICTION_MS = 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

let idleSweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureIdleSweep(): void {
  if (idleSweepTimer) return;
  idleSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [kernelId, client] of kernelClients) {
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
 * Close and remove the pooled client for `kernelId`, if any. Intended to be
 * wired into restart_kernel and disconnect flows in Phase 2 — currently
 * unwired so behaviour is identical to the old per-call implementation.
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
 * per kernel and reused. Same external contract as before: rejects on
 * timeout, returns ExecutionResult on success or kernel-side error.
 */
export async function executeCode(
  kernelId: string,
  code: string,
  timeoutMs: number = 30000
): Promise<ExecutionResult> {
  const outcome = await getKernelClient(kernelId).run(code, { timeoutMs });
  if (outcome.kind === "result") return outcome.result;
  // No handoffAfterMs was passed, so this branch is unreachable in practice.
  throw new Error(
    `Unexpected handoff outcome for legacy executeCode (run_id=${outcome.runId})`
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
  return getKernelClient(kernelId).run(code, opts);
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
