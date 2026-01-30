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

// Dynamic configuration - set via connect_jupyter tool
let jupyterConfig: {
  host: string;
  port: number;
  token: string;
  baseUrl: string;
  wsUrl: string;
} | null = null;

function parseJupyterUrl(url: string): { host: string; port: number; token: string } {
  const parsed = new URL(url);
  const token = parsed.searchParams.get("token");
  if (!token) {
    throw new Error("URL must include a token parameter (e.g., ?token=xxx)");
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80),
    token,
  };
}

function getConfig() {
  if (!jupyterConfig) {
    throw new Error(
      "Not connected to JupyterLab. Use connect_jupyter tool first with your JupyterLab URL."
    );
  }
  return jupyterConfig;
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
  return sessions
    .filter((s) => s.type === "notebook")
    .map((s) => ({ path: s.path, kernelId: s.kernel?.id }));
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
    throw new Error(
      `Failed to request session: ${response.status} ${response.statusText}`
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

function extractSource(cell: any): string {
  if (!cell) return "";

  if (cell instanceof Y.Map) {
    const source = cell.get("source");
    if (source instanceof Y.Text) return source.toString();
    if (typeof source === "string") return source;
    if (Array.isArray(source)) return source.join("");
    return String(source || "");
  }

  const source = cell.source;
  if (typeof source === "string") return source;
  if (source instanceof Y.Text) return source.toString();
  if (Array.isArray(source)) return source.join("");
  return String(source || "");
}

function getCellType(cell: any): string {
  if (cell instanceof Y.Map) {
    return cell.get("cell_type") || "code";
  }
  return cell?.cell_type || "code";
}

function getCellId(cell: any): string | undefined {
  if (cell instanceof Y.Map) {
    return cell.get("id");
  }
  return cell?.id;
}

// ============================================================================
// Kernel execution
// ============================================================================

interface NotebookOutput {
  output_type: "stream" | "execute_result" | "error" | "display_data";
  [key: string]: any;
}

interface ExecutionResult {
  status: "ok" | "error";
  executionCount: number | null;
  outputs: NotebookOutput[];
  text: string;
  images: { data: string; mimeType: string }[];  // Base64-encoded images
  html: string[];  // HTML outputs (for rich reprs)
}

async function executeCode(
  kernelId: string,
  code: string
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

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Execution timeout after 30 seconds"));
    }, 30000);

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

// Generate a unified diff between two strings
function generateUnifiedDiff(
  oldStr: string,
  newStr: string,
  filename: string
): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  // Simple line-by-line diff
  const diffLines: string[] = [];
  diffLines.push(`--- ${filename} (before)`);
  diffLines.push(`+++ ${filename} (after)`);

  // Find changed regions
  const maxLen = Math.max(oldLines.length, newLines.length);
  let inChange = false;
  let changeStart = 0;
  const changes: { oldStart: number; oldLines: string[]; newLines: string[] }[] = [];
  let currentOld: string[] = [];
  let currentNew: string[] = [];

  for (let i = 0; i <= maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine !== newLine) {
      if (!inChange) {
        inChange = true;
        changeStart = i;
        currentOld = [];
        currentNew = [];
      }
      if (oldLine !== undefined) currentOld.push(oldLine);
      if (newLine !== undefined) currentNew.push(newLine);
    } else if (inChange) {
      changes.push({ oldStart: changeStart, oldLines: currentOld, newLines: currentNew });
      inChange = false;
    }
  }

  if (inChange) {
    changes.push({ oldStart: changeStart, oldLines: currentOld, newLines: currentNew });
  }

  // Format hunks
  for (const change of changes) {
    const contextStart = Math.max(0, change.oldStart - 2);
    const oldEnd = change.oldStart + change.oldLines.length;
    const newEnd = change.oldStart + change.newLines.length;

    diffLines.push(
      `@@ -${change.oldStart + 1},${change.oldLines.length} +${change.oldStart + 1},${change.newLines.length} @@`
    );

    // Add context before
    for (let i = contextStart; i < change.oldStart && i < oldLines.length; i++) {
      diffLines.push(` ${oldLines[i]}`);
    }

    // Add removed lines
    for (const line of change.oldLines) {
      diffLines.push(`-${line}`);
    }

    // Add added lines
    for (const line of change.newLines) {
      diffLines.push(`+${line}`);
    }

    // Add context after
    const contextEnd = Math.min(oldLines.length, oldEnd + 2);
    for (let i = oldEnd; i < contextEnd; i++) {
      diffLines.push(` ${oldLines[i]}`);
    }
  }

  if (changes.length === 0) {
    return "(no changes)";
  }

  return diffLines.join("\n");
}

// Update a cell's outputs in the Y.Doc
function updateCellOutputs(
  cell: Y.Map<any>,
  result: ExecutionResult
): void {
  cell.set("execution_count", result.executionCount);

  let outputsArray = cell.get("outputs");
  if (!(outputsArray instanceof Y.Array)) {
    outputsArray = new Y.Array();
    cell.set("outputs", outputsArray);
  }

  // Clear existing outputs
  if (outputsArray.length > 0) {
    outputsArray.delete(0, outputsArray.length);
  }

  // Add new outputs as Y.Maps
  for (const output of result.outputs) {
    const outputMap = new Y.Map();
    for (const [key, value] of Object.entries(output)) {
      if (Array.isArray(value)) {
        const arr = new Y.Array();
        arr.push(value);
        outputMap.set(key, arr);
      } else if (typeof value === "object" && value !== null) {
        const map = new Y.Map();
        for (const [k, v] of Object.entries(value)) {
          map.set(k, v);
        }
        outputMap.set(key, map);
      } else {
        outputMap.set(key, value);
      }
    }
    outputsArray.push([outputMap]);
  }
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
          "Connect to a JupyterLab server. MUST be called first before using any other jupyter tools. Provide the full URL including token. Example: http://localhost:8888/lab?token=abc123",
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
        name: "list_notebooks",
        description:
          "List all open notebooks in JupyterLab with active kernel sessions. Returns notebook paths and kernel IDs. Requires connect_jupyter first.",
        inputSchema: {
          type: "object",
          properties: {},
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
              description: "End at this cell index (exclusive). Default: end of notebook",
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
        description: "Update the source code of an existing cell. Changes sync in real-time to JupyterLab browser. Returns a diff showing what changed.",
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
        name: "get_user_focus",
        description:
          "Get the cell the user is currently focused on via JupyterLab's awareness protocol. Returns cursor positions and active cell index.",
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
          },
          required: ["path", "index"],
        },
      },
      {
        name: "execute_code",
        description:
          "Execute arbitrary Python code in the notebook's kernel without modifying the notebook. Set insertCell=true to also add the code as a new cell with visible outputs in JupyterLab.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path (to identify which kernel to use)",
            },
            code: {
              type: "string",
              description: "Python code to execute",
            },
            insertCell: {
              type: "boolean",
              description:
                "If true, insert code as a new cell and show outputs in JupyterLab (default: false)",
            },
          },
          required: ["path", "code"],
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
          },
          required: ["path", "index", "source"],
        },
      },
      {
        name: "search_notebook",
        description:
          "Search/grep through notebook cells for a pattern (regex supported). Returns matching cells with source code and/or outputs. Useful for finding errors, tracebacks, variable usage, or specific text.",
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
          },
          required: ["path", "pattern"],
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
        name: "open_notebook",
        description:
          "Open a notebook in JupyterLab and start a kernel. The notebook will appear in the browser and be ready for editing/execution.",
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
          },
          required: ["path", "start_index", "end_index"],
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
        name: "get_notebook_outline",
        description:
          "Get a condensed outline of the notebook structure. Shows markdown headers and first line of code cells. Useful for navigating large notebooks.",
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
        name: "execute_range",
        description:
          "Execute multiple cells in sequence. Useful for running a section or the entire notebook.",
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
          },
          required: ["path"],
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
    ],
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

        return {
          content: [
            {
              type: "text",
              text: `Connected to JupyterLab at ${jupyterConfig.baseUrl}\n\nOpen notebooks:\n${
                notebooks.length > 0
                  ? notebooks.map((n) => `- ${n.path}`).join("\n")
                  : "(no notebooks open)"
              }`,
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

        const endIdx = end_index ?? cells.length;
        const content = [];

        for (let i = start_index; i < endIdx && i < cells.length; i++) {
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

        const insertIndex =
          index === undefined || index === -1 ? cells.length : index;
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
              text: `Updated cell ${index} in ${path}\n\n\`\`\`diff\n${diff}\n\`\`\``,
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
        const { path, index } = args as { path: string; index: number };

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
        const result = await executeCode(session.kernelId, source);

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
        const { path, code, insertCell } = args as {
          path: string;
          code: string;
          insertCell?: boolean;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

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
          const result = await executeCode(session.kernelId, code);
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
          const result = await executeCode(session.kernelId, code);

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
        const { path, index, source } = args as {
          path: string;
          index?: number;
          source: string;
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
        const result = await executeCode(session.kernelId, source);

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
        const { path, index, source } = args as {
          path: string;
          index: number;
          source: string;
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
        const result = await executeCode(session.kernelId, source);

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
            text: `Updated and executed cell ${index} in ${path}\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nOutput:\n${result.text || "(no output)"}`,
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
        } = args as {
          path: string;
          pattern: string;
          search_in?: "source" | "outputs" | "all";
          case_sensitive?: boolean;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const flags = case_sensitive ? "g" : "gi";
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, flags);
        } catch {
          // If invalid regex, escape and use as literal string
          regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
        }

        const matches: any[] = [];

        for (let i = 0; i < cells.length; i++) {
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
              // Include source with context
              cellMatches.source = source;
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
                cellMatches.output = combinedOutput;
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
        const { path, start_index, end_index } = args as {
          path: string;
          start_index: number;
          end_index: number;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

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
        return {
          content: [
            {
              type: "text",
              text: `Copied ${count} cell(s) from ${source_path}[${start_index}:${end_index}] to ${dest_path} at index ${insertAt}`,
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

          return {
            content: [
              {
                type: "text",
                text: `Moved ${count} cell(s) from indices ${start_index}-${end_index} to index ${adjustedDest} in ${source_path}`,
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

          return {
            content: [
              {
                type: "text",
                text: `Moved ${count} cell(s) from ${source_path}[${start_index}:${end_index}] to ${dest_path} at index ${dest_index}`,
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
            // Extract headers from markdown
            const lines = source.split("\n");
            for (const line of lines) {
              const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
              if (headerMatch) {
                outline.push({
                  index: i,
                  type: "header",
                  level: headerMatch[1].length,
                  text: headerMatch[2].trim(),
                });
              }
            }
          } else if (type === "code") {
            // First non-empty line of code
            const firstLine = source.split("\n").find((l) => l.trim()) || "(empty)";
            outline.push({
              index: i,
              type: "code",
              preview: firstLine.slice(0, 60) + (firstLine.length > 60 ? "..." : ""),
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
        const { path, start_index = 0, end_index } = args as {
          path: string;
          start_index?: number;
          end_index?: number;
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
            const result = await executeCode(session.kernelId, source);
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

          return {
            content: [
              {
                type: "text",
                text: `Cleared outputs from ${clearedCount} cells in ${path}`,
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
