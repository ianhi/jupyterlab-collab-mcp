/**
 * Connection and state management for JupyterLab.
 *
 * Handles configuration, LSP integration, notebook connection via y-websocket,
 * and kernel execution.
 */

import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import crypto from "crypto";
import type { NotebookOutput, ExecutionResult } from "./helpers.js";

// ============================================================================
// State and config
// ============================================================================

// Dynamic configuration - set via connect_jupyter tool
export type JupyterConfig = {
  host: string;
  port: number;
  token: string;
  baseUrl: string;
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

export async function checkLspAvailability(): Promise<LspStatus> {
  const config = getConfig();
  try {
    const url = new URL("/lsp/status", config.baseUrl);
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

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`LSP request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on("open", () => {
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
          clearTimeout(timeout);
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
      clearTimeout(timeout);
      reject(err);
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

// ============================================================================
// Jupyter API helpers
// ============================================================================

export async function apiFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const config = getConfig();
  const url = new URL(endpoint, config.baseUrl);
  url.searchParams.set("token", config.token);

  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url.toString(), { ...options, headers });
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

export async function requestCollabSession(path: string): Promise<CollabSession> {
  const response = await apiFetch(
    `/api/collaboration/session/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      body: JSON.stringify({ format: "json", type: "notebook" }),
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
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
  });

  // Cache connection
  connectedNotebooks.set(path, { doc, provider, kernelId });

  return { doc, provider };
}

// ============================================================================
// Kernel execution
// ============================================================================

export async function executeCode(
  kernelId: string,
  code: string,
  timeoutMs: number = 30000
): Promise<ExecutionResult> {
  const config = getConfig();
  return new Promise((resolve, reject) => {
    const wsUrlWithToken = `${config.wsUrl}/api/kernels/${kernelId}/channels?token=${config.token}`;
    const ws = new WebSocket(wsUrlWithToken);

    const msgId = crypto.randomUUID();
    const outputs: NotebookOutput[] = [];
    const textParts: string[] = [];
    const images: { data: string; mimeType: string }[] = [];
    const htmlParts: string[] = [];
    let status: "ok" | "error" = "ok";
    let executionCount: number | null = null;

    const timeoutSecs = Math.round(timeoutMs / 1000);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Execution timeout after ${timeoutSecs} seconds`));
    }, timeoutMs);

    ws.on("open", () => {
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
      ws.send(JSON.stringify(msg));
    });

    ws.on("message", (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.parent_header?.msg_id !== msgId) return;

      switch (msg.msg_type) {
        case "stream":
          outputs.push({
            output_type: "stream",
            name: msg.content.name,
            text: msg.content.text,
          });
          textParts.push(msg.content.text);
          break;

        case "execute_result":
          outputs.push({
            output_type: "execute_result",
            execution_count: msg.content.execution_count,
            data: msg.content.data,
            metadata: msg.content.metadata || {},
          });
          // Extract text
          textParts.push(msg.content.data?.["text/plain"] || "");
          // Extract images
          if (msg.content.data?.["image/png"]) {
            images.push({ data: msg.content.data["image/png"], mimeType: "image/png" });
          }
          if (msg.content.data?.["image/jpeg"]) {
            images.push({ data: msg.content.data["image/jpeg"], mimeType: "image/jpeg" });
          }
          // Extract HTML (for rich reprs like pandas, xarray)
          if (msg.content.data?.["text/html"]) {
            htmlParts.push(msg.content.data["text/html"]);
          }
          break;

        case "display_data":
          outputs.push({
            output_type: "display_data",
            data: msg.content.data,
            metadata: msg.content.metadata || {},
          });
          textParts.push(msg.content.data?.["text/plain"] || "");
          // Extract images from display_data (matplotlib, etc.)
          if (msg.content.data?.["image/png"]) {
            images.push({ data: msg.content.data["image/png"], mimeType: "image/png" });
          }
          if (msg.content.data?.["image/jpeg"]) {
            images.push({ data: msg.content.data["image/jpeg"], mimeType: "image/jpeg" });
          }
          if (msg.content.data?.["text/html"]) {
            htmlParts.push(msg.content.data["text/html"]);
          }
          break;

        case "error":
          status = "error";
          outputs.push({
            output_type: "error",
            ename: msg.content.ename,
            evalue: msg.content.evalue,
            traceback: msg.content.traceback,
          });
          textParts.push(`${msg.content.ename}: ${msg.content.evalue}`);
          break;

        case "execute_reply":
          executionCount = msg.content.execution_count;
          clearTimeout(timeout);
          ws.close();
          resolve({
            status,
            executionCount,
            outputs,
            text: textParts.join(""),
            images,
            html: htmlParts,
          });
          break;
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
