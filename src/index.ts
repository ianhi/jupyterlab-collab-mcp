#!/usr/bin/env node
/**
 * MCP Server for JupyterLab notebook collaboration.
 *
 * Connects to JupyterLab's real-time collaboration system via y-websocket,
 * allowing Claude Code to read, edit, and execute notebooks.
 *
 * Usage: The user provides a JupyterLab URL (with token) via the connect_jupyter tool.
 * No environment variables needed!
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import {
  extractSource,
  getCellType,
  getCellId,
  resolveCellIndices,
  parseJupyterUrl,
  generateUnifiedDiff,
  updateCellOutputs,
  createSafeRegex,
  extractMarkdownHeaders,
  getCodePreview,
  extractOutputsWithTraceback,
  truncateDiff,
  type NotebookOutput,
  type ExecutionResult,
} from "./helpers.js";

// Dynamic configuration - set via connect_jupyter tool
let jupyterConfig: {
  host: string;
  port: number;
  token: string;
  baseUrl: string;
  wsUrl: string;
} | null = null;

function getConfig() {
  if (!jupyterConfig) {
    throw new Error(
      "Not connected to JupyterLab. Use connect_jupyter tool first with your JupyterLab URL."
    );
  }
  return jupyterConfig;
}

// ============================================================================
// LSP Integration (optional - gracefully degrades if not available)
// ============================================================================

interface LspStatus {
  available: boolean;
  servers: Map<string, { status: string; spec: any }>;
}

let lspStatus: LspStatus = { available: false, servers: new Map() };

async function checkLspAvailability(): Promise<LspStatus> {
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
async function lspRequest(
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
function getLanguageServerForFile(path: string): string | null {
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

// Cache of connected notebooks
const connectedNotebooks = new Map<
  string,
  { doc: Y.Doc; provider: WebsocketProvider; kernelId?: string }
>();

// ============================================================================
// Jupyter API helpers
// ============================================================================

async function apiFetch(
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

interface NotebookSession {
  path: string;
  kernelId?: string;
}

async function listNotebookSessions(): Promise<NotebookSession[]> {
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

async function requestCollabSession(path: string): Promise<CollabSession> {
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

async function connectToNotebook(
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

async function executeCode(
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

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  {
    name: "jupyterlab-claude-code",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "connect_jupyter",
        description:
          "Connect to a JupyterLab server. MUST be called first - other tools will error with 'Not connected to JupyterLab' until this succeeds. Provide the full URL with token (e.g., http://localhost:8888/lab?token=abc123).",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "JupyterLab URL with token (e.g., http://localhost:8888/lab?token=abc123)",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "list_files",
        description:
          "List files and directories in the Jupyter file system. Use to discover available notebooks.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Directory path to list. Default: '' (root)",
            },
          },
        },
      },
      {
        name: "list_notebooks",
        description:
          "List notebooks with active kernel sessions. Only shows notebooks where a kernel is running (not just open in browser). Use open_notebook to start a kernel, or list_files to see all .ipynb files regardless of kernel state. Returns paths and kernel IDs.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "open_notebook",
        description:
          "Open a notebook and start a kernel session. Safe to call if already open (will reuse existing kernel). Required before executing cells in a notebook not yet listed by list_notebooks.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path (e.g., 'analysis.ipynb' or 'projects/notebook.ipynb')",
            },
            kernel_name: {
              type: "string",
              description: "Kernel to use (e.g., 'python3'). Default: notebook's default kernel",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "create_notebook",
        description:
          "Create a new notebook file. Optionally open it immediately with a kernel.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path for new notebook (e.g., 'new_analysis.ipynb')",
            },
            kernel_name: {
              type: "string",
              description: "Kernel to use (e.g., 'python3'). Default: 'python3'",
            },
            open: {
              type: "boolean",
              description: "Open the notebook after creation. Default: true",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_notebook_content",
        description:
          "Get cells from a notebook. By default returns only source code (no outputs) to save context. Use include_outputs=true only when you need to see execution results. Use cell_type='code' to skip markdown cells.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path (e.g., 'notebook1.ipynb')",
            },
            cell_type: {
              type: "string",
              enum: ["all", "code", "markdown"],
              description: "Filter by cell type: 'code' (default) for just code, 'markdown' for prose only, 'all' for everything",
            },
            include_outputs: {
              type: "boolean",
              description: "Include cell outputs. Default: false",
            },
            output_format: {
              type: "string",
              enum: ["text", "structured"],
              description: "Output format: 'text' (default) returns just text/plain as a string, 'structured' returns full output metadata",
            },
            start_index: {
              type: "number",
              description: "Start from this cell index. Default: 0",
            },
            end_index: {
              type: "number",
              description: "End at this cell index (inclusive). Default: last cell",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_notebook_outline",
        description:
          "Get a condensed outline of the notebook structure. Returns cell indices with markdown headers (by level) and first line preview of code cells. Useful for navigating and finding cell indices before using update_cell or add_cell_tags.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "search_notebook",
        description:
          "Search/grep through notebook cells for a pattern (regex supported). Returns matching cell indices and content. Use to find cell indices before update_cell or add_cell_tags.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            pattern: {
              type: "string",
              description: "Search pattern (regex supported)",
            },
            search_in: {
              type: "string",
              enum: ["source", "outputs", "all"],
              description: "Where to search: 'source' (code), 'outputs', or 'all' (default)",
            },
            case_sensitive: {
              type: "boolean",
              description: "Case-sensitive search. Default: false",
            },
            max_results: {
              type: "number",
              description: "Maximum number of matching cells to return. Default: unlimited",
            },
            max_source_length: {
              type: "number",
              description: "Truncate source/output to this length (adds ... if truncated). Default: 500",
            },
          },
          required: ["path", "pattern"],
        },
      },
      {
        name: "replace_in_notebook",
        description:
          "Search and replace text across notebook cells. Useful for refactoring (renaming variables, functions, etc.). Returns count of replacements made per cell.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            search: {
              type: "string",
              description: "Text or pattern to search for (regex supported)",
            },
            replace: {
              type: "string",
              description: "Replacement text",
            },
            cell_type: {
              type: "string",
              enum: ["code", "markdown", "all"],
              description: "Cell types to search: 'code' (default), 'markdown', or 'all'",
            },
            case_sensitive: {
              type: "boolean",
              description: "Case-sensitive search. Default: false",
            },
            regex: {
              type: "boolean",
              description: "Treat search as regex pattern. Default: false (literal string match)",
            },
            indices: {
              type: "array",
              items: { type: "number" },
              description: "Only replace in these cell indices. If omitted, replaces in all matching cells.",
            },
            dry_run: {
              type: "boolean",
              description: "If true, only show what would be replaced without making changes. Default: false",
            },
          },
          required: ["path", "search", "replace"],
        },
      },
      {
        name: "get_diagnostics",
        description:
          "Get code diagnostics (errors, warnings) for a notebook without executing it. Uses LSP if available for rich static analysis, otherwise falls back to Python syntax checking. Useful for validating code changes before execution.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            cell_index: {
              type: "number",
              description: "Check only this cell. If omitted, checks all code cells.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_hover_info",
        description:
          "Get documentation/type info for code at a specific position. Uses LSP if available, otherwise falls back to kernel introspection. Useful for understanding unfamiliar code.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            cell_index: {
              type: "number",
              description: "Cell index containing the code",
            },
            line: {
              type: "number",
              description: "Line number within the cell (0-indexed)",
            },
            character: {
              type: "number",
              description: "Character position within the line (0-indexed)",
            },
          },
          required: ["path", "cell_index", "line", "character"],
        },
      },
      {
        name: "get_user_focus",
        description:
          "Get the cell the user is currently focused on via JupyterLab's awareness protocol. Returns active cell index and cursor position. Returns null/empty if no user is actively editing the notebook.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "insert_cell",
        description:
          "Insert a new cell into the notebook. Changes sync in real-time to JupyterLab browser. Returns a diff showing what was inserted.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description:
                "Position to insert (0 = beginning, -1 or omit = end)",
            },
            source: {
              type: "string",
              description: "Cell source code",
            },
            cell_type: {
              type: "string",
              enum: ["code", "markdown"],
              description: "Cell type (default: code)",
            },
          },
          required: ["path", "source"],
        },
      },
      {
        name: "update_cell",
        description: "Update the source code of an existing cell. Only modifies source, not metadata/tags (use add_cell_tags/set_cell_metadata for those). Preserves cell outputs; use clear_outputs to remove them. Changes sync in real-time to JupyterLab.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index to update",
            },
            source: {
              type: "string",
              description: "New source code",
            },
          },
          required: ["path", "index", "source"],
        },
      },
      {
        name: "batch_update_cells",
        description:
          "Update multiple cells at once. More efficient than calling update_cell repeatedly. Each update specifies index and new source. All changes are applied atomically.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "number", description: "Cell index to update" },
                  source: { type: "string", description: "New source code" },
                },
                required: ["index", "source"],
              },
              description: "Array of {index, source} updates to apply",
            },
          },
          required: ["path", "updates"],
        },
      },
      {
        name: "delete_cell",
        description: "Delete a cell from the notebook. Changes sync in real-time to JupyterLab browser. Returns a diff showing what was deleted.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index to delete",
            },
          },
          required: ["path", "index"],
        },
      },
      {
        name: "delete_cells",
        description:
          "Delete multiple cells at once. More efficient than calling delete_cell repeatedly.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            start_index: {
              type: "number",
              description: "First cell index to delete (inclusive)",
            },
            end_index: {
              type: "number",
              description: "Last cell index to delete (inclusive)",
            },
            indices: {
              type: "array",
              items: { type: "number" },
              description:
                "Specific cell indices to delete (e.g., [2,5,8]). Takes precedence over start_index/end_index.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "change_cell_type",
        description:
          "Change a cell's type (code <-> markdown) in place, preserving content.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index to change",
            },
            new_type: {
              type: "string",
              enum: ["code", "markdown"],
              description: "New cell type",
            },
          },
          required: ["path", "index", "new_type"],
        },
      },
      {
        name: "copy_cells",
        description:
          "Copy one or more cells from one notebook to another (or within the same notebook). For single cell, use same value for start_index and end_index.",
        inputSchema: {
          type: "object",
          properties: {
            source_path: {
              type: "string",
              description: "Source notebook path",
            },
            dest_path: {
              type: "string",
              description: "Destination notebook path",
            },
            start_index: {
              type: "number",
              description: "First cell index to copy (inclusive)",
            },
            end_index: {
              type: "number",
              description: "Last cell index to copy (inclusive)",
            },
            dest_index: {
              type: "number",
              description: "Position in destination to insert cells. Default: end",
            },
          },
          required: ["source_path", "dest_path", "start_index", "end_index"],
        },
      },
      {
        name: "move_cells",
        description:
          "Move one or more cells within a notebook (reorder) or between notebooks (removes from source). For single cell, use same value for start_index and end_index.",
        inputSchema: {
          type: "object",
          properties: {
            source_path: {
              type: "string",
              description: "Source notebook path",
            },
            dest_path: {
              type: "string",
              description: "Destination notebook path (can be same as source for reordering)",
            },
            start_index: {
              type: "number",
              description: "First cell index to move (inclusive)",
            },
            end_index: {
              type: "number",
              description: "Last cell index to move (inclusive)",
            },
            dest_index: {
              type: "number",
              description: "Position in destination to insert cells",
            },
          },
          required: ["source_path", "dest_path", "start_index", "end_index", "dest_index"],
        },
      },
      {
        name: "execute_cell",
        description:
          "Execute a cell in the notebook's kernel. Outputs appear in JupyterLab and are returned here. Supports text output and images.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index to execute",
            },
            timeout: {
              type: "number",
              description: "Execution timeout in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
            },
          },
          required: ["path", "index"],
        },
      },
      {
        name: "execute_code",
        description:
          "Execute code in the notebook's kernel without modifying the notebook. Works with any kernel (Python, R, Julia, etc.). Set insertCell=true to also add the code as a new cell with visible outputs.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path (to identify which kernel to use)",
            },
            code: {
              type: "string",
              description: "Code to execute (language depends on notebook's kernel)",
            },
            insertCell: {
              type: "boolean",
              description:
                "If true, insert code as a new cell and show outputs in JupyterLab (default: false)",
            },
            timeout: {
              type: "number",
              description: "Execution timeout in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
            },
          },
          required: ["path", "code"],
        },
      },
      {
        name: "execute_range",
        description:
          "Execute multiple cells in sequence. Continues on error (doesn't stop). Returns status per cell. Useful for running a section or the entire notebook.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            start_index: {
              type: "number",
              description: "First cell index to execute. Default: 0",
            },
            end_index: {
              type: "number",
              description: "Last cell index to execute (inclusive). Default: last cell",
            },
            timeout: {
              type: "number",
              description: "Timeout per cell in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "insert_and_execute",
        description:
          "Insert a new code cell and immediately execute it. Combines insert_cell + execute_cell in one operation. Returns the execution output.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Position to insert (0 = beginning, -1 or omit = end)",
            },
            source: {
              type: "string",
              description: "Code to insert and execute",
            },
            timeout: {
              type: "number",
              description: "Execution timeout in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
            },
          },
          required: ["path", "source"],
        },
      },
      {
        name: "update_and_execute",
        description:
          "Update a cell's source code and immediately execute it. Combines update_cell + execute_cell in one operation. Returns the execution output.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index to update and execute",
            },
            source: {
              type: "string",
              description: "New source code for the cell",
            },
            timeout: {
              type: "number",
              description: "Execution timeout in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
            },
          },
          required: ["path", "index", "source"],
        },
      },
      {
        name: "clear_outputs",
        description:
          "Clear execution outputs from cells. Useful before committing notebooks.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index to clear. If omitted, clears all cells.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_cell_outputs",
        description:
          "Get execution outputs from specific cells without fetching source code. Useful for checking results without re-fetching everything. Returns text and image outputs.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
            },
            end_index: {
              type: "number",
              description: "Last cell index (inclusive). Omit for single cell.",
            },
            indices: {
              type: "array",
              items: { type: "number" },
              description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_cell_metadata",
        description:
          "Get metadata from one or more cells. Returns {index, metadata, tags} - tags extracted to top level for convenience. Use indices:[2,5,8] for non-contiguous cells.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
            },
            end_index: {
              type: "number",
              description: "Last cell index (inclusive). Omit for single cell.",
            },
            indices: {
              type: "array",
              items: { type: "number" },
              description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "set_cell_metadata",
        description:
          "Set metadata on one or more cells. Merges with existing metadata (use null values to delete keys). Supports ranges or specific non-contiguous indices.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
            },
            end_index: {
              type: "number",
              description: "Last cell index (inclusive). Omit for single cell.",
            },
            indices: {
              type: "array",
              items: { type: "number" },
              description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
            },
            metadata: {
              type: "object",
              description: "Metadata to set/merge. Use null values to delete keys.",
            },
          },
          required: ["path", "metadata"],
        },
      },
      {
        name: "add_cell_tags",
        description:
          "Add tags to one or more cells. Common tags: 'hide-input', 'hide-output', 'remove-input', 'remove-output', 'remove-cell', 'skip-execution', 'parameters' (papermill). Use indices:[2,5,8] for non-contiguous cells.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
            },
            end_index: {
              type: "number",
              description: "Last cell index (inclusive). Omit for single cell.",
            },
            indices: {
              type: "array",
              items: { type: "number" },
              description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags to add",
            },
          },
          required: ["path", "tags"],
        },
      },
      {
        name: "remove_cell_tags",
        description:
          "Remove tags from one or more cells. Supports ranges or specific non-contiguous indices.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            index: {
              type: "number",
              description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
            },
            end_index: {
              type: "number",
              description: "Last cell index (inclusive). Omit for single cell.",
            },
            indices: {
              type: "array",
              items: { type: "number" },
              description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags to remove",
            },
          },
          required: ["path", "tags"],
        },
      },
      {
        name: "find_cells_by_tag",
        description:
          "Find cells that have specific tag(s). Returns cell indices, tags, and optionally source preview. Useful for locating cells marked with 'hide-input', 'parameters', etc.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags to search for (cells matching ANY of these tags are returned)",
            },
            match_all: {
              type: "boolean",
              description: "If true, only return cells that have ALL specified tags. Default: false (match any)",
            },
            include_preview: {
              type: "boolean",
              description: "Include first line of source for context. Default: false",
            },
          },
          required: ["path", "tags"],
        },
      },
      {
        name: "get_notebook_metadata",
        description:
          "Get notebook-level metadata (kernelspec, language_info, custom fields).",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "set_notebook_metadata",
        description:
          "Set notebook-level metadata. Merges with existing metadata.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            metadata: {
              type: "object",
              description: "Metadata to set/merge",
            },
          },
          required: ["path", "metadata"],
        },
      },
      {
        name: "get_kernel_status",
        description:
          "Get the status of a notebook's kernel (idle, busy, starting, dead). Use to check if execution is complete or if kernel needs restart.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_kernel_variables",
        description:
          "List variables defined in the notebook's kernel. Returns variable names, types, and short representations. Useful for inspecting kernel state without writing code.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
            filter: {
              type: "string",
              description: "Filter variables by name pattern (case-insensitive substring match). Default: show all",
            },
            include_private: {
              type: "boolean",
              description: "Include variables starting with underscore. Default: false",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "interrupt_kernel",
        description:
          "Interrupt (stop) a running execution. Use when code is taking too long or stuck in an infinite loop. Does not restart the kernel or clear state.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "restart_kernel",
        description:
          "Restart the kernel, clearing all variables and state. Use when kernel is unresponsive, memory is full, or you need a clean slate. All variables will be lost.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "rename_notebook",
        description:
          "Rename a notebook file. Disconnects any active collaboration session first.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Current notebook path",
            },
            new_path: {
              type: "string",
              description: "New notebook path (must end in .ipynb)",
            },
          },
          required: ["path", "new_path"],
        },
      },
      {
        name: "diff_notebooks",
        description:
          "Compare two .ipynb notebooks cell by cell. Returns unified diff showing additions (+), deletions (-), and modifications per cell. Both must be open in JupyterLab. Use summary_only=true for counts only.",
        inputSchema: {
          type: "object",
          properties: {
            path1: {
              type: "string",
              description: "First notebook path",
            },
            path2: {
              type: "string",
              description: "Second notebook path",
            },
            include_outputs: {
              type: "boolean",
              description: "Include output differences (default: false)",
            },
            summary_only: {
              type: "boolean",
              description: "Only show counts, not full diffs (default: false)",
            },
            max_diffs: {
              type: "number",
              description: "Max number of cell diffs to show (default: all)",
            },
          },
          required: ["path1", "path2"],
        },
      },
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "connect_jupyter": {
        const { url } = args as { url: string };
        const parsed = parseJupyterUrl(url);

        jupyterConfig = {
          host: parsed.host,
          port: parsed.port,
          token: parsed.token,
          baseUrl: `http://${parsed.host}:${parsed.port}`,
          wsUrl: `ws://${parsed.host}:${parsed.port}`,
        };

        // Test connection by listing sessions
        const response = await apiFetch("/api/sessions");
        if (!response.ok) {
          jupyterConfig = null;
          throw new Error(`Failed to connect: ${response.statusText}`);
        }

        const sessions: any[] = await response.json();
        const notebooks = sessions.filter((s) => s.type === "notebook");

        // Check for LSP availability (optional enhancement)
        const lsp = await checkLspAvailability();
        const lspInfo = lsp.available
          ? `\n\nLSP available: ${[...lsp.servers.keys()].join(", ") || "checking..."}`
          : "\n\nLSP: not available (install jupyterlab-lsp for enhanced diagnostics)";

        return {
          content: [
            {
              type: "text",
              text: `Connected to JupyterLab at ${jupyterConfig.baseUrl}\n\nOpen notebooks:\n${
                notebooks.length > 0
                  ? notebooks.map((n) => `- ${n.path}`).join("\n")
                  : "(no notebooks open)"
              }${lspInfo}`,
            },
          ],
        };
      }

      case "list_notebooks": {
        const notebooks = await listNotebookSessions();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(notebooks, null, 2),
            },
          ],
        };
      }

      case "get_notebook_content": {
        const {
          path,
          cell_type = "code",
          include_outputs = false,
          output_format = "text",
          start_index = 0,
          end_index,
        } = args as {
          path: string;
          cell_type?: "all" | "code" | "markdown";
          include_outputs?: boolean;
          output_format?: "text" | "structured";
          start_index?: number;
          end_index?: number;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const endIdx = end_index ?? (cells.length - 1);
        const content = [];

        for (let i = start_index; i <= endIdx && i < cells.length; i++) {
          const cell = cells.get(i) as any;
          const type = getCellType(cell);

          // Filter by cell type
          if (cell_type !== "all" && type !== cell_type) {
            continue;
          }

          const cellData: any = {
            index: i,
            type,
            source: extractSource(cell),
          };

          // Include outputs only if requested (and for code cells only)
          if (include_outputs && type === "code") {
            const outputs = cell instanceof Y.Map ? cell.get("outputs") : cell?.outputs;
            if (outputs) {
              const outputsJson = outputs instanceof Y.Array ? outputs.toJSON() : outputs;

              if (output_format === "text") {
                // Text-only format: combine all text outputs into a single string
                const textParts: string[] = [];
                for (const out of outputsJson) {
                  if (out.output_type === "stream") {
                    textParts.push(out.text || "");
                  } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
                    const text = out.data?.["text/plain"];
                    if (text) textParts.push(text);
                  } else if (out.output_type === "error") {
                    textParts.push(`${out.ename}: ${out.evalue}`);
                  }
                }
                const combinedText = textParts.join("");
                if (combinedText) {
                  cellData.output = combinedText;
                }
              } else {
                // Structured format: full output metadata
                cellData.outputs = outputsJson.map((out: any) => {
                  if (out.data && (out.output_type === "display_data" || out.output_type === "execute_result")) {
                    return {
                      output_type: out.output_type,
                      text: out.data["text/plain"] || "[rich output]",
                      has_image: !!out.data["image/png"] || !!out.data["image/jpeg"],
                      has_html: !!out.data["text/html"],
                    };
                  }
                  return out;
                });
              }
            }
            cellData.execution_count = cell instanceof Y.Map ? cell.get("execution_count") : cell?.execution_count;
          }

          content.push(cellData);
        }

        // Add summary header
        const totalCells = cells.length;
        const returnedCells = content.length;
        const summary = `Notebook: ${path} (${totalCells} total cells, returning ${returnedCells}${cell_type !== "all" ? ` ${cell_type} cells` : ""}${include_outputs ? " with outputs" : ""})`;

        return {
          content: [
            {
              type: "text",
              text: `${summary}\n\n${JSON.stringify(content, null, 2)}`,
            },
          ],
        };
      }

      case "insert_cell": {
        const { path, index, source, cell_type = "code" } = args as {
          path: string;
          index?: number;
          source: string;
          cell_type?: string;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        // Create cell as Y.Map with Y.Text for source
        const newCell = new Y.Map();
        newCell.set("cell_type", cell_type);
        newCell.set("source", new Y.Text(source));
        newCell.set("metadata", new Y.Map());
        if (cell_type === "code") {
          newCell.set("outputs", new Y.Array());
          newCell.set("execution_count", null);
        }
        newCell.set("id", crypto.randomUUID());

        // Handle index: undefined/-1 = append, 0+ = insert at position
        let insertIndex: number;
        if (index === undefined || index === -1) {
          insertIndex = cells.length;
        } else if (index < -1) {
          throw new Error(`Invalid index ${index}. Use -1 to append at end, or 0-${cells.length} to insert at a specific position.`);
        } else if (index > cells.length) {
          throw new Error(`Invalid index ${index}. Notebook has ${cells.length} cells. Use 0-${cells.length} or -1 to append.`);
        } else {
          insertIndex = index;
        }
        cells.insert(insertIndex, [newCell]);

        // Show what was inserted
        const insertDiff = [
          `--- /dev/null`,
          `+++ ${path}:cell[${insertIndex}]`,
          `@@ -0,0 +1,${source.split("\n").length} @@`,
          ...source.split("\n").map((line) => `+${line}`),
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Inserted ${cell_type} cell at index ${insertIndex} in ${path}\n\n\`\`\`diff\n${insertDiff}\n\`\`\``,
            },
          ],
        };
      }

      case "update_cell": {
        const { path, index, source } = args as {
          path: string;
          index: number;
          source: string;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        if (index < 0 || index >= cells.length) {
          throw new Error(
            `Invalid cell index ${index}. Notebook has ${cells.length} cells.`
          );
        }

        const cell = cells.get(index) as Y.Map<any>;

        // Capture old source for diff
        const oldSource = extractSource(cell);

        if (cell instanceof Y.Map) {
          const sourceField = cell.get("source");
          if (sourceField instanceof Y.Text) {
            sourceField.delete(0, sourceField.length);
            sourceField.insert(0, source);
          } else {
            cell.set("source", new Y.Text(source));
          }
        }

        // Generate unified diff wrapped in markdown for better rendering
        const diff = generateUnifiedDiff(
          oldSource,
          source,
          `${path}:cell[${index}]`
        );

        return {
          content: [
            {
              type: "text",
              text: `Updated cell ${index} in ${path}\n\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``,
            },
          ],
        };
      }

      case "batch_update_cells": {
        const { path, updates } = args as {
          path: string;
          updates: { index: number; source: string }[];
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        // Validate all indices first
        for (const update of updates) {
          if (update.index < 0 || update.index >= cells.length) {
            throw new Error(
              `Invalid cell index ${update.index}. Notebook has ${cells.length} cells.`
            );
          }
        }

        const diffs: string[] = [];

        // Apply all updates in a transaction for atomicity
        doc.transact(() => {
          for (const update of updates) {
            const cell = cells.get(update.index) as Y.Map<any>;
            const oldSource = extractSource(cell);

            if (cell instanceof Y.Map) {
              const sourceField = cell.get("source");
              if (sourceField instanceof Y.Text) {
                sourceField.delete(0, sourceField.length);
                sourceField.insert(0, update.source);
              } else {
                cell.set("source", new Y.Text(update.source));
              }
            }

            const diff = generateUnifiedDiff(
              oldSource,
              update.source,
              `${path}:cell[${update.index}]`
            );
            if (diff !== "(no changes)") {
              diffs.push(`Cell ${update.index}:\n${truncateDiff(diff)}`);
            }
          }
        });

        return {
          content: [
            {
              type: "text",
              text: `Updated ${updates.length} cells in ${path}\n\n\`\`\`diff\n${diffs.join("\n\n")}\n\`\`\``,
            },
          ],
        };
      }

      case "delete_cell": {
        const { path, index } = args as { path: string; index: number };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        if (index < 0 || index >= cells.length) {
          throw new Error(
            `Invalid cell index ${index}. Notebook has ${cells.length} cells.`
          );
        }

        // Capture source before deleting
        const cell = cells.get(index) as Y.Map<any>;
        const oldSource = extractSource(cell);
        const cellType = getCellType(cell);

        cells.delete(index, 1);

        // Show what was deleted
        const deleteDiff = [
          `--- ${path}:cell[${index}]`,
          `+++ /dev/null`,
          `@@ -1,${oldSource.split("\n").length} +0,0 @@`,
          ...oldSource.split("\n").map((line) => `-${line}`),
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Deleted ${cellType} cell at index ${index} in ${path}\n\n\`\`\`diff\n${deleteDiff}\n\`\`\``,
            },
          ],
        };
      }

      case "get_user_focus": {
        const { path } = args as { path: string };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc, provider } = await connectToNotebook(path, session?.kernelId);
        const awareness = provider.awareness;
        const cells = doc.getArray("cells");

        // Get all awareness states
        const states = awareness.getStates();
        const myClientId = awareness.clientID;

        const collaborators: any[] = [];
        states.forEach((state: any, clientId: number) => {
          if (clientId === myClientId) return; // Skip ourselves

          const info: any = {
            clientId,
            user: state.user?.display_name || state.user?.name || "Unknown",
          };

          // Try to find which cell the cursor is in
          if (state.cursors && state.cursors.length > 0) {
            for (const cursor of state.cursors) {
              // The RelativePosition contains a reference to the Y.Text type
              // Try to resolve it to find the cell
              if (cursor.head && cursor.head.type) {
                // cursor.head.type is the ID of the Y.Text
                // We need to find which cell's source matches this
                for (let i = 0; i < cells.length; i++) {
                  const cell = cells.get(i) as Y.Map<any>;
                  if (cell instanceof Y.Map) {
                    const source = cell.get("source");
                    if (source instanceof Y.Text) {
                      try {
                        // Try to create absolute position - if it works, this is the right cell
                        const absPos = Y.createAbsolutePositionFromRelativePosition(
                          cursor.head,
                          doc
                        );
                        if (absPos && absPos.type === source) {
                          info.focusedCell = i;
                          info.cursorPosition = absPos.index;
                          break;
                        }
                      } catch {
                        // Not this cell
                      }
                    }
                  }
                }
              }
            }
          }

          // Check for current document
          if (state.current) {
            info.current = state.current;
          }

          collaborators.push(info);
        });

        if (collaborators.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No other collaborators found in ${path}. Make sure the notebook is open in JupyterLab.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Collaborators in ${path}:\n${JSON.stringify(collaborators, null, 2)}`,
            },
          ],
        };
      }

      case "execute_cell": {
        const { path, index, timeout } = args as { path: string; index: number; timeout?: number };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

        const { doc } = await connectToNotebook(path, session.kernelId);
        const cells = doc.getArray("cells");

        if (index < 0 || index >= cells.length) {
          throw new Error(
            `Invalid cell index ${index}. Notebook has ${cells.length} cells.`
          );
        }

        const cell = cells.get(index) as Y.Map<any>;
        const source = extractSource(cell);
        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const result = await executeCode(session.kernelId, source, timeoutMs);

        // Update cell outputs in the notebook
        if (cell instanceof Y.Map) {
          updateCellOutputs(cell, result);
        }

        // Build response with text and images
        const content: any[] = [
          {
            type: "text",
            text: result.text || "(no output)",
          },
        ];
        // Add images
        for (const img of result.images) {
          content.push({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          });
        }

        return { content };
      }

      case "execute_code": {
        const { path, code, insertCell, timeout } = args as {
          path: string;
          code: string;
          insertCell?: boolean;
          timeout?: number;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);

        if (insertCell) {
          // Insert as a new cell and execute with visible outputs
          const { doc } = await connectToNotebook(path, session.kernelId);
          const cells = doc.getArray("cells");

          // Create the cell
          const newCell = new Y.Map();
          newCell.set("cell_type", "code");
          newCell.set("source", new Y.Text(code));
          newCell.set("metadata", new Y.Map());
          newCell.set("outputs", new Y.Array());
          newCell.set("execution_count", null);
          newCell.set("id", crypto.randomUUID());
          cells.push([newCell]);

          // Execute and update outputs
          const result = await executeCode(session.kernelId, code, timeoutMs);
          updateCellOutputs(newCell, result);

          // Build response with text and images
          const content: any[] = [
            {
              type: "text",
              text: `Cell inserted at index ${cells.length - 1}\n\nOutput:\n${result.text || "(no output)"}`,
            },
          ];
          // Add images
          for (const img of result.images) {
            content.push({
              type: "image",
              data: img.data,
              mimeType: img.mimeType,
            });
          }

          return { content };
        } else {
          // Execute without inserting a cell
          const result = await executeCode(session.kernelId, code, timeoutMs);

          // Build response with text and images
          const content: any[] = [
            {
              type: "text",
              text: result.text || "(no output)",
            },
          ];
          // Add images
          for (const img of result.images) {
            content.push({
              type: "image",
              data: img.data,
              mimeType: img.mimeType,
            });
          }

          return { content };
        }
      }

      case "insert_and_execute": {
        const { path, index, source, timeout } = args as {
          path: string;
          index?: number;
          source: string;
          timeout?: number;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

        const { doc } = await connectToNotebook(path, session.kernelId);
        const cells = doc.getArray("cells");

        // Create cell as Y.Map with Y.Text for source
        const newCell = new Y.Map();
        newCell.set("cell_type", "code");
        newCell.set("source", new Y.Text(source));
        newCell.set("metadata", new Y.Map());
        newCell.set("outputs", new Y.Array());
        newCell.set("execution_count", null);
        newCell.set("id", crypto.randomUUID());

        const insertIndex = index === undefined || index === -1 ? cells.length : index;
        cells.insert(insertIndex, [newCell]);

        // Execute the cell
        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const result = await executeCode(session.kernelId, source, timeoutMs);

        // Update cell outputs in the notebook
        updateCellOutputs(newCell, result);

        // Build response
        const content: any[] = [
          {
            type: "text",
            text: `Inserted and executed cell at index ${insertIndex} in ${path}\n\nOutput:\n${result.text || "(no output)"}`,
          },
        ];

        // Add images
        for (const img of result.images) {
          content.push({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          });
        }

        return { content };
      }

      case "update_and_execute": {
        const { path, index, source, timeout } = args as {
          path: string;
          index: number;
          source: string;
          timeout?: number;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

        const { doc } = await connectToNotebook(path, session.kernelId);
        const cells = doc.getArray("cells");

        if (index < 0 || index >= cells.length) {
          throw new Error(
            `Invalid cell index ${index}. Notebook has ${cells.length} cells.`
          );
        }

        const cell = cells.get(index) as Y.Map<any>;

        // Update the cell source
        const oldSource = extractSource(cell);
        if (cell instanceof Y.Map) {
          const sourceField = cell.get("source");
          if (sourceField instanceof Y.Text) {
            sourceField.delete(0, sourceField.length);
            sourceField.insert(0, source);
          } else {
            cell.set("source", new Y.Text(source));
          }
        }

        // Execute the cell
        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const result = await executeCode(session.kernelId, source, timeoutMs);

        // Update cell outputs in the notebook
        if (cell instanceof Y.Map) {
          updateCellOutputs(cell, result);
        }

        // Generate diff
        const diff = generateUnifiedDiff(oldSource, source, `${path}:cell[${index}]`);

        // Build response
        const content: any[] = [
          {
            type: "text",
            text: `Updated and executed cell ${index} in ${path}\n\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\`\n\nOutput:\n${result.text || "(no output)"}`,
          },
        ];

        // Add images
        for (const img of result.images) {
          content.push({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          });
        }

        return { content };
      }

      case "search_notebook": {
        const {
          path,
          pattern,
          search_in = "all",
          case_sensitive = false,
          max_results,
          max_source_length = 500,
        } = args as {
          path: string;
          pattern: string;
          search_in?: "source" | "outputs" | "all";
          case_sensitive?: boolean;
          max_results?: number;
          max_source_length?: number;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const regex = createSafeRegex(pattern, case_sensitive);

        // Helper to truncate text
        const truncate = (text: string): string => {
          if (text.length <= max_source_length) return text;
          return text.slice(0, max_source_length) + "...";
        };

        const matches: any[] = [];

        for (let i = 0; i < cells.length; i++) {
          // Stop if we've hit max_results
          if (max_results !== undefined && matches.length >= max_results) break;

          const cell = cells.get(i) as any;
          const type = getCellType(cell);
          const source = extractSource(cell);

          const cellMatches: any = {
            index: i,
            type,
          };
          let hasMatch = false;

          // Search in source
          if (search_in === "source" || search_in === "all") {
            const sourceMatches = source.match(regex);
            if (sourceMatches) {
              hasMatch = true;
              cellMatches.source_matches = sourceMatches.length;
              // Include source with context (truncated)
              cellMatches.source = truncate(source);
            }
          }

          // Search in outputs (code cells only)
          if ((search_in === "outputs" || search_in === "all") && type === "code") {
            const outputs = cell instanceof Y.Map ? cell.get("outputs") : cell?.outputs;
            if (outputs) {
              const outputsJson = outputs instanceof Y.Array ? outputs.toJSON() : outputs;
              const outputTexts: string[] = [];

              for (const out of outputsJson) {
                if (out.output_type === "stream") {
                  outputTexts.push(out.text || "");
                } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
                  const text = out.data?.["text/plain"];
                  if (text) outputTexts.push(text);
                } else if (out.output_type === "error") {
                  outputTexts.push(`${out.ename}: ${out.evalue}`);
                  if (out.traceback) {
                    outputTexts.push(out.traceback.join("\n"));
                  }
                }
              }

              const combinedOutput = outputTexts.join("\n");
              const outputMatches = combinedOutput.match(regex);
              if (outputMatches) {
                hasMatch = true;
                cellMatches.output_matches = outputMatches.length;
                cellMatches.output = truncate(combinedOutput);
              }
            }
          }

          if (hasMatch) {
            matches.push(cellMatches);
          }
        }

        const summary = `Search for "${pattern}" in ${path}: ${matches.length} cell(s) matched`;

        return {
          content: [
            {
              type: "text",
              text: matches.length > 0
                ? `${summary}\n\n${JSON.stringify(matches, null, 2)}`
                : `${summary}`,
            },
          ],
        };
      }

      case "replace_in_notebook": {
        const {
          path,
          search,
          replace,
          cell_type = "code",
          case_sensitive = false,
          regex: useRegex = false,
          indices,
          dry_run = false,
        } = args as {
          path: string;
          search: string;
          replace: string;
          cell_type?: "code" | "markdown" | "all";
          case_sensitive?: boolean;
          regex?: boolean;
          indices?: number[];
          dry_run?: boolean;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        // Build search regex
        let searchRegex: RegExp;
        const flags = case_sensitive ? "g" : "gi";
        if (useRegex) {
          searchRegex = createSafeRegex(search, case_sensitive);
        } else {
          // Escape special regex characters for literal match
          const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          searchRegex = new RegExp(escaped, flags);
        }

        // Determine which cells to process
        const targetIndices = indices && indices.length > 0
          ? [...new Set(indices)].sort((a, b) => a - b)
          : Array.from({ length: cells.length }, (_, i) => i);

        const replacements: { index: number; count: number; preview?: string }[] = [];
        let totalReplacements = 0;

        for (const i of targetIndices) {
          if (i < 0 || i >= cells.length) {
            throw new Error(`Invalid cell index ${i}. Notebook has ${cells.length} cells.`);
          }

          const cell = cells.get(i) as Y.Map<any>;
          const type = getCellType(cell);

          // Skip cells that don't match the cell_type filter
          if (cell_type !== "all" && type !== cell_type) continue;

          const source = extractSource(cell);
          const matchCount = (source.match(searchRegex) || []).length;

          if (matchCount > 0) {
            const newSource = source.replace(searchRegex, replace);
            totalReplacements += matchCount;

            if (!dry_run && cell instanceof Y.Map) {
              const sourceField = cell.get("source");
              if (sourceField instanceof Y.Text) {
                sourceField.delete(0, sourceField.length);
                sourceField.insert(0, newSource);
              } else {
                cell.set("source", new Y.Text(newSource));
              }
            }

            // Show preview (first match context)
            const firstMatch = source.match(searchRegex);
            const matchIdx = firstMatch ? source.indexOf(firstMatch[0]) : 0;
            const contextStart = Math.max(0, matchIdx - 20);
            const contextEnd = Math.min(source.length, matchIdx + search.length + 20);
            const preview = (contextStart > 0 ? "..." : "") +
              source.slice(contextStart, contextEnd).replace(/\n/g, "\\n") +
              (contextEnd < source.length ? "..." : "");

            replacements.push({ index: i, count: matchCount, preview });
          }
        }

        const action = dry_run ? "Would replace" : "Replaced";
        const summary = `${action} "${search}" → "${replace}" in ${path}: ${totalReplacements} occurrence(s) in ${replacements.length} cell(s)`;

        if (replacements.length === 0) {
          return {
            content: [{ type: "text", text: `No matches found for "${search}" in ${path}` }],
          };
        }

        const details = replacements
          .map((r) => `  Cell ${r.index}: ${r.count} replacement(s) — ${r.preview}`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `${summary}\n\n${details}`,
            },
          ],
        };
      }

      case "list_files": {
        const { path = "" } = args as { path?: string };

        const response = await apiFetch(`/api/contents/${encodeURIComponent(path)}`);
        if (!response.ok) {
          throw new Error(`Failed to list files: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.type !== "directory") {
          // Single file info
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  name: data.name,
                  path: data.path,
                  type: data.type,
                  size: data.size,
                  last_modified: data.last_modified,
                }, null, 2),
              },
            ],
          };
        }

        // Directory listing
        const items = data.content.map((item: any) => ({
          name: item.name,
          type: item.type,
          path: item.path,
          ...(item.type === "notebook" ? { kernel: item.kernel_name } : {}),
        }));

        // Sort: directories first, then notebooks, then other files
        items.sort((a: any, b: any) => {
          const typeOrder: Record<string, number> = { directory: 0, notebook: 1, file: 2 };
          const aOrder = typeOrder[a.type] ?? 3;
          const bOrder = typeOrder[b.type] ?? 3;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.name.localeCompare(b.name);
        });

        return {
          content: [
            {
              type: "text",
              text: `Files in ${path || "/"}:\n\n${JSON.stringify(items, null, 2)}`,
            },
          ],
        };
      }

      case "open_notebook": {
        const { path, kernel_name } = args as { path: string; kernel_name?: string };

        // Check if notebook exists
        const checkResponse = await apiFetch(`/api/contents/${encodeURIComponent(path)}`);
        if (!checkResponse.ok) {
          throw new Error(`Notebook not found: ${path}`);
        }

        // Check if already open
        const existingSessions = await listNotebookSessions();
        const existing = existingSessions.find((s) => s.path === path);
        if (existing) {
          return {
            content: [
              {
                type: "text",
                text: `Notebook already open: ${path} (kernel: ${existing.kernelId || "none"})`,
              },
            ],
          };
        }

        // Create a new session (opens notebook with kernel)
        const sessionResponse = await apiFetch("/api/sessions", {
          method: "POST",
          body: JSON.stringify({
            path,
            type: "notebook",
            kernel: kernel_name ? { name: kernel_name } : undefined,
          }),
        });

        if (!sessionResponse.ok) {
          const error = await sessionResponse.text();
          throw new Error(`Failed to open notebook: ${error}`);
        }

        const session = await sessionResponse.json();

        return {
          content: [
            {
              type: "text",
              text: `Opened notebook: ${path}\nKernel: ${session.kernel?.name || "none"} (${session.kernel?.id || "no id"})`,
            },
          ],
        };
      }

      case "create_notebook": {
        const { path, kernel_name = "python3", open = true } = args as {
          path: string;
          kernel_name?: string;
          open?: boolean;
        };

        // Ensure path ends with .ipynb
        const nbPath = path.endsWith(".ipynb") ? path : `${path}.ipynb`;

        // Check if file already exists
        const checkResponse = await apiFetch(`/api/contents/${encodeURIComponent(nbPath)}`);
        if (checkResponse.ok) {
          throw new Error(`File already exists: ${nbPath}`);
        }

        // Create empty notebook structure
        const emptyNotebook = {
          cells: [],
          metadata: {
            kernelspec: {
              display_name: kernel_name === "python3" ? "Python 3" : kernel_name,
              language: "python",
              name: kernel_name,
            },
          },
          nbformat: 4,
          nbformat_minor: 5,
        };

        // Create the notebook file
        const createResponse = await apiFetch(`/api/contents/${encodeURIComponent(nbPath)}`, {
          method: "PUT",
          body: JSON.stringify({
            type: "notebook",
            content: emptyNotebook,
          }),
        });

        if (!createResponse.ok) {
          const error = await createResponse.text();
          throw new Error(`Failed to create notebook: ${error}`);
        }

        let result = `Created notebook: ${nbPath}`;

        // Optionally open it
        if (open) {
          const sessionResponse = await apiFetch("/api/sessions", {
            method: "POST",
            body: JSON.stringify({
              path: nbPath,
              type: "notebook",
              kernel: { name: kernel_name },
            }),
          });

          if (sessionResponse.ok) {
            const session = await sessionResponse.json();
            result += `\nOpened with kernel: ${session.kernel?.name || kernel_name}`;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      }

      case "delete_cells": {
        const { path, start_index, end_index, indices } = args as {
          path: string;
          start_index?: number;
          end_index?: number;
          indices?: number[];
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        if (indices && indices.length > 0) {
          // Non-contiguous deletion - delete in reverse order to preserve indices
          const sortedIndices = [...new Set(indices)].sort((a, b) => b - a);
          for (const idx of sortedIndices) {
            if (idx < 0 || idx >= cells.length) {
              throw new Error(`Invalid cell index ${idx}. Notebook has ${cells.length} cells.`);
            }
          }
          for (const idx of sortedIndices) {
            cells.delete(idx, 1);
          }
          const originalIndices = [...sortedIndices].reverse();
          return {
            content: [
              {
                type: "text",
                text: `Deleted ${sortedIndices.length} cells (indices ${originalIndices.join(", ")}) from ${path}`,
              },
            ],
          };
        }

        // Contiguous range deletion
        if (start_index === undefined || end_index === undefined) {
          throw new Error("Either 'indices' or both 'start_index' and 'end_index' are required.");
        }

        if (start_index < 0 || end_index >= cells.length || start_index > end_index) {
          throw new Error(
            `Invalid range [${start_index}, ${end_index}]. Notebook has ${cells.length} cells.`
          );
        }

        const count = end_index - start_index + 1;
        cells.delete(start_index, count);

        return {
          content: [
            {
              type: "text",
              text: `Deleted ${count} cells (indices ${start_index}-${end_index}) from ${path}`,
            },
          ],
        };
      }

      case "copy_cells": {
        const { source_path, dest_path, start_index, end_index, dest_index } = args as {
          source_path: string;
          dest_path: string;
          start_index: number;
          end_index: number;
          dest_index?: number;
        };

        const sessions = await listNotebookSessions();
        const sourceSession = sessions.find((s) => s.path === source_path);
        const destSession = sessions.find((s) => s.path === dest_path);

        const { doc: sourceDoc } = await connectToNotebook(source_path, sourceSession?.kernelId);
        const sourceCells = sourceDoc.getArray("cells");

        if (start_index < 0 || end_index >= sourceCells.length || start_index > end_index) {
          throw new Error(
            `Invalid source range [${start_index}, ${end_index}]. Source has ${sourceCells.length} cells.`
          );
        }

        const { doc: destDoc } = await connectToNotebook(dest_path, destSession?.kernelId);
        const destCells = destDoc.getArray("cells");

        const insertAt = dest_index ?? destCells.length;

        // Copy cells
        const copiedCells: Y.Map<any>[] = [];
        for (let i = start_index; i <= end_index; i++) {
          const sourceCell = sourceCells.get(i) as Y.Map<any>;

          // Create new cell with copied content
          const newCell = new Y.Map();
          const cellType = sourceCell.get("cell_type") || "code";
          newCell.set("cell_type", cellType);
          newCell.set("source", new Y.Text(extractSource(sourceCell)));
          newCell.set("metadata", new Y.Map());
          newCell.set("id", crypto.randomUUID());

          if (cellType === "code") {
            newCell.set("outputs", new Y.Array());
            newCell.set("execution_count", null);
          }

          copiedCells.push(newCell);
        }

        destCells.insert(insertAt, copiedCells);

        const count = end_index - start_index + 1;
        // Build summary of what was copied
        const cellSummaries: string[] = [];
        for (let i = 0; i < copiedCells.length; i++) {
          const cell = copiedCells[i];
          const type = cell.get("cell_type") || "code";
          const source = cell.get("source")?.toString() || "";
          const preview = getCodePreview(source, 50);
          cellSummaries.push(`  [${insertAt + i}] ${type}: ${preview}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `Copied ${count} cell(s) from ${source_path}[${start_index}:${end_index}] to ${dest_path} at index ${insertAt}:\n${cellSummaries.join("\n")}`,
            },
          ],
        };
      }

      case "move_cells": {
        const { source_path, dest_path, start_index, end_index, dest_index } = args as {
          source_path: string;
          dest_path: string;
          start_index: number;
          end_index: number;
          dest_index: number;
        };

        const sessions = await listNotebookSessions();
        const sourceSession = sessions.find((s) => s.path === source_path);
        const destSession = sessions.find((s) => s.path === dest_path);

        const { doc: sourceDoc } = await connectToNotebook(source_path, sourceSession?.kernelId);
        const sourceCells = sourceDoc.getArray("cells");

        if (start_index < 0 || end_index >= sourceCells.length || start_index > end_index) {
          throw new Error(
            `Invalid source range [${start_index}, ${end_index}]. Source has ${sourceCells.length} cells.`
          );
        }

        const sameNotebook = source_path === dest_path;
        const count = end_index - start_index + 1;

        // Collect cells to move (need to copy content before deleting)
        const cellsToMove: Y.Map<any>[] = [];
        for (let i = start_index; i <= end_index; i++) {
          const sourceCell = sourceCells.get(i) as Y.Map<any>;
          const newCell = new Y.Map();
          const cellType = sourceCell.get("cell_type") || "code";
          newCell.set("cell_type", cellType);
          newCell.set("source", new Y.Text(extractSource(sourceCell)));
          newCell.set("metadata", new Y.Map());
          newCell.set("id", crypto.randomUUID());
          if (cellType === "code") {
            newCell.set("outputs", new Y.Array());
            newCell.set("execution_count", null);
          }
          cellsToMove.push(newCell);
        }

        if (sameNotebook) {
          // Moving within same notebook - need to handle index adjustment
          // Delete first, then insert (adjusting dest_index if needed)
          sourceCells.delete(start_index, count);

          // Adjust destination index if it was after the deleted range
          let adjustedDest = dest_index;
          if (dest_index > start_index) {
            adjustedDest = Math.max(0, dest_index - count);
          }

          sourceCells.insert(adjustedDest, cellsToMove);

          // Build summary of what was moved
          const cellSummaries: string[] = [];
          for (let i = 0; i < cellsToMove.length; i++) {
            const cell = cellsToMove[i];
            const type = cell.get("cell_type") || "code";
            const source = cell.get("source")?.toString() || "";
            const preview = getCodePreview(source, 50);
            cellSummaries.push(`  [${adjustedDest + i}] ${type}: ${preview}`);
          }

          return {
            content: [
              {
                type: "text",
                text: `Moved ${count} cell(s) from indices ${start_index}-${end_index} to index ${adjustedDest} in ${source_path}:\n${cellSummaries.join("\n")}`,
              },
            ],
          };
        } else {
          // Moving between notebooks
          const { doc: destDoc } = await connectToNotebook(dest_path, destSession?.kernelId);
          const destCells = destDoc.getArray("cells");

          // Insert into destination
          destCells.insert(dest_index, cellsToMove);

          // Delete from source
          sourceCells.delete(start_index, count);

          // Build summary of what was moved
          const cellSummaries: string[] = [];
          for (let i = 0; i < cellsToMove.length; i++) {
            const cell = cellsToMove[i];
            const type = cell.get("cell_type") || "code";
            const source = cell.get("source")?.toString() || "";
            const preview = getCodePreview(source, 50);
            cellSummaries.push(`  [${dest_index + i}] ${type}: ${preview}`);
          }

          return {
            content: [
              {
                type: "text",
                text: `Moved ${count} cell(s) from ${source_path}[${start_index}:${end_index}] to ${dest_path} at index ${dest_index}:\n${cellSummaries.join("\n")}`,
              },
            ],
          };
        }
      }

      case "change_cell_type": {
        const { path, index, new_type } = args as {
          path: string;
          index: number;
          new_type: "code" | "markdown";
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        if (index < 0 || index >= cells.length) {
          throw new Error(`Invalid cell index ${index}. Notebook has ${cells.length} cells.`);
        }

        const cell = cells.get(index) as Y.Map<any>;
        const oldType = cell.get("cell_type") || "code";

        if (oldType === new_type) {
          return {
            content: [
              {
                type: "text",
                text: `Cell ${index} is already type '${new_type}'`,
              },
            ],
          };
        }

        cell.set("cell_type", new_type);

        // Add/remove code-specific fields
        if (new_type === "code") {
          if (!cell.get("outputs")) {
            cell.set("outputs", new Y.Array());
          }
          if (!cell.has("execution_count")) {
            cell.set("execution_count", null);
          }
        } else {
          // For markdown, we can optionally remove code fields
          // but leaving them doesn't hurt
        }

        return {
          content: [
            {
              type: "text",
              text: `Changed cell ${index} from '${oldType}' to '${new_type}'`,
            },
          ],
        };
      }

      case "get_notebook_outline": {
        const { path } = args as { path: string };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const outline: any[] = [];
        for (let i = 0; i < cells.length; i++) {
          const cell = cells.get(i) as any;
          const type = getCellType(cell);
          const source = extractSource(cell);

          if (type === "markdown") {
            // Extract headers from markdown using helper
            const headers = extractMarkdownHeaders(source);
            for (let h = 0; h < headers.length; h++) {
              const header = headers[h];
              const entry: any = {
                index: i,
                type: "header",
                level: header.level,
                text: header.text,
              };
              // Show header position within cell if multiple headers
              if (headers.length > 1) {
                entry.header_num = h + 1;
              }
              outline.push(entry);
            }
          } else if (type === "code") {
            // First non-empty line of code using helper
            outline.push({
              index: i,
              type: "code",
              preview: getCodePreview(source),
            });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Outline of ${path} (${cells.length} cells):\n\n${JSON.stringify(outline, null, 2)}`,
            },
          ],
        };
      }

      case "execute_range": {
        const { path, start_index = 0, end_index, timeout } = args as {
          path: string;
          start_index?: number;
          end_index?: number;
          timeout?: number;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

        const { doc } = await connectToNotebook(path, session.kernelId);
        const cells = doc.getArray("cells");

        const endIdx = end_index ?? cells.length - 1;

        if (start_index < 0 || endIdx >= cells.length || start_index > endIdx) {
          throw new Error(
            `Invalid range [${start_index}, ${endIdx}]. Notebook has ${cells.length} cells.`
          );
        }

        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const results: { index: number; status: string; output?: string }[] = [];

        for (let i = start_index; i <= endIdx; i++) {
          const cell = cells.get(i) as Y.Map<any>;
          const type = getCellType(cell);

          if (type !== "code") {
            results.push({ index: i, status: "skipped (not code)" });
            continue;
          }

          const source = extractSource(cell);
          if (!source.trim()) {
            results.push({ index: i, status: "skipped (empty)" });
            continue;
          }

          try {
            const result = await executeCode(session.kernelId, source, timeoutMs);
            updateCellOutputs(cell, result);
            results.push({
              index: i,
              status: result.status,
              output: result.text ? result.text.slice(0, 100) + (result.text.length > 100 ? "..." : "") : undefined,
            });
          } catch (err: any) {
            results.push({ index: i, status: `error: ${err.message}` });
          }
        }

        const successCount = results.filter((r) => r.status === "ok").length;
        const errorCount = results.filter((r) => r.status === "error" || r.status.startsWith("error:")).length;

        return {
          content: [
            {
              type: "text",
              text: `Executed cells ${start_index}-${endIdx} in ${path}\n${successCount} succeeded, ${errorCount} failed\n\n${JSON.stringify(results, null, 2)}`,
            },
          ],
        };
      }

      case "clear_outputs": {
        const { path, index } = args as { path: string; index?: number };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        if (index !== undefined) {
          // Clear single cell
          if (index < 0 || index >= cells.length) {
            throw new Error(`Invalid cell index ${index}. Notebook has ${cells.length} cells.`);
          }

          const cell = cells.get(index) as Y.Map<any>;
          const outputs = cell.get("outputs");
          if (outputs instanceof Y.Array && outputs.length > 0) {
            outputs.delete(0, outputs.length);
          }
          cell.set("execution_count", null);

          return {
            content: [
              {
                type: "text",
                text: `Cleared outputs from cell ${index} in ${path}`,
              },
            ],
          };
        } else {
          // Clear all cells
          let clearedCount = 0;
          for (let i = 0; i < cells.length; i++) {
            const cell = cells.get(i) as Y.Map<any>;
            if (getCellType(cell) === "code") {
              const outputs = cell.get("outputs");
              if (outputs instanceof Y.Array && outputs.length > 0) {
                outputs.delete(0, outputs.length);
                clearedCount++;
              }
              cell.set("execution_count", null);
            }
          }

          const message = clearedCount === 0
            ? `No cells had outputs to clear in ${path}`
            : `Cleared outputs from ${clearedCount} cell${clearedCount === 1 ? "" : "s"} in ${path}`;

          return {
            content: [
              {
                type: "text",
                text: message,
              },
            ],
          };
        }
      }

      case "get_cell_outputs": {
        const { path, index, end_index, indices } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const { indices: cellIndices, description } = resolveCellIndices(cells.length, {
          index,
          end_index,
          indices,
        });

        const results: any[] = [];
        const images: { data: string; mimeType: string }[] = [];

        for (const idx of cellIndices) {
          const cell = cells.get(idx) as Y.Map<any>;
          const type = getCellType(cell);

          if (type !== "code") {
            results.push({ index: idx, type, outputs: "(not a code cell)" });
            continue;
          }

          const outputs = cell.get("outputs");
          const executionCount = cell.get("execution_count");

          if (!outputs || !(outputs instanceof Y.Array) || outputs.length === 0) {
            // Distinguish "not executed" from "no output"
            const status = executionCount === null ? "(not executed)" : "(no output)";
            results.push({ index: idx, type, execution_count: executionCount, outputs: status });
            continue;
          }

          const outputsJson = outputs.toJSON();
          const textParts: string[] = [];

          for (const out of outputsJson) {
            if (out.output_type === "stream") {
              textParts.push(out.text || "");
            } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
              if (out.data?.["text/plain"]) {
                textParts.push(out.data["text/plain"]);
              }
              // Collect images
              if (out.data?.["image/png"]) {
                images.push({ data: out.data["image/png"], mimeType: "image/png" });
              }
              if (out.data?.["image/jpeg"]) {
                images.push({ data: out.data["image/jpeg"], mimeType: "image/jpeg" });
              }
            } else if (out.output_type === "error") {
              textParts.push(`${out.ename}: ${out.evalue}`);
            }
          }

          results.push({
            index: idx,
            type,
            execution_count: executionCount,
            text: textParts.join(""),
            output_count: outputsJson.length,
          });
        }

        const content: any[] = [
          {
            type: "text",
            text: `Outputs from ${description} in ${path}:\n\n${JSON.stringify(results, null, 2)}`,
          },
        ];

        // Include images if any
        for (const img of images) {
          content.push({
            type: "image",
            data: img.data,
            mimeType: img.mimeType,
          });
        }

        return { content };
      }

      case "get_cell_metadata": {
        const { path, index, end_index, indices } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const resolved = resolveCellIndices(cells.length, { index, end_index, indices });

        const results: any[] = [];
        for (const i of resolved.indices) {
          const cell = cells.get(i) as Y.Map<any>;
          const metadata = cell.get("metadata");
          const metadataJson = metadata instanceof Y.Map ? metadata.toJSON() : (metadata || {});
          results.push({
            index: i,
            metadata: metadataJson,
            tags: metadataJson.tags || [],
          });
        }

        return {
          content: [
            {
              type: "text",
              text: results.length === 1
                ? `Cell ${resolved.indices[0]} metadata:\n${JSON.stringify(results[0].metadata, null, 2)}`
                : `Metadata for ${resolved.description}:\n${JSON.stringify(results, null, 2)}`,
            },
          ],
        };
      }

      case "set_cell_metadata": {
        const { path, index, end_index, indices, metadata } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
          metadata: Record<string, any>;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const resolved = resolveCellIndices(cells.length, { index, end_index, indices });

        for (const i of resolved.indices) {
          const cell = cells.get(i) as Y.Map<any>;
          let cellMetadata = cell.get("metadata");

          if (!(cellMetadata instanceof Y.Map)) {
            cellMetadata = new Y.Map();
            cell.set("metadata", cellMetadata);
          }

          // Merge metadata
          for (const [key, value] of Object.entries(metadata)) {
            if (value === null) {
              cellMetadata.delete(key);
            } else if (Array.isArray(value)) {
              const arr = new Y.Array();
              arr.push(value);
              cellMetadata.set(key, arr);
            } else if (typeof value === "object") {
              const map = new Y.Map();
              for (const [k, v] of Object.entries(value)) {
                map.set(k, v);
              }
              cellMetadata.set(key, map);
            } else {
              cellMetadata.set(key, value);
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Updated metadata on ${resolved.description}`,
            },
          ],
        };
      }

      case "add_cell_tags": {
        const { path, index, end_index, indices, tags } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
          tags: string[];
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const resolved = resolveCellIndices(cells.length, { index, end_index, indices });

        for (const i of resolved.indices) {
          const cell = cells.get(i) as Y.Map<any>;
          let cellMetadata = cell.get("metadata");

          if (!(cellMetadata instanceof Y.Map)) {
            cellMetadata = new Y.Map();
            cell.set("metadata", cellMetadata);
          }

          // Get or create tags array
          let existingTags = cellMetadata.get("tags");
          let tagsArray: string[];

          if (existingTags instanceof Y.Array) {
            tagsArray = existingTags.toJSON() as string[];
          } else if (Array.isArray(existingTags)) {
            tagsArray = existingTags;
          } else {
            tagsArray = [];
          }

          // Add new tags (avoid duplicates)
          for (const tag of tags) {
            if (!tagsArray.includes(tag)) {
              tagsArray.push(tag);
            }
          }

          // Set as Y.Array
          const newTagsArray = new Y.Array();
          newTagsArray.push(tagsArray);
          cellMetadata.set("tags", newTagsArray);
        }

        return {
          content: [
            {
              type: "text",
              text: `Added tags [${tags.join(", ")}] to ${resolved.description}`,
            },
          ],
        };
      }

      case "remove_cell_tags": {
        const { path, index, end_index, indices, tags } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
          tags: string[];
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const resolved = resolveCellIndices(cells.length, { index, end_index, indices });

        for (const i of resolved.indices) {
          const cell = cells.get(i) as Y.Map<any>;
          const cellMetadata = cell.get("metadata");

          if (!(cellMetadata instanceof Y.Map)) continue;

          let existingTags = cellMetadata.get("tags");
          let tagsArray: string[];

          if (existingTags instanceof Y.Array) {
            tagsArray = existingTags.toJSON() as string[];
          } else if (Array.isArray(existingTags)) {
            tagsArray = existingTags;
          } else {
            continue; // No tags to remove
          }

          // Remove specified tags
          tagsArray = tagsArray.filter((t) => !tags.includes(t));

          // Set as Y.Array
          const newTagsArray = new Y.Array();
          newTagsArray.push(tagsArray);
          cellMetadata.set("tags", newTagsArray);
        }

        return {
          content: [
            {
              type: "text",
              text: `Removed tags [${tags.join(", ")}] from ${resolved.description}`,
            },
          ],
        };
      }

      case "find_cells_by_tag": {
        const { path, tags, match_all = false, include_preview = false } = args as {
          path: string;
          tags: string[];
          match_all?: boolean;
          include_preview?: boolean;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const matches: { index: number; type: string; tags: string[]; preview?: string }[] = [];

        for (let i = 0; i < cells.length; i++) {
          const cell = cells.get(i) as Y.Map<any>;
          const type = getCellType(cell);
          const cellMetadata = cell.get("metadata");

          let cellTags: string[] = [];
          if (cellMetadata instanceof Y.Map) {
            const tagsValue = cellMetadata.get("tags");
            if (tagsValue instanceof Y.Array) {
              cellTags = tagsValue.toJSON() as string[];
            } else if (Array.isArray(tagsValue)) {
              cellTags = tagsValue;
            }
          }

          if (cellTags.length === 0) continue;

          const hasMatch = match_all
            ? tags.every((t) => cellTags.includes(t))
            : tags.some((t) => cellTags.includes(t));

          if (hasMatch) {
            const result: { index: number; type: string; tags: string[]; preview?: string } = {
              index: i,
              type,
              tags: cellTags,
            };
            if (include_preview) {
              const source = extractSource(cell);
              result.preview = getCodePreview(source);
            }
            matches.push(result);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Found ${matches.length} cells with tag(s) [${tags.join(", ")}]${match_all ? " (match all)" : ""}:\n\n${JSON.stringify(matches, null, 2)}`,
            },
          ],
        };
      }

      case "get_notebook_metadata": {
        const { path } = args as { path: string };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const meta = doc.getMap("meta");
        const metadata = meta.get("metadata");

        const metadataJson = metadata instanceof Y.Map ? metadata.toJSON() : (metadata || {});

        return {
          content: [
            {
              type: "text",
              text: `Notebook metadata for ${path}:\n${JSON.stringify(metadataJson, null, 2)}`,
            },
          ],
        };
      }

      case "set_notebook_metadata": {
        const { path, metadata } = args as {
          path: string;
          metadata: Record<string, any>;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const meta = doc.getMap("meta");
        const existingMetadata = meta.get("metadata");

        let notebookMetadata: Y.Map<any>;
        if (existingMetadata instanceof Y.Map) {
          notebookMetadata = existingMetadata;
        } else {
          notebookMetadata = new Y.Map();
          meta.set("metadata", notebookMetadata);
        }

        // Merge metadata
        for (const [key, value] of Object.entries(metadata)) {
          if (value === null) {
            notebookMetadata.delete(key);
          } else if (typeof value === "object" && !Array.isArray(value)) {
            // For nested objects like kernelspec, create Y.Map
            const map = new Y.Map();
            for (const [k, v] of Object.entries(value)) {
              map.set(k, v);
            }
            notebookMetadata.set(key, map);
          } else {
            notebookMetadata.set(key, value);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Updated notebook metadata for ${path}`,
            },
          ],
        };
      }

      case "rename_notebook": {
        const { path, new_path } = args as {
          path: string;
          new_path: string;
        };

        if (!new_path.endsWith(".ipynb")) {
          throw new Error("New path must end in .ipynb");
        }

        // Disconnect from notebook if connected
        const existing = connectedNotebooks.get(path);
        if (existing) {
          existing.provider.destroy();
          connectedNotebooks.delete(path);
        }

        // Use Jupyter contents API to rename
        const response = await apiFetch(`/api/contents/${encodeURIComponent(path)}`, {
          method: "PATCH",
          body: JSON.stringify({ path: new_path }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Failed to rename notebook: ${response.status} ${error}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `Renamed ${path} to ${new_path}`,
            },
          ],
        };
      }

      case "diff_notebooks": {
        const { path1, path2, include_outputs, summary_only, max_diffs } = args as {
          path1: string;
          path2: string;
          include_outputs?: boolean;
          summary_only?: boolean;
          max_diffs?: number;
        };

        const sessions = await listNotebookSessions();
        const session1 = sessions.find((s) => s.path === path1);
        const session2 = sessions.find((s) => s.path === path2);

        const { doc: doc1 } = await connectToNotebook(path1, session1?.kernelId);
        const { doc: doc2 } = await connectToNotebook(path2, session2?.kernelId);

        const cells1 = doc1.getArray("cells");
        const cells2 = doc2.getArray("cells");

        const diffs: string[] = [];
        let sourceDiffs = 0;
        let typeDiffs = 0;
        let outputDiffs = 0;
        let onlyIn1 = 0;
        let onlyIn2 = 0;

        // Compare cells
        const maxCells = Math.max(cells1.length, cells2.length);
        for (let i = 0; i < maxCells; i++) {
          const cell1 = i < cells1.length ? (cells1.get(i) as Y.Map<any>) : null;
          const cell2 = i < cells2.length ? (cells2.get(i) as Y.Map<any>) : null;

          if (!cell1) {
            onlyIn2++;
            if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
              diffs.push(`[${i}] Only in ${path2}: ${getCellType(cell2)} cell`);
            }
            continue;
          }
          if (!cell2) {
            onlyIn1++;
            if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
              diffs.push(`[${i}] Only in ${path1}: ${getCellType(cell1)} cell`);
            }
            continue;
          }

          const type1 = getCellType(cell1);
          const type2 = getCellType(cell2);
          if (type1 !== type2) {
            typeDiffs++;
            if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
              diffs.push(`[${i}] Type differs: ${type1} vs ${type2}`);
            }
          }

          const source1 = extractSource(cell1);
          const source2 = extractSource(cell2);
          if (source1 !== source2) {
            sourceDiffs++;
            if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
              const preview1 = source1.slice(0, 50).replace(/\n/g, "\\n");
              const preview2 = source2.slice(0, 50).replace(/\n/g, "\\n");
              diffs.push(`[${i}] Source differs:\n  ${path1}: "${preview1}..."\n  ${path2}: "${preview2}..."`);
            }
          }

          if (include_outputs && type1 === "code") {
            const outputs1 = cell1.get("outputs");
            const outputs2 = cell2.get("outputs");
            const out1Json = outputs1 instanceof Y.Array ? JSON.stringify(outputs1.toJSON()) : "[]";
            const out2Json = outputs2 instanceof Y.Array ? JSON.stringify(outputs2.toJSON()) : "[]";
            if (out1Json !== out2Json) {
              outputDiffs++;
              if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
                diffs.push(`[${i}] Outputs differ`);
              }
            }
          }
        }

        const totalDiffs = sourceDiffs + typeDiffs + outputDiffs + onlyIn1 + onlyIn2;
        const summary = `Summary: ${totalDiffs} differences (${sourceDiffs} source, ${typeDiffs} type, ${outputDiffs} output, ${onlyIn1} only in ${path1}, ${onlyIn2} only in ${path2})`;

        let resultText: string;
        if (totalDiffs === 0) {
          resultText = `Notebooks ${path1} and ${path2} are identical`;
        } else if (summary_only) {
          resultText = summary;
        } else {
          const shownDiffs = max_diffs && diffs.length >= max_diffs ? `\n\n(showing first ${max_diffs} of ${totalDiffs} differences)` : "";
          resultText = `${summary}\n\n${diffs.join("\n\n")}${shownDiffs}`;
        }

        return {
          content: [
            {
              type: "text",
              text: resultText,
            },
          ],
        };
      }

      case "get_kernel_status": {
        const { path } = args as { path: string };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          return {
            content: [
              {
                type: "text",
                text: `No active kernel for ${path}. Use open_notebook to start a kernel.`,
              },
            ],
          };
        }

        const response = await apiFetch(`/api/kernels/${session.kernelId}`);
        if (!response.ok) {
          throw new Error(`Failed to get kernel status: ${response.statusText}`);
        }

        const kernel = await response.json();
        const lines = [
          `Kernel status for ${path}:`,
          `  Status: ${kernel.execution_state || "unknown"}`,
          `  Name: ${kernel.name}`,
          `  ID: ${kernel.id}`,
        ];
        if (kernel.connections !== undefined) {
          lines.push(`  Connections: ${kernel.connections}`);
        }
        if (kernel.last_activity) {
          lines.push(`  Last activity: ${kernel.last_activity}`);
        }
        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        };
      }

      case "get_kernel_variables": {
        const { path, filter, include_private = false } = args as {
          path: string;
          filter?: string;
          include_private?: boolean;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          return {
            content: [
              {
                type: "text",
                text: `No active kernel for ${path}. Use open_notebook to start a kernel.`,
              },
            ],
          };
        }

        // Python code to introspect variables
        const inspectCode = `
import json
_vars = {}
for _name in dir():
    if _name.startswith('_'):
        continue
    try:
        _obj = eval(_name)
        _type = type(_obj).__name__
        _repr = repr(_obj)
        if len(_repr) > 100:
            _repr = _repr[:97] + "..."
        _vars[_name] = {"type": _type, "repr": _repr}
    except:
        pass
print(json.dumps(_vars))
del _vars, _name, _obj, _type, _repr
`;

        const result = await executeCode(session.kernelId, inspectCode);

        if (result.status === "error") {
          return {
            content: [
              {
                type: "text",
                text: `Failed to inspect kernel variables: ${result.text}`,
              },
            ],
          };
        }

        try {
          const vars = JSON.parse(result.text.trim());
          let entries = Object.entries(vars) as [string, { type: string; repr: string }][];

          // Filter by name if specified
          if (filter) {
            const filterLower = filter.toLowerCase();
            entries = entries.filter(([name]) => name.toLowerCase().includes(filterLower));
          }

          // Filter private variables
          if (!include_private) {
            entries = entries.filter(([name]) => !name.startsWith("_"));
          }

          if (entries.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: filter
                    ? `No variables matching "${filter}" in ${path}`
                    : `No user-defined variables in ${path}`,
                },
              ],
            };
          }

          const lines = [`Variables in ${path} (${entries.length}):\n`];
          for (const [name, info] of entries) {
            lines.push(`  ${name}: ${info.type} = ${info.repr}`);
          }

          return {
            content: [
              {
                type: "text",
                text: lines.join("\n"),
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `Could not parse kernel variables. Raw output: ${result.text}`,
              },
            ],
          };
        }
      }

      case "interrupt_kernel": {
        const { path } = args as { path: string };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(`No active kernel for ${path}. Nothing to interrupt.`);
        }

        const response = await apiFetch(`/api/kernels/${session.kernelId}/interrupt`, {
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(`Failed to interrupt kernel: ${response.statusText}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `Interrupted kernel for ${path}. Execution stopped but variables preserved.`,
            },
          ],
        };
      }

      case "restart_kernel": {
        const { path } = args as { path: string };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(`No active kernel for ${path}. Use open_notebook to start a kernel.`);
        }

        const response = await apiFetch(`/api/kernels/${session.kernelId}/restart`, {
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(`Failed to restart kernel: ${response.statusText}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `Restarted kernel for ${path}. All variables cleared. Kernel is ready for new execution.`,
            },
          ],
        };
      }

      case "get_diagnostics": {
        const { path, cell_index } = args as { path: string; cell_index?: number };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        // Determine which cells to check
        const indicesToCheck: number[] = [];
        if (cell_index !== undefined) {
          if (cell_index < 0 || cell_index >= cells.length) {
            throw new Error(`Invalid cell index ${cell_index}. Notebook has ${cells.length} cells.`);
          }
          indicesToCheck.push(cell_index);
        } else {
          for (let i = 0; i < cells.length; i++) {
            const cell = cells.get(i) as Y.Map<any>;
            if (getCellType(cell) === "code") {
              indicesToCheck.push(i);
            }
          }
        }

        // Try LSP first if available
        const languageServer = getLanguageServerForFile(path);
        if (lspStatus.available && languageServer) {
          // For LSP, we'd need to get diagnostics from the virtual document
          // This requires the notebook to be open in JupyterLab with LSP active
          // For now, fall through to syntax check
        }

        // Use ruff via uvx for fast, comprehensive diagnostics (no kernel needed)
        const diagnostics: { cell: number; line: number; column?: number; code: string; message: string; severity: string }[] = [];
        let diagnosticMethod: "ruff" | "syntax" | "none" = "none";

        for (const idx of indicesToCheck) {
          const cell = cells.get(idx) as Y.Map<any>;
          const source = extractSource(cell);
          if (!source.trim()) continue;

          try {
            // Run ruff via uvx with JSON output
            const { spawn } = await import("child_process");
            const result = await new Promise<string>((resolve, reject) => {
              const proc = spawn("uvx", [
                "ruff", "check", "--stdin-filename", `cell_${idx}.py`,
                "--output-format", "json", "--select", "E,F", "--ignore", "F401", "-"
              ], { timeout: 10000 });

              let stdout = "";
              let stderr = "";

              proc.stdin.write(source);
              proc.stdin.end();

              proc.stdout.on("data", (data) => { stdout += data; });
              proc.stderr.on("data", (data) => { stderr += data; });

              proc.on("close", (code) => {
                // ruff returns non-zero if issues found, that's fine
                resolve(stdout);
              });

              proc.on("error", (err) => {
                reject(err);
              });
            });

            diagnosticMethod = "ruff";
            if (result.trim()) {
              const issues = JSON.parse(result);
              for (const issue of issues) {
                const severity = issue.code?.startsWith("E") ? "error" : "warning";
                diagnostics.push({
                  cell: idx,
                  line: issue.location?.row || 1,
                  column: issue.location?.column,
                  code: issue.code || "",
                  message: issue.message || "Unknown issue",
                  severity,
                });
              }
            }
          } catch (e: any) {
            // If uvx/ruff not available, fall back to basic syntax check
            if (e.code === "ENOENT" || e.message?.includes("spawn")) {
              // uvx not found - try kernel-based syntax check
              if (session?.kernelId) {
                const checkCode = `
try:
    compile(${JSON.stringify(source)}, '<cell ${idx}>', 'exec')
    print("OK")
except SyntaxError as e:
    print(f"SYNTAX:{e.lineno or 1}:{e.msg}")
`;
                try {
                  const kernelResult = await executeCode(session.kernelId, checkCode, 5000);
                  diagnosticMethod = "syntax";
                  const output = kernelResult.text.trim();
                  if (output.startsWith("SYNTAX:")) {
                    const parts = output.slice(7).split(":");
                    diagnostics.push({
                      cell: idx,
                      line: parseInt(parts[0], 10) || 1,
                      code: "E999",
                      message: parts.slice(1).join(":"),
                      severity: "error",
                    });
                  }
                } catch {
                  // Kernel check failed too
                }
              }
            }
          }
        }

        // Build result message based on what diagnostic method was available
        if (diagnosticMethod === "none") {
          return {
            content: [
              {
                type: "text",
                text: `Could not run diagnostics for ${path}. Install uv (https://docs.astral.sh/uv/) or open the notebook to enable kernel-based syntax checking.`,
              },
            ],
          };
        }

        const methodNote = diagnosticMethod === "syntax"
          ? " (syntax only - install uv for full diagnostics)"
          : "";

        if (diagnostics.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No issues found in ${indicesToCheck.length} code cell(s) of ${path}${methodNote}`,
              },
            ],
          };
        }

        const report = diagnostics
          .map((d) => {
            const loc = d.column ? `line ${d.line}:${d.column}` : `line ${d.line}`;
            const code = d.code ? `[${d.code}] ` : "";
            return `  Cell ${d.cell}, ${loc}: ${code}${d.message}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${diagnostics.length} issue(s) in ${path}:\n\n${report}`,
            },
          ],
        };
      }

      case "get_hover_info": {
        const { path, cell_index, line, character } = args as {
          path: string;
          cell_index: number;
          line: number;
          character: number;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        if (cell_index < 0 || cell_index >= cells.length) {
          throw new Error(`Invalid cell index ${cell_index}. Notebook has ${cells.length} cells.`);
        }

        const cell = cells.get(cell_index) as Y.Map<any>;
        const source = extractSource(cell);
        const lines = source.split("\n");

        if (line < 0 || line >= lines.length) {
          throw new Error(`Invalid line ${line}. Cell has ${lines.length} lines.`);
        }

        // Extract the word at the position
        const lineText = lines[line];
        let wordStart = character;
        let wordEnd = character;

        // Find word boundaries
        while (wordStart > 0 && /\w/.test(lineText[wordStart - 1])) wordStart--;
        while (wordEnd < lineText.length && /\w/.test(lineText[wordEnd])) wordEnd++;

        const word = lineText.slice(wordStart, wordEnd);

        if (!word) {
          return {
            content: [{ type: "text", text: "No identifier at this position" }],
          };
        }

        // Try LSP first if available
        const languageServer = getLanguageServerForFile(path);
        if (lspStatus.available && languageServer) {
          // Would use textDocument/hover here
          // Fall through to kernel introspection for now
        }

        // Fallback: Kernel introspection
        if (!session?.kernelId) {
          return {
            content: [
              {
                type: "text",
                text: `No kernel available. Cannot get info for "${word}".`,
              },
            ],
          };
        }

        // Build context by including earlier cells
        const contextCells: string[] = [];
        for (let i = 0; i <= cell_index; i++) {
          const c = cells.get(i) as Y.Map<any>;
          if (getCellType(c) === "code") {
            contextCells.push(extractSource(c));
          }
        }

        // Use Python introspection
        const inspectCode = `
${contextCells.join("\n")}

# Introspection
_target = ${word}
import inspect
_result_parts = []
_result_parts.append(f"**{type(_target).__name__}**: \`{_target.__name__ if hasattr(_target, '__name__') else repr(_target)[:100]}\`")
if hasattr(_target, '__doc__') and _target.__doc__:
    _doc = _target.__doc__.strip()
    if len(_doc) > 500:
        _doc = _doc[:500] + "..."
    _result_parts.append(f"\\n{_doc}")
if callable(_target):
    try:
        _sig = str(inspect.signature(_target))
        _result_parts.append(f"\\n**Signature**: \`{_target.__name__}{_sig}\`")
    except:
        pass
print("\\n".join(_result_parts))
del _target, _result_parts
`;
        try {
          const result = await executeCode(session.kernelId, inspectCode, 5000);
          if (result.status === "ok" && result.text) {
            return {
              content: [{ type: "text", text: result.text }],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `Could not get info for "${word}": ${result.text || "unknown error"}`,
                },
              ],
            };
          }
        } catch (e: any) {
          return {
            content: [
              {
                type: "text",
                text: `Could not get info for "${word}": ${e.message}`,
              },
            ],
          };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("JupyterLab MCP server started. Use connect_jupyter tool with your JupyterLab URL to begin.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
