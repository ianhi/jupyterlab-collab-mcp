#!/usr/bin/env npx tsx
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

  // Set awareness
  provider.awareness.setLocalStateField("user", {
    name: "Claude Code",
    color: "#ff6b6b",
  });

  // Wait for sync
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
          "Connect to a JupyterLab server. Call this first with the JupyterLab URL (including token). Example: http://localhost:8888/lab?token=abc123",
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
          "List all open notebooks in JupyterLab with active kernel sessions",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_notebook_content",
        description:
          "Get all cells from a notebook. Returns cell index, type, source code, and outputs.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Notebook path (e.g., 'notebook1.ipynb')",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "insert_cell",
        description:
          "Insert a new cell into the notebook. The cell will appear immediately in JupyterLab.",
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
        description: "Update the source code of an existing cell",
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
        description: "Delete a cell from the notebook",
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
        name: "execute_cell",
        description:
          "Execute a cell in the notebook and show outputs in JupyterLab. Returns the output to Claude as well.",
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
          "Execute Python code in the notebook's kernel. Optionally insert as a new cell with visible outputs.",
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
        const { path } = args as { path: string };
        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const content = [];
        for (let i = 0; i < cells.length; i++) {
          const cell = cells.get(i) as any;
          content.push({
            index: i,
            id: getCellId(cell),
            type: getCellType(cell),
            source: extractSource(cell),
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(content, null, 2),
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
          `--- ${path}:cell[${insertIndex}] (new ${cell_type} cell)`,
          `+++ ${path}:cell[${insertIndex}]`,
          `@@ -0,0 +1,${source.split("\n").length} @@`,
          ...source.split("\n").map((line) => `+${line}`),
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: insertDiff,
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

        // Generate unified diff
        const diff = generateUnifiedDiff(
          oldSource,
          source,
          `${path}:cell[${index}]`
        );

        return {
          content: [
            {
              type: "text",
              text: diff,
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
          `--- ${path}:cell[${index}] (deleted ${cellType} cell)`,
          `+++ /dev/null`,
          `@@ -1,${oldSource.split("\n").length} +0,0 @@`,
          ...oldSource.split("\n").map((line) => `-${line}`),
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: deleteDiff,
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
