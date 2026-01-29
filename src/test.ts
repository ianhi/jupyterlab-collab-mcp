#!/usr/bin/env npx tsx
/**
 * Standalone test script for JupyterLab RTC connection.
 *
 * Run with:
 *   JUPYTER_TOKEN=xxx npm test
 *   or
 *   JUPYTER_TOKEN=xxx npx tsx src/test.ts
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

// Configuration from environment
const config = {
  host: process.env.JUPYTER_HOST || "localhost",
  port: parseInt(process.env.JUPYTER_PORT || "8888", 10),
  token: process.env.JUPYTER_TOKEN || null,
};

if (!config.token) {
  console.error("Error: JUPYTER_TOKEN environment variable is required");
  console.error("Get it with: jupyter server list");
  process.exit(1);
}

const baseUrl = `http://${config.host}:${config.port}`;
const wsUrl = `ws://${config.host}:${config.port}`;

interface SessionInfo {
  format: string;
  type: string;
  fileId: string;
  sessionId: string;
}

async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const url = new URL(endpoint, baseUrl);
  url.searchParams.set("token", config.token!);

  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url.toString(), { ...options, headers });
}

interface NotebookSession {
  path: string;
  kernelId: string;
}

async function listNotebooks(): Promise<NotebookSession[]> {
  const response = await apiFetch("/api/sessions");
  if (!response.ok) {
    throw new Error(`Failed to list sessions: ${response.statusText}`);
  }

  const sessions: any[] = await response.json();
  return sessions
    .filter((s) => s.type === "notebook")
    .map((s) => ({ path: s.path, kernelId: s.kernel?.id }));
}

// Notebook output format (nbformat spec)
interface NotebookOutput {
  output_type: "stream" | "execute_result" | "error" | "display_data";
  [key: string]: any;
}

interface ExecutionResult {
  status: "ok" | "error";
  executionCount: number | null;
  outputs: NotebookOutput[];  // Raw notebook outputs for the cell
  text: string;  // Combined text output for Claude
}

async function executeCode(kernelId: string, code: string): Promise<ExecutionResult> {
  return new Promise((resolve, reject) => {
    const wsUrlWithToken = `${wsUrl}/api/kernels/${kernelId}/channels?token=${config.token}`;
    const ws = new WebSocket(wsUrlWithToken);

    const msgId = crypto.randomUUID();
    const outputs: NotebookOutput[] = [];
    const textParts: string[] = [];
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
          textParts.push(msg.content.data?.["text/plain"] || "");
          break;

        case "display_data":
          outputs.push({
            output_type: "display_data",
            data: msg.content.data,
            metadata: msg.content.metadata || {},
          });
          textParts.push(msg.content.data?.["text/plain"] || "[display data]");
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

// Execute code and update a cell's outputs in the notebook
async function executeCellInNotebook(
  cell: Y.Map<any>,
  kernelId: string
): Promise<ExecutionResult> {
  const source = extractSource(cell);
  const result = await executeCode(kernelId, source);

  // Update the cell's execution_count
  cell.set("execution_count", result.executionCount);

  // Clear and update outputs
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

  return result;
}

async function requestSession(path: string): Promise<SessionInfo> {
  const response = await apiFetch(
    `/api/collaboration/session/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      body: JSON.stringify({ format: "json", type: "notebook" }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to request session: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function connectToNotebook(path: string): Promise<Y.Doc> {
  console.log(`\n📓 Connecting to: ${path}`);

  // Step 1: Request session
  const session = await requestSession(path);
  console.log(`   Session: fileId=${session.fileId}`);
  console.log(`            sessionId=${session.sessionId}`);

  // Step 2: Create Y.Doc
  const doc = new Y.Doc();

  // Step 3: Build room ID
  const roomId = `${session.format}:${session.type}:${session.fileId}`;
  // y-websocket appends roomId to the base URL, so we just pass the collaboration endpoint
  const roomUrl = `${wsUrl}/api/collaboration/room`;
  console.log(`   Room: ${roomId}`);

  // Step 4: Create WebSocket provider
  // y-websocket constructs URL as: `${serverUrl}/${roomname}?${params}`
  // DON'T encode the roomId - the browser uses unencoded colons
  const params = `sessionId=${encodeURIComponent(session.sessionId)}&token=${encodeURIComponent(config.token!)}`;
  console.log(`   Connecting to: ${roomUrl}/${roomId}?${params}`);

  const provider = new WebsocketProvider(roomUrl, roomId, doc, {
    params: {
      sessionId: session.sessionId,
      token: config.token!,
    },
  });

  // Set awareness (so we show up as a collaborator)
  provider.awareness.setLocalStateField("user", {
    name: "Claude Code RTC",
    color: "#ff6b6b",
    username: "claude",
  });
  console.log(`   Awareness clientID: ${provider.awareness.clientID}`);
  console.log(`   Awareness states: ${provider.awareness.getStates().size} clients`);

  // Step 5: Wait for sync
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      provider.destroy();
      reject(new Error("Sync timeout after 10 seconds"));
    }, 10000);

    provider.on("sync", (synced: boolean) => {
      if (synced) {
        clearTimeout(timeout);
        console.log(`   ✅ Synced!`);
        resolve(doc);
      }
    });

    provider.on("connection-error", (event: any) => {
      clearTimeout(timeout);
      provider.destroy();
      reject(new Error(`Connection error: ${event.message || event}`));
    });

    provider.on("status", (event: { status: string }) => {
      console.log(`   Status: ${event.status}`);
    });
  });
}

function extractSource(cell: any): string {
  if (!cell) return "";

  // Handle Y.Map cells
  if (cell instanceof Y.Map) {
    const source = cell.get("source");
    if (source instanceof Y.Text) return source.toString();
    if (typeof source === "string") return source;
    if (Array.isArray(source)) return source.join("");
    return String(source || "");
  }

  // Handle plain object cells
  const source = cell.source;
  if (typeof source === "string") return source;
  if (source instanceof Y.Text) return source.toString();
  if (Array.isArray(source)) return source.join("");
  return String(source || "");
}

function printNotebookContent(doc: Y.Doc) {
  // Debug: print all shared types in the doc
  console.log("\n📦 Y.Doc structure:");
  const state = doc.share;
  for (const [key, value] of state.entries()) {
    console.log(`   - ${key}: ${value.constructor.name} (${value instanceof Y.Array ? value.length + ' items' : value instanceof Y.Map ? Object.keys(value.toJSON()).join(', ') : 'unknown'})`);
  }

  const cells = doc.getArray("cells");
  console.log(`\n📋 Notebook has ${cells.length} cells:\n`);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells.get(i) as any;
    const cellType = cell?.cell_type || (cell instanceof Y.Map ? cell.get("cell_type") : "unknown");
    const source = extractSource(cell);
    const preview = source.slice(0, 60).replace(/\n/g, "\\n");

    console.log(`   [${i}] ${cellType}: ${preview}${source.length > 60 ? "..." : ""}`);

    // Debug first cell structure
    if (i === 0) {
      console.log(`   Debug cell[0]: ${JSON.stringify(cell instanceof Y.Map ? cell.toJSON() : cell, null, 2).slice(0, 500)}`);
    }
  }
}

async function main() {
  console.log("🔍 JupyterLab RTC Connection Test");
  console.log(`   Server: ${baseUrl}`);

  // List notebooks
  console.log("\n📚 Open notebooks:");
  const notebooks = await listNotebooks();

  if (notebooks.length === 0) {
    console.log("   No notebooks open. Please open a notebook in JupyterLab.");
    process.exit(1);
  }

  for (const nb of notebooks) {
    console.log(`   - ${nb.path} (kernel: ${nb.kernelId})`);
  }

  // Connect to first notebook
  const notebook = notebooks[0];
  const doc = await connectToNotebook(notebook.path);

  // Print content
  printNotebookContent(doc);

  // Test inserting a cell using Y.Map (like JupyterLab does)
  console.log("\n🧪 Test: Inserting a cell using Y.Map...");
  const cells = doc.getArray("cells");

  // Create cell as Y.Map with Y.Text for source
  const testCell = new Y.Map();
  testCell.set("cell_type", "code");
  testCell.set("source", new Y.Text("# Cell from Claude RTC!\nprint('It works!')"));
  testCell.set("metadata", new Y.Map());
  testCell.set("outputs", new Y.Array());
  testCell.set("execution_count", null);

  // Also set an ID which JupyterLab uses
  testCell.set("id", crypto.randomUUID());

  cells.push([testCell]);
  console.log("   ✅ Cell inserted! Check your JupyterLab browser.");

  // Wait a bit for sync, then print again
  await new Promise((r) => setTimeout(r, 1000));
  printNotebookContent(doc);

  // Test: Execute a cell and show outputs in JupyterLab
  if (notebook.kernelId) {
    console.log("\n⚡ Test: Executing cell in notebook (outputs will show in JupyterLab)...");

    // Insert a cell with code to execute
    const execCell = new Y.Map();
    execCell.set("cell_type", "code");
    execCell.set("source", new Y.Text('print("Hello from Claude!")\nimport sys\nprint(f"Python {sys.version}")\n2 + 2'));
    execCell.set("metadata", new Y.Map());
    execCell.set("outputs", new Y.Array());
    execCell.set("execution_count", null);
    execCell.set("id", crypto.randomUUID());
    cells.push([execCell]);

    console.log("   Cell inserted, now executing...");

    // Execute the cell - this updates outputs in the notebook
    const result = await executeCellInNotebook(execCell, notebook.kernelId);

    console.log(`   Status: ${result.status}`);
    console.log(`   Execution count: ${result.executionCount}`);
    console.log(`   Output: ${result.text}`);
    console.log("   ✅ Check JupyterLab - you should see the output in the cell!");
  } else {
    console.log("\n⚠️  No kernel available for execution test");
  }

  console.log("\n✅ Test complete!");
  process.exit(0);
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
