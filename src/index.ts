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
import {
  extractSource,
  getCellType,
  getCellId,
  resolveCellIndices,
  resolveCellId,
  resolveCellIds,
  truncatedCellId,
  parseJupyterUrl,
  generateUnifiedDiff,
  updateCellOutputs,
  createSafeRegex,
  extractMarkdownHeaders,
  getCodePreview,
  extractOutputsWithTraceback,
  truncateDiff,
  formatOutputsAsText,
  buildExecutionContent,
  checkHumanFocus,
} from "./helpers.js";
import {
  readNotebook,
  writeNotebook,
  resolveNotebookPath,
  createEmptyNotebook,
  sourceToLines,
  type NotebookData,
  type NotebookCell,
} from "./notebook-fs.js";
import {
  setJupyterConfig,
  getConfig,
  isJupyterConnected,
  lspStatus,
  checkLspAvailability,
  lspRequest,
  getLanguageServerForFile,
  connectedNotebooks,
  apiFetch,
  listNotebookSessions,
  type NotebookSession,
  connectToNotebook,
  executeCode,
} from "./connection.js";
import {
  getSessionWithKernel,
  connectAndGetCells,
  getNotebookCells,
  resolveIndexParam,
  validateCellIndex,
  cellCount,
  assertCellNotInUse,
} from "./tool-helpers.js";
import { toolSchemas } from "./schemas.js";
import { renameSymbol } from "./rename.js";
import {
  recordChange,
  getCellHistory,
  getChangesSince,
  getCurrentVersion,
  getDeletedCellSource,
} from "./cell-tracker.js";
import {
  createSnapshot,
  getSnapshot,
  listSnapshots as listSnapshotsForPath,
  restoreSnapshotToYjs,
  restoreSnapshotToFs,
  diffSnapshot,
} from "./snapshots.js";
import {
  acquireLocks,
  releaseLocks,
  listLocks as listLocksForPath,
  checkLock,
} from "./cell-locks.js";
import { readdir, stat, rename as fsRename } from "fs/promises";
import { join, resolve as pathResolve } from "path";

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
  return { tools: toolSchemas };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "connect_jupyter": {
        const { url } = args as { url: string };
        const parsed = parseJupyterUrl(url);

        const config = {
          host: parsed.host,
          port: parsed.port,
          token: parsed.token,
          baseUrl: `http://${parsed.host}:${parsed.port}`,
          wsUrl: `ws://${parsed.host}:${parsed.port}`,
        };
        setJupyterConfig(config);

        // Test connection by listing sessions
        const response = await apiFetch("/api/sessions");
        if (!response.ok) {
          setJupyterConfig(null);
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
              text: `Connected to JupyterLab at ${config.baseUrl}\n\nOpen notebooks:\n${
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
          indices,
          cell_ids,
        } = args as {
          path: string;
          cell_type?: "all" | "code" | "markdown";
          include_outputs?: boolean;
          output_format?: "text" | "structured";
          start_index?: number;
          end_index?: number;
          indices?: number[];
          cell_ids?: string[];
        };

        // Helper to build cell data from either backend
        const buildCellData = (cell: any, i: number): any | null => {
          const type = getCellType(cell);
          if (cell_type !== "all" && type !== cell_type) return null;

          const cellData: any = {
            index: i,
            id: truncatedCellId(cell),
            type,
            source: extractSource(cell),
          };

          if (include_outputs && type === "code") {
            const outputs = cell instanceof Y.Map ? cell.get("outputs") : cell?.outputs;
            if (outputs) {
              const outputsJson = outputs instanceof Y.Array ? outputs.toJSON() : (Array.isArray(outputs) ? outputs : []);
              if (output_format === "text") {
                const combinedText = formatOutputsAsText(outputsJson);
                if (combinedText) cellData.output = combinedText;
              } else {
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

          return cellData;
        };

        // Determine which cell indices to iterate
        const getCellIndicesToRead = (cellsOrLength: any): number[] => {
          const length = typeof cellsOrLength === "number" ? cellsOrLength : (cellsOrLength instanceof Y.Array ? cellsOrLength.length : cellsOrLength.length);
          if (cell_ids && cell_ids.length > 0) {
            // cell_ids takes highest priority
            return resolveCellIds(cellsOrLength, cell_ids);
          }
          if (indices && indices.length > 0) {
            const sorted = [...new Set(indices)].sort((a, b) => a - b);
            for (const idx of sorted) {
              if (idx < 0 || idx >= length) {
                throw new Error(`Invalid cell index ${idx}. Notebook has ${length} cells.`);
              }
            }
            return sorted;
          }
          // Default: start_index/end_index range
          const endIdx = end_index ?? (length - 1);
          const result: number[] = [];
          for (let i = start_index; i <= endIdx && i < length; i++) {
            result.push(i);
          }
          return result;
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          const cells = notebook.cells;
          const cellIndices = getCellIndicesToRead(cells);

          const content = [];
          for (const i of cellIndices) {
            const cellData = buildCellData(cells[i], i);
            if (cellData) content.push(cellData);
          }

          const totalCells = cells.length;
          const returnedCells = content.length;
          const summary = `Notebook: ${path} (${totalCells} total cells, returning ${returnedCells}${cell_type !== "all" ? ` ${cell_type} cells` : ""}${include_outputs ? " with outputs" : ""})`;

          return {
            content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(content, null, 2)}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");
        const cellIndices = getCellIndicesToRead(cells);

        const content = [];
        for (const i of cellIndices) {
          const cell = cells.get(i) as any;
          const cellData = buildCellData(cell, i);
          if (cellData) content.push(cellData);
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
        const { path, index, cell_id, source, cell_type = "code", client_name } = args as {
          path: string;
          index?: number;
          cell_id?: string;
          source: string;
          cell_type?: string;
          client_name?: string;
        };
        const clientId = client_name || "claude-code";

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          const cells = notebook.cells;

          // Resolve cell_id to "insert after" position
          let resolvedIndex = index;
          if (cell_id !== undefined) {
            if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
            resolvedIndex = resolveCellId(cells, cell_id) + 1; // insert after
          }

          const newCell: NotebookCell = {
            cell_type,
            source,
            metadata: {},
            id: crypto.randomUUID(),
            ...(cell_type === "code" ? { outputs: [], execution_count: null } : {}),
          };

          let insertIndex: number;
          if (resolvedIndex === undefined || resolvedIndex === -1) {
            insertIndex = cells.length;
          } else if (resolvedIndex < -1) {
            throw new Error(`Invalid index ${resolvedIndex}. Use -1 to append at end, or 0-${cells.length} to insert at a specific position.`);
          } else if (resolvedIndex > cells.length) {
            throw new Error(`Invalid index ${resolvedIndex}. Notebook has ${cells.length} cells. Use 0-${cells.length} or -1 to append.`);
          } else {
            insertIndex = resolvedIndex;
          }

          cells.splice(insertIndex, 0, newCell);
          await writeNotebook(resolved, notebook);

          const newId = (newCell.id || "").slice(0, 8);
          recordChange(path, {
            operation: "insert",
            cellId: newCell.id || "",
            cellIdShort: newId,
            cellIndex: insertIndex,
            newSource: source,
            client: clientId,
          });
          const insertDiff = [
            `--- /dev/null`,
            `+++ ${path}:cell[${insertIndex}]`,
            `@@ -0,0 +1,${source.split("\n").length} @@`,
            ...source.split("\n").map((line) => `+${line}`),
          ].join("\n");

          return {
            content: [{ type: "text", text: `Inserted ${cell_type} cell at index ${insertIndex} (id: ${newId}) in ${path}\n\n${insertDiff}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        // Resolve cell_id to "insert after" position
        let resolvedIndex = index;
        if (cell_id !== undefined) {
          if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
          resolvedIndex = resolveCellId(cells, cell_id) + 1; // insert after
        }

        // Create cell as Y.Map with Y.Text for source
        const newCell = new Y.Map();
        newCell.set("cell_type", cell_type);
        newCell.set("source", new Y.Text(source));
        newCell.set("metadata", new Y.Map());
        if (cell_type === "code") {
          newCell.set("outputs", new Y.Array());
          newCell.set("execution_count", null);
        }
        const newCellId = crypto.randomUUID();
        newCell.set("id", newCellId);

        // Handle index: undefined/-1 = append, 0+ = insert at position
        let insertIndex: number;
        if (resolvedIndex === undefined || resolvedIndex === -1) {
          insertIndex = cells.length;
        } else if (resolvedIndex < -1) {
          throw new Error(`Invalid index ${resolvedIndex}. Use -1 to append at end, or 0-${cells.length} to insert at a specific position.`);
        } else if (resolvedIndex > cells.length) {
          throw new Error(`Invalid index ${resolvedIndex}. Notebook has ${cells.length} cells. Use 0-${cells.length} or -1 to append.`);
        } else {
          insertIndex = resolvedIndex;
        }
        cells.insert(insertIndex, [newCell]);

        recordChange(path, {
          operation: "insert",
          cellId: newCellId,
          cellIdShort: newCellId.slice(0, 8),
          cellIndex: insertIndex,
          newSource: source,
          client: clientId,
        });

        // Show what was inserted
        const newId = newCellId.slice(0, 8);
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
              text: `Inserted ${cell_type} cell at index ${insertIndex} (id: ${newId}) in ${path}\n\n${insertDiff}`,
            },
          ],
        };
      }

      case "update_cell": {
        const { path, index, cell_id, source, force = false, client_name } = args as {
          path: string;
          index?: number;
          cell_id?: string;
          source: string;
          force?: boolean;
          client_name?: string;
        };
        const clientId = client_name || "claude-code";

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          let resolvedIndex = index;
          if (cell_id !== undefined) {
            if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
            resolvedIndex = resolveCellId(notebook.cells, cell_id);
          }
          if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

          if (resolvedIndex < 0 || resolvedIndex >= notebook.cells.length) {
            throw new Error(`Invalid cell index ${resolvedIndex}. Notebook has ${notebook.cells.length} cells.`);
          }

          const oldSource = extractSource(notebook.cells[resolvedIndex]);
          notebook.cells[resolvedIndex].source = source;
          await writeNotebook(resolved, notebook);

          const cellIdStr = truncatedCellId(notebook.cells[resolvedIndex]);
          recordChange(path, {
            operation: "update",
            cellId: getCellId(notebook.cells[resolvedIndex]) || "",
            cellIdShort: cellIdStr || "",
            cellIndex: resolvedIndex,
            oldSource,
            newSource: source,
            client: clientId,
          });
          const diff = generateUnifiedDiff(oldSource, source, `${path}:cell[${resolvedIndex}]`);
          return {
            content: [{ type: "text", text: `Updated cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} in ${path}\n\n${truncateDiff(diff)}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc, provider } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        let resolvedIndex = index;
        if (cell_id !== undefined) {
          if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
          resolvedIndex = resolveCellId(cells, cell_id);
        }
        if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

        if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
          throw new Error(
            `Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`
          );
        }

        // Check human focus
        if (!force) {
          const focus = checkHumanFocus(provider, doc, resolvedIndex);
          if (focus.blocked) {
            const cellIdStr = truncatedCellId(cells.get(resolvedIndex) as any);
            throw new Error(`Cannot modify cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} — user "${focus.user}" is currently editing it. Use force=true to override.`);
          }
        }

        const cell = cells.get(resolvedIndex) as Y.Map<any>;

        // Check advisory lock
        let lockOverrideDetail: string | undefined;
        const fullCellId = getCellId(cell) || "";
        if (fullCellId) {
          const lock = checkLock(path, fullCellId, clientId);
          if (lock) {
            if (!force) {
              const cellIdStr = truncatedCellId(cell);
              throw new Error(`Cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} is locked by "${lock.owner}" (expires ${new Date(lock.expiresAt).toLocaleTimeString()}). Use force=true to override.`);
            }
            lockOverrideDetail = `force-overrode lock held by "${lock.owner}"`;
          }
        }

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

        const cellIdStr = truncatedCellId(cell);
        recordChange(path, {
          operation: "update",
          cellId: getCellId(cell) || "",
          cellIdShort: cellIdStr || "",
          cellIndex: resolvedIndex,
          oldSource,
          newSource: source,
          client: clientId,
          detail: lockOverrideDetail,
        });

        const diff = generateUnifiedDiff(
          oldSource,
          source,
          `${path}:cell[${resolvedIndex}]`
        );

        return {
          content: [
            {
              type: "text",
              text: `Updated cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} in ${path}\n\n${truncateDiff(diff)}`,
            },
          ],
        };
      }

      case "batch_update_cells": {
        const { path, updates } = args as {
          path: string;
          updates: { index: number; source: string }[];
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          for (const update of updates) {
            if (update.index < 0 || update.index >= notebook.cells.length) {
              throw new Error(`Invalid cell index ${update.index}. Notebook has ${notebook.cells.length} cells.`);
            }
          }

          const diffs: string[] = [];
          for (const update of updates) {
            const oldSource = extractSource(notebook.cells[update.index]);
            notebook.cells[update.index].source = update.source;

            const diff = generateUnifiedDiff(oldSource, update.source, `${path}:cell[${update.index}]`);
            if (diff !== "(no changes)") {
              diffs.push(`Cell ${update.index}:\n${truncateDiff(diff)}`);
            }
          }

          await writeNotebook(resolved, notebook);

          return {
            content: [{ type: "text", text: `Updated ${updates.length} cells in ${path}\n\n${diffs.join("\n\n")}` }],
          };
        }

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
              text: `Updated ${updates.length} cells in ${path}\n\n${diffs.join("\n\n")}`,
            },
          ],
        };
      }

      case "delete_cell": {
        const { path, index, cell_id, force = false, client_name } = args as {
          path: string;
          index?: number;
          cell_id?: string;
          force?: boolean;
          client_name?: string;
        };
        const clientId = client_name || "claude-code";

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          let resolvedIndex = index;
          if (cell_id !== undefined) {
            if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
            resolvedIndex = resolveCellId(notebook.cells, cell_id);
          }
          if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

          if (resolvedIndex < 0 || resolvedIndex >= notebook.cells.length) {
            throw new Error(`Invalid cell index ${resolvedIndex}. Notebook has ${notebook.cells.length} cells.`);
          }

          const cell = notebook.cells[resolvedIndex];
          const oldSource = extractSource(cell);
          const cellType = getCellType(cell);
          const cellIdStr = truncatedCellId(cell);

          recordChange(path, {
            operation: "delete",
            cellId: getCellId(cell) || "",
            cellIdShort: cellIdStr || "",
            cellIndex: resolvedIndex,
            oldSource,
            client: clientId,
          });

          notebook.cells.splice(resolvedIndex, 1);
          await writeNotebook(resolved, notebook);

          const deleteDiff = [
            `--- ${path}:cell[${resolvedIndex}]`,
            `+++ /dev/null`,
            `@@ -1,${oldSource.split("\n").length} +0,0 @@`,
            ...oldSource.split("\n").map((line) => `-${line}`),
          ].join("\n");

          return {
            content: [{ type: "text", text: `Deleted ${cellType} cell at index ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} in ${path}\n\n${deleteDiff}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc, provider } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        let resolvedIndex = index;
        if (cell_id !== undefined) {
          if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
          resolvedIndex = resolveCellId(cells, cell_id);
        }
        if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

        if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
          throw new Error(
            `Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`
          );
        }

        // Check human focus
        if (!force) {
          const focus = checkHumanFocus(provider, doc, resolvedIndex);
          if (focus.blocked) {
            const cellIdStr = truncatedCellId(cells.get(resolvedIndex) as any);
            throw new Error(`Cannot delete cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} — user "${focus.user}" is currently editing it. Use force=true to override.`);
          }
        }

        // Capture source before deleting
        const cell = cells.get(resolvedIndex) as Y.Map<any>;

        // Check advisory lock
        let lockOverrideDetail: string | undefined;
        const fullCellId = getCellId(cell) || "";
        if (fullCellId) {
          const lock = checkLock(path, fullCellId, clientId);
          if (lock) {
            if (!force) {
              const cellIdStr = truncatedCellId(cell);
              throw new Error(`Cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} is locked by "${lock.owner}" (expires ${new Date(lock.expiresAt).toLocaleTimeString()}). Use force=true to override.`);
            }
            lockOverrideDetail = `force-overrode lock held by "${lock.owner}"`;
          }
        }

        const oldSource = extractSource(cell);
        const cellType = getCellType(cell);
        const cellIdStr = truncatedCellId(cell);

        recordChange(path, {
          operation: "delete",
          cellId: getCellId(cell) || "",
          cellIdShort: cellIdStr || "",
          cellIndex: resolvedIndex,
          oldSource,
          client: clientId,
          detail: lockOverrideDetail,
        });

        cells.delete(resolvedIndex, 1);

        // Show what was deleted
        const deleteDiff = [
          `--- ${path}:cell[${resolvedIndex}]`,
          `+++ /dev/null`,
          `@@ -1,${oldSource.split("\n").length} +0,0 @@`,
          ...oldSource.split("\n").map((line) => `-${line}`),
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Deleted ${cellType} cell at index ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} in ${path}\n\n${deleteDiff}`,
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
        const { path, index, cell_id, timeout, max_images, include_images } = args as {
          path: string;
          index?: number;
          cell_id?: string;
          timeout?: number;
          max_images?: number;
          include_images?: boolean;
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

        let resolvedIndex = index;
        if (cell_id !== undefined) {
          if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
          resolvedIndex = resolveCellId(cells, cell_id);
        }
        if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

        if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
          throw new Error(
            `Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`
          );
        }

        const cell = cells.get(resolvedIndex) as Y.Map<any>;
        const source = extractSource(cell);
        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const result = await executeCode(session.kernelId, source, timeoutMs);

        // Update cell outputs in the notebook
        if (cell instanceof Y.Map) {
          updateCellOutputs(cell, result);
        }

        return { content: buildExecutionContent(result, "", { max_images, include_images }) };
      }

      case "execute_code": {
        const { path, code, insertCell, timeout, max_images, include_images } = args as {
          path: string;
          code: string;
          insertCell?: boolean;
          timeout?: number;
          max_images?: number;
          include_images?: boolean;
        };

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const imgOpts = { max_images, include_images };

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

          return { content: buildExecutionContent(result, `Cell inserted at index ${cells.length - 1}\n\nOutput:\n`, imgOpts) };
        } else {
          // Execute without inserting a cell
          const result = await executeCode(session.kernelId, code, timeoutMs);
          return { content: buildExecutionContent(result, "", imgOpts) };
        }
      }

      case "insert_and_execute": {
        const { path, index, cell_id, source, timeout, max_images, include_images, client_name } = args as {
          path: string;
          index?: number;
          cell_id?: string;
          source: string;
          timeout?: number;
          max_images?: number;
          include_images?: boolean;
          client_name?: string;
        };
        const clientId = client_name || "claude-code";

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

        const { doc } = await connectToNotebook(path, session.kernelId);
        const cells = doc.getArray("cells");

        // Resolve cell_id to "insert after" position
        let resolvedIndex = index;
        if (cell_id !== undefined) {
          if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
          resolvedIndex = resolveCellId(cells, cell_id) + 1; // insert after
        }

        // Create cell as Y.Map with Y.Text for source
        const newCell = new Y.Map();
        newCell.set("cell_type", "code");
        newCell.set("source", new Y.Text(source));
        newCell.set("metadata", new Y.Map());
        newCell.set("outputs", new Y.Array());
        newCell.set("execution_count", null);
        const newCellId = crypto.randomUUID();
        newCell.set("id", newCellId);

        const insertIndex = resolvedIndex === undefined || resolvedIndex === -1 ? cells.length : resolvedIndex;
        cells.insert(insertIndex, [newCell]);

        recordChange(path, {
          operation: "insert",
          cellId: newCellId,
          cellIdShort: newCellId.slice(0, 8),
          cellIndex: insertIndex,
          newSource: source,
          client: clientId,
        });

        // Execute the cell
        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const result = await executeCode(session.kernelId, source, timeoutMs);

        // Update cell outputs in the notebook
        updateCellOutputs(newCell, result);

        const newId = newCellId.slice(0, 8);
        return { content: buildExecutionContent(result, `Inserted and executed cell at index ${insertIndex} (id: ${newId}) in ${path}\n\nOutput:\n`, { max_images, include_images }) };
      }

      case "update_and_execute": {
        const { path, index, cell_id, source, force = false, timeout, max_images, include_images, client_name } = args as {
          path: string;
          index?: number;
          cell_id?: string;
          source: string;
          force?: boolean;
          timeout?: number;
          max_images?: number;
          include_images?: boolean;
          client_name?: string;
        };
        const clientId = client_name || "claude-code";

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        if (!session?.kernelId) {
          throw new Error(
            `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
          );
        }

        const { doc, provider } = await connectToNotebook(path, session.kernelId);
        const cells = doc.getArray("cells");

        let resolvedIndex = index;
        if (cell_id !== undefined) {
          if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
          resolvedIndex = resolveCellId(cells, cell_id);
        }
        if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

        if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
          throw new Error(
            `Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`
          );
        }

        // Check human focus
        if (!force) {
          const focus = checkHumanFocus(provider, doc, resolvedIndex);
          if (focus.blocked) {
            const cellIdStr = truncatedCellId(cells.get(resolvedIndex) as any);
            throw new Error(`Cannot modify cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} — user "${focus.user}" is currently editing it. Use force=true to override.`);
          }
        }

        const cell = cells.get(resolvedIndex) as Y.Map<any>;

        // Check advisory lock
        let lockOverrideDetail: string | undefined;
        const fullCellId = getCellId(cell) || "";
        if (fullCellId) {
          const lock = checkLock(path, fullCellId, clientId);
          if (lock) {
            if (!force) {
              const cellIdStr = truncatedCellId(cell);
              throw new Error(`Cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} is locked by "${lock.owner}" (expires ${new Date(lock.expiresAt).toLocaleTimeString()}). Use force=true to override.`);
            }
            lockOverrideDetail = `force-overrode lock held by "${lock.owner}"`;
          }
        }

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

        recordChange(path, {
          operation: "update",
          cellId: getCellId(cell) || "",
          cellIdShort: truncatedCellId(cell) || "",
          cellIndex: resolvedIndex,
          oldSource,
          newSource: source,
          client: clientId,
          detail: lockOverrideDetail,
        });

        // Execute the cell
        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const result = await executeCode(session.kernelId, source, timeoutMs);

        // Update cell outputs in the notebook
        if (cell instanceof Y.Map) {
          updateCellOutputs(cell, result);
        }

        // Generate diff
        const cellIdStr = truncatedCellId(cell);
        const diff = generateUnifiedDiff(oldSource, source, `${path}:cell[${resolvedIndex}]`);

        return { content: buildExecutionContent(result, `Updated and executed cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} in ${path}\n\n${truncateDiff(diff)}\n\nOutput:\n`, { max_images, include_images }) };
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

        const regex = createSafeRegex(pattern, case_sensitive);
        const truncate = (text: string): string => {
          if (text.length <= max_source_length) return text;
          return text.slice(0, max_source_length) + "...";
        };

        // Shared search logic for both backends
        const searchCells = (cells: any[], getCell: (i: number) => any, getOutputs: (cell: any) => any[] | null): any[] => {
          const matches: any[] = [];
          for (let i = 0; i < cells.length; i++) {
            if (max_results !== undefined && matches.length >= max_results) break;

            const cell = getCell(i);
            const type = getCellType(cell);
            const source = extractSource(cell);

            const id = truncatedCellId(cell);
            const cellMatches: any = { index: i, id, type };
            let hasMatch = false;

            if (search_in === "source" || search_in === "all") {
              const sourceMatches = source.match(regex);
              if (sourceMatches) {
                hasMatch = true;
                cellMatches.source_matches = sourceMatches.length;
                cellMatches.source = truncate(source);
              }
            }

            if ((search_in === "outputs" || search_in === "all") && type === "code") {
              const outputs = getOutputs(cell);
              if (outputs) {
                const outputTexts: string[] = [];
                for (const out of outputs) {
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

            if (hasMatch) matches.push(cellMatches);
          }
          return matches;
        };

        let matches: any[];

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          matches = searchCells(
            notebook.cells,
            (i) => notebook.cells[i],
            (cell) => cell.outputs || null,
          );
        } else {
          const sessions = await listNotebookSessions();
          const session = sessions.find((s) => s.path === path);
          const { doc } = await connectToNotebook(path, session?.kernelId);
          const cells = doc.getArray("cells");
          matches = searchCells(
            Array.from({ length: cells.length }),
            (i) => cells.get(i),
            (cell) => {
              const outputs = cell instanceof Y.Map ? cell.get("outputs") : cell?.outputs;
              if (!outputs) return null;
              return outputs instanceof Y.Array ? outputs.toJSON() : outputs;
            },
          );
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

        // Build search regex
        let searchRegex: RegExp;
        const flags = case_sensitive ? "g" : "gi";
        if (useRegex) {
          searchRegex = createSafeRegex(search, case_sensitive);
        } else {
          const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          searchRegex = new RegExp(escaped, flags);
        }

        // Helper to build preview
        const makePreview = (source: string): string => {
          const firstMatch = source.match(searchRegex);
          const matchIdx = firstMatch ? source.indexOf(firstMatch[0]) : 0;
          const contextStart = Math.max(0, matchIdx - 20);
          const contextEnd = Math.min(source.length, matchIdx + search.length + 20);
          return (contextStart > 0 ? "..." : "") +
            source.slice(contextStart, contextEnd).replace(/\n/g, "\\n") +
            (contextEnd < source.length ? "..." : "");
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          const cells = notebook.cells;

          const targetIndices = indices && indices.length > 0
            ? [...new Set(indices)].sort((a, b) => a - b)
            : Array.from({ length: cells.length }, (_, i) => i);

          const replacements: { index: number; count: number; preview?: string }[] = [];
          let totalReplacements = 0;

          for (const i of targetIndices) {
            if (i < 0 || i >= cells.length) {
              throw new Error(`Invalid cell index ${i}. Notebook has ${cells.length} cells.`);
            }
            const cell = cells[i];
            const type = getCellType(cell);
            if (cell_type !== "all" && type !== cell_type) continue;

            const source = extractSource(cell);
            const matchCount = (source.match(searchRegex) || []).length;

            if (matchCount > 0) {
              totalReplacements += matchCount;
              const preview = makePreview(source);

              if (!dry_run) {
                cell.source = source.replace(searchRegex, replace);
              }
              replacements.push({ index: i, count: matchCount, preview });
            }
          }

          if (!dry_run && replacements.length > 0) {
            await writeNotebook(resolved, notebook);
          }

          const action = dry_run ? "Would replace" : "Replaced";
          const summary = `${action} "${search}" → "${replace}" in ${path}: ${totalReplacements} occurrence(s) in ${replacements.length} cell(s)`;

          if (replacements.length === 0) {
            return { content: [{ type: "text", text: `No matches found for "${search}" in ${path}` }] };
          }

          const details = replacements
            .map((r) => `  Cell ${r.index}: ${r.count} replacement(s) — ${r.preview}`)
            .join("\n");

          return { content: [{ type: "text", text: `${summary}\n\n${details}` }] };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

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

            replacements.push({ index: i, count: matchCount, preview: makePreview(source) });
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

      case "rename_symbol": {
        const { path, cell_index, line, character, new_name } = args as {
          path: string;
          cell_index: number;
          line: number;
          character: number;
          new_name: string;
        };

        if (!isJupyterConnected()) {
          // Filesystem mode
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          const cells = notebook.cells as { cell_type: string; source: string }[];

          const result = await renameSymbol(cells, cell_index, line, character, new_name);

          if (result.edits.length === 0) {
            return {
              content: [{ type: "text", text: "No changes — symbol may not have other references." }],
            };
          }

          // Apply edits to the notebook
          for (const edit of result.edits) {
            notebook.cells[edit.cellIndex].source = edit.newSource;
          }
          await writeNotebook(resolved, notebook);

          const details = result.edits
            .map((e) => `  Cell ${e.cellIndex}: ${e.oldSource.split("\n")[0]}... → ${e.newSource.split("\n")[0]}...`)
            .join("\n");

          return {
            content: [{
              type: "text",
              text: `Renamed "${result.oldName}" → "${result.newName}" in ${result.edits.length} cell(s)\n\n${details}`,
            }],
          };
        }

        // Jupyter mode — read cells from Yjs, do rename, apply edits back
        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);
        const { doc } = await connectToNotebook(path, session?.kernelId);
        const yCells = doc.getArray("cells");

        // Build cell array for renameSymbol
        const cells: { cell_type: string; source: string }[] = [];
        for (let i = 0; i < yCells.length; i++) {
          const cell = yCells.get(i) as Y.Map<any>;
          cells.push({
            cell_type: getCellType(cell),
            source: extractSource(cell),
          });
        }

        const result = await renameSymbol(cells, cell_index, line, character, new_name);

        if (result.edits.length === 0) {
          return {
            content: [{ type: "text", text: "No changes — symbol may not have other references." }],
          };
        }

        // Apply edits back via Yjs
        for (const edit of result.edits) {
          const cell = yCells.get(edit.cellIndex) as Y.Map<any>;
          if (cell instanceof Y.Map) {
            const sourceField = cell.get("source");
            if (sourceField instanceof Y.Text) {
              sourceField.delete(0, sourceField.length);
              sourceField.insert(0, edit.newSource);
            } else {
              cell.set("source", new Y.Text(edit.newSource));
            }
          }
        }

        const details = result.edits
          .map((e) => `  Cell ${e.cellIndex}: ${e.oldSource.split("\n")[0]}... → ${e.newSource.split("\n")[0]}...`)
          .join("\n");

        return {
          content: [{
            type: "text",
            text: `Renamed "${result.oldName}" → "${result.newName}" in ${result.edits.length} cell(s)\n\n${details}`,
          }],
        };
      }

      case "list_files": {
        const { path = "" } = args as { path?: string };

        if (!isJupyterConnected()) {
          const resolved = path ? resolveNotebookPath(path) : process.cwd();
          const dirStat = await stat(resolved);

          if (!dirStat.isDirectory()) {
            // Single file info
            const fileStat = await stat(resolved);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  name: resolved.split("/").pop(),
                  path: resolved,
                  type: resolved.endsWith(".ipynb") ? "notebook" : "file",
                  size: fileStat.size,
                  last_modified: fileStat.mtime.toISOString(),
                }, null, 2),
              }],
            };
          }

          const entries = await readdir(resolved, { withFileTypes: true });
          const items = entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : entry.name.endsWith(".ipynb") ? "notebook" : "file",
            path: join(resolved, entry.name),
          }));

          items.sort((a, b) => {
            const typeOrder: Record<string, number> = { directory: 0, notebook: 1, file: 2 };
            const aOrder = typeOrder[a.type] ?? 3;
            const bOrder = typeOrder[b.type] ?? 3;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.name.localeCompare(b.name);
          });

          return {
            content: [{ type: "text", text: `Files in ${resolved}:\n\n${JSON.stringify(items, null, 2)}` }],
          };
        }

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

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(nbPath);

          // Check if file already exists
          try {
            await stat(resolved);
            throw new Error(`File already exists: ${nbPath}`);
          } catch (e: any) {
            if (e.message?.startsWith("File already exists")) throw e;
            // ENOENT means file doesn't exist - that's what we want
          }

          const emptyNb = createEmptyNotebook(kernel_name);
          await writeNotebook(resolved, emptyNb);

          return {
            content: [{ type: "text", text: `Created notebook: ${nbPath}` }],
          };
        }

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
        const { path, start_index, end_index, indices, cell_ids } = args as {
          path: string;
          start_index?: number;
          end_index?: number;
          indices?: number[];
          cell_ids?: string[];
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          const cells = notebook.cells;

          // Resolve cell_ids to indices
          const effectiveIndices = cell_ids && cell_ids.length > 0
            ? resolveCellIds(cells, cell_ids)
            : indices;

          if (effectiveIndices && effectiveIndices.length > 0) {
            const sortedIndices = [...new Set(effectiveIndices)].sort((a, b) => b - a);
            for (const idx of sortedIndices) {
              if (idx < 0 || idx >= cells.length) {
                throw new Error(`Invalid cell index ${idx}. Notebook has ${cells.length} cells.`);
              }
            }
            for (const idx of sortedIndices) {
              cells.splice(idx, 1);
            }
            await writeNotebook(resolved, notebook);
            const originalIndices = [...sortedIndices].reverse();
            return {
              content: [{ type: "text", text: `Deleted ${sortedIndices.length} cells (indices ${originalIndices.join(", ")}) from ${path}` }],
            };
          }

          if (start_index === undefined || end_index === undefined) {
            throw new Error("Either 'indices' or both 'start_index' and 'end_index' are required.");
          }
          if (start_index < 0 || end_index >= cells.length || start_index > end_index) {
            throw new Error(`Invalid range [${start_index}, ${end_index}]. Notebook has ${cells.length} cells.`);
          }

          const count = end_index - start_index + 1;
          cells.splice(start_index, count);
          await writeNotebook(resolved, notebook);

          return {
            content: [{ type: "text", text: `Deleted ${count} cells (indices ${start_index}-${end_index}) from ${path}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        // Resolve cell_ids to indices
        const effectiveIndicesJup = cell_ids && cell_ids.length > 0
          ? resolveCellIds(cells, cell_ids)
          : indices;

        if (effectiveIndicesJup && effectiveIndicesJup.length > 0) {
          // Non-contiguous deletion - delete in reverse order to preserve indices
          const sortedIndices = [...new Set(effectiveIndicesJup)].sort((a, b) => b - a);
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
          throw new Error("Either 'indices', 'cell_ids', or both 'start_index' and 'end_index' are required.");
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
        const { source_path, dest_path, start_index, end_index, cell_ids: copyCellIds, dest_index, dest_cell_id } = args as {
          source_path: string;
          dest_path: string;
          start_index?: number;
          end_index?: number;
          cell_ids?: string[];
          dest_index?: number;
          dest_cell_id?: string;
        };

        if (!isJupyterConnected()) {
          const resolvedSrc = resolveNotebookPath(source_path);
          const resolvedDest = resolveNotebookPath(dest_path);
          const srcNb = await readNotebook(resolvedSrc);
          const destNb = resolvedSrc === resolvedDest ? srcNb : await readNotebook(resolvedDest);

          // Resolve source indices
          let sourceIndices: number[];
          if (copyCellIds && copyCellIds.length > 0) {
            sourceIndices = resolveCellIds(srcNb.cells, copyCellIds);
          } else if (start_index !== undefined && end_index !== undefined) {
            if (start_index < 0 || end_index >= srcNb.cells.length || start_index > end_index) {
              throw new Error(`Invalid source range [${start_index}, ${end_index}]. Source has ${srcNb.cells.length} cells.`);
            }
            sourceIndices = [];
            for (let i = start_index; i <= end_index; i++) sourceIndices.push(i);
          } else {
            throw new Error("Specify 'cell_ids' or both 'start_index' and 'end_index'.");
          }

          // Resolve destination
          let insertAt: number;
          if (dest_cell_id !== undefined) {
            insertAt = resolveCellId(destNb.cells, dest_cell_id) + 1;
          } else {
            insertAt = dest_index ?? destNb.cells.length;
          }

          // Deep copy cells
          const copiedCells: NotebookCell[] = [];
          for (const i of sourceIndices) {
            const src = srcNb.cells[i];
            const cellType = src.cell_type || "code";
            const newCell: NotebookCell = {
              cell_type: cellType,
              source: extractSource(src),
              metadata: {},
              id: crypto.randomUUID(),
              ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
            };
            copiedCells.push(newCell);
          }

          destNb.cells.splice(insertAt, 0, ...copiedCells);
          await writeNotebook(resolvedDest, destNb);

          const cellSummaries = copiedCells.map((cell, i) => {
            const newId = (cell.id || "").slice(0, 8);
            const preview = getCodePreview(typeof cell.source === "string" ? cell.source : "", 50);
            return `  [${insertAt + i}] (${newId}) ${cell.cell_type}: ${preview}`;
          });

          const rangeLabel = copyCellIds ? `${copyCellIds.length} cells by ID` : `[${start_index}:${end_index}]`;
          return {
            content: [{ type: "text", text: `Copied ${copiedCells.length} cell(s) from ${source_path} ${rangeLabel} to ${dest_path} at index ${insertAt}:\n${cellSummaries.join("\n")}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const sourceSession = sessions.find((s) => s.path === source_path);
        const destSession = sessions.find((s) => s.path === dest_path);

        const { doc: sourceDoc } = await connectToNotebook(source_path, sourceSession?.kernelId);
        const sourceCells = sourceDoc.getArray("cells");

        // Resolve source indices
        let sourceIndices: number[];
        if (copyCellIds && copyCellIds.length > 0) {
          sourceIndices = resolveCellIds(sourceCells, copyCellIds);
        } else if (start_index !== undefined && end_index !== undefined) {
          if (start_index < 0 || end_index >= sourceCells.length || start_index > end_index) {
            throw new Error(`Invalid source range [${start_index}, ${end_index}]. Source has ${sourceCells.length} cells.`);
          }
          sourceIndices = [];
          for (let i = start_index; i <= end_index; i++) sourceIndices.push(i);
        } else {
          throw new Error("Specify 'cell_ids' or both 'start_index' and 'end_index'.");
        }

        const { doc: destDoc } = await connectToNotebook(dest_path, destSession?.kernelId);
        const destCells = destDoc.getArray("cells");

        // Resolve destination
        let insertAt: number;
        if (dest_cell_id !== undefined) {
          insertAt = resolveCellId(destCells, dest_cell_id) + 1;
        } else {
          insertAt = dest_index ?? destCells.length;
        }

        // Copy cells
        const copiedCells: Y.Map<any>[] = [];
        for (const i of sourceIndices) {
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
          copiedCells.push(newCell);
        }

        destCells.insert(insertAt, copiedCells);

        const cellSummaries: string[] = [];
        for (let i = 0; i < copiedCells.length; i++) {
          const cell = copiedCells[i];
          const type = cell.get("cell_type") || "code";
          const newId = (cell.get("id") || "").slice(0, 8);
          const source = cell.get("source")?.toString() || "";
          const preview = getCodePreview(source, 50);
          cellSummaries.push(`  [${insertAt + i}] (${newId}) ${type}: ${preview}`);
        }

        const rangeLabel = copyCellIds ? `${copyCellIds.length} cells by ID` : `[${start_index}:${end_index}]`;
        return {
          content: [
            {
              type: "text",
              text: `Copied ${copiedCells.length} cell(s) from ${source_path} ${rangeLabel} to ${dest_path} at index ${insertAt}:\n${cellSummaries.join("\n")}`,
            },
          ],
        };
      }

      case "move_cells": {
        const { source_path, dest_path, start_index, end_index, cell_ids: moveCellIds, dest_index, dest_cell_id } = args as {
          source_path: string;
          dest_path: string;
          start_index?: number;
          end_index?: number;
          cell_ids?: string[];
          dest_index?: number;
          dest_cell_id?: string;
        };

        if (!isJupyterConnected()) {
          const resolvedSrc = resolveNotebookPath(source_path);
          const resolvedDest = resolveNotebookPath(dest_path);
          const srcNb = await readNotebook(resolvedSrc);
          const sameNotebook = resolvedSrc === resolvedDest;
          const destNb = sameNotebook ? srcNb : await readNotebook(resolvedDest);

          // Resolve source indices
          let sourceIndices: number[];
          if (moveCellIds && moveCellIds.length > 0) {
            sourceIndices = resolveCellIds(srcNb.cells, moveCellIds);
          } else if (start_index !== undefined && end_index !== undefined) {
            if (start_index < 0 || end_index >= srcNb.cells.length || start_index > end_index) {
              throw new Error(`Invalid source range [${start_index}, ${end_index}]. Source has ${srcNb.cells.length} cells.`);
            }
            sourceIndices = [];
            for (let i = start_index; i <= end_index; i++) sourceIndices.push(i);
          } else {
            throw new Error("Specify 'cell_ids' or both 'start_index' and 'end_index'.");
          }

          // Resolve destination
          let resolvedDest_index: number;
          if (dest_cell_id !== undefined) {
            resolvedDest_index = resolveCellId(destNb.cells, dest_cell_id) + 1;
          } else if (dest_index !== undefined) {
            resolvedDest_index = dest_index;
          } else {
            throw new Error("Specify 'dest_index' or 'dest_cell_id'.");
          }

          const count = sourceIndices.length;

          // Copy cells content (before deleting)
          const cellsToMove: NotebookCell[] = [];
          for (const i of sourceIndices) {
            const src = srcNb.cells[i];
            const cellType = src.cell_type || "code";
            cellsToMove.push({
              cell_type: cellType,
              source: extractSource(src),
              metadata: {},
              id: crypto.randomUUID(),
              ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
            });
          }

          // Delete from source (reverse order to preserve indices)
          for (let i = sourceIndices.length - 1; i >= 0; i--) {
            srcNb.cells.splice(sourceIndices[i], 1);
          }

          // Adjust dest for same-notebook case
          let adjustedDest = resolvedDest_index;
          if (sameNotebook) {
            // Count how many deleted cells were before the destination
            const deletedBefore = sourceIndices.filter((i) => i < resolvedDest_index).length;
            adjustedDest = Math.max(0, resolvedDest_index - deletedBefore);
          }

          destNb.cells.splice(adjustedDest, 0, ...cellsToMove);

          await writeNotebook(resolvedSrc, srcNb);
          if (!sameNotebook) await writeNotebook(resolvedDest, destNb);

          const cellSummaries = cellsToMove.map((cell, i) => {
            const preview = getCodePreview(typeof cell.source === "string" ? cell.source : "", 50);
            return `  [${adjustedDest + i}] ${cell.cell_type}: ${preview}`;
          });

          const rangeLabel = moveCellIds ? `${count} cells by ID` : `indices ${start_index}-${end_index}`;
          const destLabel = sameNotebook ? `index ${adjustedDest} in ${source_path}` : `${dest_path} at index ${adjustedDest}`;
          return {
            content: [{ type: "text", text: `Moved ${count} cell(s) from ${rangeLabel} to ${destLabel}:\n${cellSummaries.join("\n")}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const sourceSession = sessions.find((s) => s.path === source_path);
        const destSession = sessions.find((s) => s.path === dest_path);

        const { doc: sourceDoc } = await connectToNotebook(source_path, sourceSession?.kernelId);
        const sourceCells = sourceDoc.getArray("cells");

        // Resolve source indices
        let sourceIndices: number[];
        if (moveCellIds && moveCellIds.length > 0) {
          sourceIndices = resolveCellIds(sourceCells, moveCellIds);
        } else if (start_index !== undefined && end_index !== undefined) {
          if (start_index < 0 || end_index >= sourceCells.length || start_index > end_index) {
            throw new Error(`Invalid source range [${start_index}, ${end_index}]. Source has ${sourceCells.length} cells.`);
          }
          sourceIndices = [];
          for (let i = start_index; i <= end_index; i++) sourceIndices.push(i);
        } else {
          throw new Error("Specify 'cell_ids' or both 'start_index' and 'end_index'.");
        }

        const sameNotebook = source_path === dest_path;
        const count = sourceIndices.length;

        // Collect cells to move (copy content before deleting)
        const cellsToMove: Y.Map<any>[] = [];
        for (const i of sourceIndices) {
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
          // Resolve destination
          let resolvedDest_idx: number;
          if (dest_cell_id !== undefined) {
            resolvedDest_idx = resolveCellId(sourceCells, dest_cell_id) + 1;
          } else if (dest_index !== undefined) {
            resolvedDest_idx = dest_index;
          } else {
            throw new Error("Specify 'dest_index' or 'dest_cell_id'.");
          }

          // Delete from source (reverse order)
          for (let i = sourceIndices.length - 1; i >= 0; i--) {
            sourceCells.delete(sourceIndices[i], 1);
          }

          // Adjust dest
          const deletedBefore = sourceIndices.filter((si) => si < resolvedDest_idx).length;
          const adjustedDest = Math.max(0, resolvedDest_idx - deletedBefore);

          sourceCells.insert(adjustedDest, cellsToMove);

          const cellSummaries: string[] = [];
          for (let i = 0; i < cellsToMove.length; i++) {
            const cell = cellsToMove[i];
            const type = cell.get("cell_type") || "code";
            const source = cell.get("source")?.toString() || "";
            const preview = getCodePreview(source, 50);
            cellSummaries.push(`  [${adjustedDest + i}] ${type}: ${preview}`);
          }

          const rangeLabel = moveCellIds ? `${count} cells by ID` : `indices ${start_index}-${end_index}`;
          return {
            content: [{ type: "text", text: `Moved ${count} cell(s) from ${rangeLabel} to index ${adjustedDest} in ${source_path}:\n${cellSummaries.join("\n")}` }],
          };
        } else {
          // Moving between notebooks
          const { doc: destDoc } = await connectToNotebook(dest_path, destSession?.kernelId);
          const destCells = destDoc.getArray("cells");

          // Resolve destination
          let resolvedDest_idx: number;
          if (dest_cell_id !== undefined) {
            resolvedDest_idx = resolveCellId(destCells, dest_cell_id) + 1;
          } else if (dest_index !== undefined) {
            resolvedDest_idx = dest_index;
          } else {
            throw new Error("Specify 'dest_index' or 'dest_cell_id'.");
          }

          // Insert into destination
          destCells.insert(resolvedDest_idx, cellsToMove);

          // Delete from source (reverse order)
          for (let i = sourceIndices.length - 1; i >= 0; i--) {
            sourceCells.delete(sourceIndices[i], 1);
          }

          const cellSummaries: string[] = [];
          for (let i = 0; i < cellsToMove.length; i++) {
            const cell = cellsToMove[i];
            const type = cell.get("cell_type") || "code";
            const source = cell.get("source")?.toString() || "";
            const preview = getCodePreview(source, 50);
            cellSummaries.push(`  [${resolvedDest_idx + i}] ${type}: ${preview}`);
          }

          const rangeLabel = moveCellIds ? `${count} cells by ID` : `[${start_index}:${end_index}]`;
          return {
            content: [{ type: "text", text: `Moved ${count} cell(s) from ${source_path} ${rangeLabel} to ${dest_path} at index ${resolvedDest_idx}:\n${cellSummaries.join("\n")}` }],
          };
        }
      }

      case "change_cell_type": {
        const { path, index, cell_id, new_type, force = false } = args as {
          path: string;
          index?: number;
          cell_id?: string;
          new_type: "code" | "markdown";
          force?: boolean;
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          let resolvedIndex = index;
          if (cell_id !== undefined) {
            if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
            resolvedIndex = resolveCellId(notebook.cells, cell_id);
          }
          if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

          if (resolvedIndex < 0 || resolvedIndex >= notebook.cells.length) {
            throw new Error(`Invalid cell index ${resolvedIndex}. Notebook has ${notebook.cells.length} cells.`);
          }

          const cell = notebook.cells[resolvedIndex];
          const oldType = cell.cell_type || "code";

          if (oldType === new_type) {
            return { content: [{ type: "text", text: `Cell ${resolvedIndex} is already type '${new_type}'` }] };
          }

          cell.cell_type = new_type;
          if (new_type === "code") {
            if (!cell.outputs) cell.outputs = [];
            if (cell.execution_count === undefined) cell.execution_count = null;
          }

          await writeNotebook(resolved, notebook);
          return { content: [{ type: "text", text: `Changed cell ${resolvedIndex} from '${oldType}' to '${new_type}'` }] };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc, provider } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        let resolvedIndex = index;
        if (cell_id !== undefined) {
          if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
          resolvedIndex = resolveCellId(cells, cell_id);
        }
        if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

        if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
          throw new Error(`Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`);
        }

        // Check human focus
        if (!force) {
          const focus = checkHumanFocus(provider, doc, resolvedIndex);
          if (focus.blocked) {
            const cellIdStr = truncatedCellId(cells.get(resolvedIndex) as any);
            throw new Error(`Cannot modify cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} — user "${focus.user}" is currently editing it. Use force=true to override.`);
          }
        }

        const cell = cells.get(resolvedIndex) as Y.Map<any>;
        const oldType = cell.get("cell_type") || "code";

        if (oldType === new_type) {
          return {
            content: [
              {
                type: "text",
                text: `Cell ${resolvedIndex} is already type '${new_type}'`,
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
        }

        return {
          content: [
            {
              type: "text",
              text: `Changed cell ${resolvedIndex} from '${oldType}' to '${new_type}'`,
            },
          ],
        };
      }

      case "get_notebook_outline": {
        const { path } = args as { path: string };

        const buildOutline = (cells: any[], getCell: (i: number) => any): any[] => {
          const outline: any[] = [];
          for (let i = 0; i < cells.length; i++) {
            const cell = getCell(i);
            const type = getCellType(cell);
            const source = extractSource(cell);
            const id = truncatedCellId(cell);

            if (type === "markdown") {
              const headers = extractMarkdownHeaders(source);
              for (let h = 0; h < headers.length; h++) {
                const header = headers[h];
                const entry: any = { index: i, id, type: "header", level: header.level, text: header.text };
                if (headers.length > 1) entry.header_num = h + 1;
                outline.push(entry);
              }
            } else if (type === "code") {
              outline.push({ index: i, id, type: "code", preview: getCodePreview(source) });
            }
          }
          return outline;
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          const outline = buildOutline(notebook.cells, (i) => notebook.cells[i]);
          return {
            content: [{ type: "text", text: `Outline of ${path} (${notebook.cells.length} cells):\n\n${JSON.stringify(outline, null, 2)}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");
        const outline = buildOutline(
          Array.from({ length: cells.length }),
          (i) => cells.get(i)
        );

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
        const { path, start_index, end_index, cell_ids, timeout } = args as {
          path: string;
          start_index?: number;
          end_index?: number;
          cell_ids?: string[];
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

        // Resolve which indices to execute
        let indicesToExecute: number[];
        let rangeLabel: string;

        if (cell_ids && cell_ids.length > 0) {
          indicesToExecute = resolveCellIds(cells, cell_ids);
          rangeLabel = `${indicesToExecute.length} cells by ID`;
        } else {
          const startIdx = start_index ?? 0;
          const endIdx = end_index ?? cells.length - 1;
          if (startIdx < 0 || endIdx >= cells.length || startIdx > endIdx) {
            throw new Error(
              `Invalid range [${startIdx}, ${endIdx}]. Notebook has ${cells.length} cells.`
            );
          }
          indicesToExecute = [];
          for (let i = startIdx; i <= endIdx; i++) indicesToExecute.push(i);
          rangeLabel = `cells ${startIdx}-${endIdx}`;
        }

        const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
        const results: { index: number; cellId?: string; status: string; output?: string }[] = [];

        for (const i of indicesToExecute) {
          const cell = cells.get(i) as Y.Map<any>;
          const type = getCellType(cell);
          const cid = truncatedCellId(cell);

          if (type !== "code") {
            results.push({ index: i, cellId: cid, status: "skipped (not code)" });
            continue;
          }

          const source = extractSource(cell);
          if (!source.trim()) {
            results.push({ index: i, cellId: cid, status: "skipped (empty)" });
            continue;
          }

          try {
            const result = await executeCode(session.kernelId, source, timeoutMs);
            updateCellOutputs(cell, result);
            results.push({
              index: i,
              cellId: cid,
              status: result.status,
              output: result.text ? result.text.slice(0, 100) + (result.text.length > 100 ? "..." : "") : undefined,
            });
          } catch (err: any) {
            results.push({ index: i, cellId: cid, status: `error: ${err.message}` });
          }
        }

        const successCount = results.filter((r) => r.status === "ok").length;
        const errorCount = results.filter((r) => r.status === "error" || r.status.startsWith("error:")).length;

        return {
          content: [
            {
              type: "text",
              text: `Executed ${rangeLabel} in ${path}\n${successCount} succeeded, ${errorCount} failed\n\n${JSON.stringify(results, null, 2)}`,
            },
          ],
        };
      }

      case "clear_outputs": {
        const { path, index, cell_id, force = false } = args as {
          path: string;
          index?: number;
          cell_id?: string;
          force?: boolean;
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          let resolvedIndex = index;
          if (cell_id !== undefined) {
            if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
            resolvedIndex = resolveCellId(notebook.cells, cell_id);
          }

          if (resolvedIndex !== undefined) {
            if (resolvedIndex < 0 || resolvedIndex >= notebook.cells.length) {
              throw new Error(`Invalid cell index ${resolvedIndex}. Notebook has ${notebook.cells.length} cells.`);
            }
            const cell = notebook.cells[resolvedIndex];
            cell.outputs = [];
            cell.execution_count = null;
            await writeNotebook(resolved, notebook);
            return { content: [{ type: "text", text: `Cleared outputs from cell ${resolvedIndex} in ${path}` }] };
          } else {
            let clearedCount = 0;
            for (const cell of notebook.cells) {
              if (getCellType(cell) === "code") {
                if (cell.outputs && cell.outputs.length > 0) {
                  clearedCount++;
                }
                cell.outputs = [];
                cell.execution_count = null;
              }
            }
            await writeNotebook(resolved, notebook);
            const message = clearedCount === 0
              ? `No cells had outputs to clear in ${path}`
              : `Cleared outputs from ${clearedCount} cell${clearedCount === 1 ? "" : "s"} in ${path}`;
            return { content: [{ type: "text", text: message }] };
          }
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc, provider } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        let resolvedIndex = index;
        if (cell_id !== undefined) {
          if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
          resolvedIndex = resolveCellId(cells, cell_id);
        }

        if (resolvedIndex !== undefined) {
          // Clear single cell
          if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
            throw new Error(`Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`);
          }

          // Check human focus
          if (!force) {
            const focus = checkHumanFocus(provider, doc, resolvedIndex);
            if (focus.blocked) {
              const cellIdStr = truncatedCellId(cells.get(resolvedIndex) as any);
              throw new Error(`Cannot modify cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} — user "${focus.user}" is currently editing it. Use force=true to override.`);
            }
          }

          const cell = cells.get(resolvedIndex) as Y.Map<any>;
          const outputs = cell.get("outputs");
          if (outputs instanceof Y.Array && outputs.length > 0) {
            outputs.delete(0, outputs.length);
          }
          cell.set("execution_count", null);

          return {
            content: [
              {
                type: "text",
                text: `Cleared outputs from cell ${resolvedIndex} in ${path}`,
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
        const { path, index, end_index, indices, cell_ids, max_images, include_images } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
          cell_ids?: string[];
          max_images?: number;
          include_images?: boolean;
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          const effectiveIndices = cell_ids && cell_ids.length > 0
            ? resolveCellIds(notebook.cells, cell_ids)
            : indices;
          const { indices: cellIndices, description } = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });

          const results: any[] = [];
          for (const idx of cellIndices) {
            const cell = notebook.cells[idx];
            const type = getCellType(cell);

            if (type !== "code") {
              results.push({ index: idx, type, outputs: "(not a code cell)" });
              continue;
            }

            const executionCount = cell.execution_count;
            const outputs = cell.outputs;

            if (!outputs || outputs.length === 0) {
              const status = executionCount === null || executionCount === undefined ? "(not executed)" : "(no output)";
              results.push({ index: idx, type, execution_count: executionCount, outputs: status });
              continue;
            }

            const textParts: string[] = [];
            for (const out of outputs) {
              if (out.output_type === "stream") {
                textParts.push(out.text || "");
              } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
                if (out.data?.["text/plain"]) textParts.push(out.data["text/plain"]);
              } else if (out.output_type === "error") {
                textParts.push(`${out.ename}: ${out.evalue}`);
              }
            }

            results.push({
              index: idx,
              type,
              execution_count: executionCount,
              text: textParts.join(""),
              output_count: outputs.length,
            });
          }

          return {
            content: [{ type: "text", text: `Outputs from ${description} in ${path}:\n\n${JSON.stringify(results, null, 2)}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const effectiveIndicesJup = cell_ids && cell_ids.length > 0
          ? resolveCellIds(cells, cell_ids)
          : indices;
        const { indices: cellIndices, description } = resolveCellIndices(cells.length, {
          index,
          end_index,
          indices: effectiveIndicesJup,
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

        const textContent = `Outputs from ${description} in ${path}:\n\n${JSON.stringify(results, null, 2)}`;
        const effectiveInclude = include_images !== false;
        const effectiveMax = max_images ?? images.length;

        const content: any[] = [{ type: "text", text: textContent }];

        if (effectiveInclude && images.length > 0) {
          if (images.length > effectiveMax) {
            const omitted = images.length - effectiveMax;
            content[0].text += `\n\n(showing last ${effectiveMax} of ${images.length} images — ${omitted} omitted, use max_images to adjust)`;
            for (const img of images.slice(-effectiveMax)) {
              content.push({ type: "image", data: img.data, mimeType: img.mimeType });
            }
          } else {
            for (const img of images) {
              content.push({ type: "image", data: img.data, mimeType: img.mimeType });
            }
          }
        } else if (images.length > 0) {
          content[0].text += `\n\n(${images.length} image${images.length === 1 ? "" : "s"} not shown — set include_images=true or increase max_images to see them)`;
        }

        return { content };
      }

      case "get_cell_metadata": {
        const { path, index, end_index, indices, cell_ids } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
          cell_ids?: string[];
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          const effectiveIndices = cell_ids && cell_ids.length > 0
            ? resolveCellIds(notebook.cells, cell_ids)
            : indices;
          const resolved2 = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });
          const results: any[] = [];
          for (const i of resolved2.indices) {
            const metadataJson = notebook.cells[i].metadata || {};
            results.push({ index: i, metadata: metadataJson, tags: metadataJson.tags || [] });
          }

          return {
            content: [{
              type: "text",
              text: results.length === 1
                ? `Cell ${resolved2.indices[0]} metadata:\n${JSON.stringify(results[0].metadata, null, 2)}`
                : `Metadata for ${resolved2.description}:\n${JSON.stringify(results, null, 2)}`,
            }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const effectiveIndicesJup = cell_ids && cell_ids.length > 0
          ? resolveCellIds(cells, cell_ids)
          : indices;
        const resolved = resolveCellIndices(cells.length, { index, end_index, indices: effectiveIndicesJup });

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
        const { path, index, end_index, indices, cell_ids, metadata } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
          cell_ids?: string[];
          metadata: Record<string, any>;
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          const effectiveIndices = cell_ids && cell_ids.length > 0
            ? resolveCellIds(notebook.cells, cell_ids)
            : indices;
          const resolvedIndices = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });

          for (const i of resolvedIndices.indices) {
            const cell = notebook.cells[i];
            if (!cell.metadata) cell.metadata = {};

            for (const [key, value] of Object.entries(metadata)) {
              if (value === null) {
                delete cell.metadata[key];
              } else {
                cell.metadata[key] = value;
              }
            }
          }

          await writeNotebook(resolved, notebook);
          return { content: [{ type: "text", text: `Updated metadata on ${resolvedIndices.description}` }] };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const effectiveIndicesJup = cell_ids && cell_ids.length > 0
          ? resolveCellIds(cells, cell_ids)
          : indices;
        const resolved = resolveCellIndices(cells.length, { index, end_index, indices: effectiveIndicesJup });

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
        const { path, index, end_index, indices, cell_ids, tags } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
          cell_ids?: string[];
          tags: string[];
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          const effectiveIndices = cell_ids && cell_ids.length > 0
            ? resolveCellIds(notebook.cells, cell_ids)
            : indices;
          const resolvedIndices = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });

          for (const i of resolvedIndices.indices) {
            const cell = notebook.cells[i];
            if (!cell.metadata) cell.metadata = {};
            if (!Array.isArray(cell.metadata.tags)) cell.metadata.tags = [];
            for (const tag of tags) {
              if (!cell.metadata.tags.includes(tag)) {
                cell.metadata.tags.push(tag);
              }
            }
          }

          await writeNotebook(resolved, notebook);
          return { content: [{ type: "text", text: `Added tags [${tags.join(", ")}] to ${resolvedIndices.description}` }] };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const effectiveIndicesJup = cell_ids && cell_ids.length > 0
          ? resolveCellIds(cells, cell_ids)
          : indices;
        const resolved = resolveCellIndices(cells.length, { index, end_index, indices: effectiveIndicesJup });

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
        const { path, index, end_index, indices, cell_ids, tags } = args as {
          path: string;
          index?: number;
          end_index?: number;
          indices?: number[];
          cell_ids?: string[];
          tags: string[];
        };

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          const effectiveIndices = cell_ids && cell_ids.length > 0
            ? resolveCellIds(notebook.cells, cell_ids)
            : indices;
          const resolvedIndices = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });

          for (const i of resolvedIndices.indices) {
            const cell = notebook.cells[i];
            if (!cell.metadata?.tags || !Array.isArray(cell.metadata.tags)) continue;
            cell.metadata.tags = cell.metadata.tags.filter((t: string) => !tags.includes(t));
          }

          await writeNotebook(resolved, notebook);
          return { content: [{ type: "text", text: `Removed tags [${tags.join(", ")}] from ${resolvedIndices.description}` }] };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const effectiveIndicesJup = cell_ids && cell_ids.length > 0
          ? resolveCellIds(cells, cell_ids)
          : indices;
        const resolved = resolveCellIndices(cells.length, { index, end_index, indices: effectiveIndicesJup });

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

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          const matches: any[] = [];
          for (let i = 0; i < notebook.cells.length; i++) {
            const cell = notebook.cells[i];
            const type = getCellType(cell);
            const cellTags: string[] = Array.isArray(cell.metadata?.tags) ? cell.metadata.tags : [];
            if (cellTags.length === 0) continue;

            const hasMatch = match_all
              ? tags.every((t) => cellTags.includes(t))
              : tags.some((t) => cellTags.includes(t));

            if (hasMatch) {
              const result: any = { index: i, id: truncatedCellId(cell), type, tags: cellTags };
              if (include_preview) result.preview = getCodePreview(extractSource(cell));
              matches.push(result);
            }
          }

          return {
            content: [{ type: "text", text: `Found ${matches.length} cells with tag(s) [${tags.join(", ")}]${match_all ? " (match all)" : ""}:\n\n${JSON.stringify(matches, null, 2)}` }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);

        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const matches: any[] = [];

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
            const result: any = {
              index: i,
              id: truncatedCellId(cell),
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

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          return {
            content: [{ type: "text", text: `Notebook metadata for ${path}:\n${JSON.stringify(notebook.metadata, null, 2)}` }],
          };
        }

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

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          for (const [key, value] of Object.entries(metadata)) {
            if (value === null) {
              delete notebook.metadata[key];
            } else {
              notebook.metadata[key] = value;
            }
          }

          await writeNotebook(resolved, notebook);
          return { content: [{ type: "text", text: `Updated notebook metadata for ${path}` }] };
        }

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

        if (!isJupyterConnected()) {
          const resolvedOld = resolveNotebookPath(path);
          const resolvedNew = resolveNotebookPath(new_path);
          await fsRename(resolvedOld, resolvedNew);
          return { content: [{ type: "text", text: `Renamed ${path} to ${new_path}` }] };
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

        if (!isJupyterConnected()) {
          const resolved1 = resolveNotebookPath(path1);
          const resolved2 = resolveNotebookPath(path2);
          const nb1 = await readNotebook(resolved1);
          const nb2 = await readNotebook(resolved2);

          const diffs: string[] = [];
          let sourceDiffs = 0, typeDiffs = 0, outputDiffs = 0, onlyIn1 = 0, onlyIn2 = 0;

          const maxCells = Math.max(nb1.cells.length, nb2.cells.length);
          for (let i = 0; i < maxCells; i++) {
            const cell1 = i < nb1.cells.length ? nb1.cells[i] : null;
            const cell2 = i < nb2.cells.length ? nb2.cells[i] : null;

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
              const out1 = JSON.stringify(cell1.outputs || []);
              const out2 = JSON.stringify(cell2.outputs || []);
              if (out1 !== out2) {
                outputDiffs++;
                if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
                  diffs.push(`[${i}] Outputs differ`);
                }
              }
            }
          }

          const totalDiffs = sourceDiffs + typeDiffs + outputDiffs + onlyIn1 + onlyIn2;
          const diffSummary = `Summary: ${totalDiffs} differences (${sourceDiffs} source, ${typeDiffs} type, ${outputDiffs} output, ${onlyIn1} only in ${path1}, ${onlyIn2} only in ${path2})`;

          let resultText: string;
          if (totalDiffs === 0) {
            resultText = `Notebooks ${path1} and ${path2} are identical`;
          } else if (summary_only) {
            resultText = diffSummary;
          } else {
            const shownDiffs = max_diffs && diffs.length >= max_diffs ? `\n\n(showing first ${max_diffs} of ${totalDiffs} differences)` : "";
            resultText = `${diffSummary}\n\n${diffs.join("\n\n")}${shownDiffs}`;
          }

          return { content: [{ type: "text", text: resultText }] };
        }

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
        const { path, cell_index, cell_id } = args as {
          path: string;
          cell_index?: number;
          cell_id?: string;
        };

        // Helper to collect sources from cells
        let cellSources: { index: number; source: string }[];
        let sessionForKernel: NotebookSession | undefined;

        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);

          let resolvedCellIndex = cell_index;
          if (cell_id !== undefined) {
            if (cell_index !== undefined) throw new Error("Specify either 'cell_index' or 'cell_id', not both.");
            resolvedCellIndex = resolveCellId(notebook.cells, cell_id);
          }

          if (resolvedCellIndex !== undefined) {
            if (resolvedCellIndex < 0 || resolvedCellIndex >= notebook.cells.length) {
              throw new Error(`Invalid cell index ${resolvedCellIndex}. Notebook has ${notebook.cells.length} cells.`);
            }
            cellSources = [{ index: resolvedCellIndex, source: extractSource(notebook.cells[resolvedCellIndex]) }];
          } else {
            cellSources = [];
            for (let i = 0; i < notebook.cells.length; i++) {
              if (getCellType(notebook.cells[i]) === "code") {
                cellSources.push({ index: i, source: extractSource(notebook.cells[i]) });
              }
            }
          }
        } else {
          const sessions = await listNotebookSessions();
          sessionForKernel = sessions.find((s) => s.path === path);

          const { doc } = await connectToNotebook(path, sessionForKernel?.kernelId);
          const cells = doc.getArray("cells");

          let resolvedCellIndex = cell_index;
          if (cell_id !== undefined) {
            if (cell_index !== undefined) throw new Error("Specify either 'cell_index' or 'cell_id', not both.");
            resolvedCellIndex = resolveCellId(cells, cell_id);
          }

          if (resolvedCellIndex !== undefined) {
            if (resolvedCellIndex < 0 || resolvedCellIndex >= cells.length) {
              throw new Error(`Invalid cell index ${resolvedCellIndex}. Notebook has ${cells.length} cells.`);
            }
            cellSources = [{ index: resolvedCellIndex, source: extractSource(cells.get(resolvedCellIndex) as any) }];
          } else {
            cellSources = [];
            for (let i = 0; i < cells.length; i++) {
              const cell = cells.get(i) as Y.Map<any>;
              if (getCellType(cell) === "code") {
                cellSources.push({ index: i, source: extractSource(cell) });
              }
            }
          }

          // Try LSP first if available
          const languageServer = getLanguageServerForFile(path);
          if (lspStatus.available && languageServer) {
            // Fall through to syntax check for now
          }
        }

        const indicesToCheck = cellSources.map((c) => c.index);

        // Use ruff via uvx for fast, comprehensive diagnostics (no kernel needed)
        const diagnostics: { cell: number; line: number; column?: number; code: string; message: string; severity: string }[] = [];
        let diagnosticMethod: "ruff" | "syntax" | "none" = "none";

        for (const { index: idx, source } of cellSources) {
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
              if (sessionForKernel?.kernelId) {
                const checkCode = `
try:
    compile(${JSON.stringify(source)}, '<cell ${idx}>', 'exec')
    print("OK")
except SyntaxError as e:
    print(f"SYNTAX:{e.lineno or 1}:{e.msg}")
`;
                try {
                  const kernelResult = await executeCode(sessionForKernel.kernelId, checkCode, 5000);
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

      // ================================================================
      // Change tracking tools
      // ================================================================

      case "get_cell_history": {
        const { path, cell_id, limit = 20 } = args as {
          path: string;
          cell_id: string;
          limit?: number;
        };

        const history = getCellHistory(path, cell_id, limit);
        if (history.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No change history found for cell '${cell_id}' in ${path}. History is only tracked during this session.`,
            }],
          };
        }

        const lines = history.map((c) => {
          const time = new Date(c.timestamp).toLocaleTimeString();
          let desc = `[v${c.version} ${time}] **${c.operation}** cell ${c.cellIndex} (${c.cellIdShort})`;
          if (c.client) desc += ` by ${c.client}`;
          if (c.detail) desc += ` — ${c.detail}`;
          if (c.operation === "update" && c.oldSource !== undefined) {
            const oldLines = c.oldSource.split("\n").length;
            const newLines = (c.newSource || "").split("\n").length;
            desc += ` (${oldLines} → ${newLines} lines)`;
          }
          return desc;
        });

        return {
          content: [{
            type: "text",
            text: `Change history for cell '${cell_id}' in ${path} (${history.length} entries):\n\n${lines.join("\n")}`,
          }],
        };
      }

      case "get_notebook_changes": {
        const { path, since_version = 0, limit = 50 } = args as {
          path: string;
          since_version?: number;
          limit?: number;
        };

        const { changes, currentVersion } = getChangesSince(path, since_version, limit);

        if (changes.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No changes since version ${since_version} in ${path}. Current version: ${currentVersion}`,
            }],
          };
        }

        const lines = changes.map((c) => {
          const time = new Date(c.timestamp).toLocaleTimeString();
          let desc = `v${c.version} [${time}] ${c.operation} cell ${c.cellIndex} (${c.cellIdShort})`;
          if (c.client) desc += ` by ${c.client}`;
          if (c.detail) desc += ` — ${c.detail}`;
          return desc;
        });

        return {
          content: [{
            type: "text",
            text: `Changes in ${path} since v${since_version} (${changes.length} changes, now at v${currentVersion}):\n\n${lines.join("\n")}`,
          }],
        };
      }

      case "recover_cell": {
        const { path, cell_id, index: insertAt } = args as {
          path: string;
          cell_id: string;
          index?: number;
        };

        const deleted = getDeletedCellSource(path, cell_id);
        if (!deleted) {
          return {
            content: [{
              type: "text",
              text: `No deleted cell matching '${cell_id}' found in change history for ${path}. History is only tracked during this session.`,
            }],
            isError: true,
          };
        }

        // Re-insert the recovered cell using the same logic as insert_cell
        if (!isJupyterConnected()) {
          const resolved = resolveNotebookPath(path);
          const notebook = await readNotebook(resolved);
          const cells = notebook.cells;

          const newCell: NotebookCell = {
            cell_type: "code",
            source: deleted.source,
            metadata: {},
            id: crypto.randomUUID(),
            outputs: [],
            execution_count: null,
          };

          const idx = insertAt ?? cells.length;
          cells.splice(idx, 0, newCell);
          await writeNotebook(resolved, notebook);

          const newId = (newCell.id || "").slice(0, 8);
          recordChange(path, {
            operation: "restore",
            cellId: newCell.id || "",
            cellIdShort: newId,
            cellIndex: idx,
            newSource: deleted.source,
            detail: `recovered from deleted cell ${cell_id}`,
            client: "claude-code",
          });

          return {
            content: [{
              type: "text",
              text: `Recovered deleted cell '${cell_id}' (deleted at ${deleted.deletedAt}) → inserted as cell ${idx} (id: ${newId}) in ${path}\n\nRecovered ${deleted.source.split("\n").length} lines of source.`,
            }],
          };
        }

        const sessions = await listNotebookSessions();
        const session = sessions.find((s) => s.path === path);
        const { doc } = await connectToNotebook(path, session?.kernelId);
        const cells = doc.getArray("cells");

        const newCell = new Y.Map();
        newCell.set("cell_type", "code");
        newCell.set("source", new Y.Text(deleted.source));
        newCell.set("metadata", new Y.Map());
        newCell.set("outputs", new Y.Array());
        newCell.set("execution_count", null);
        const newCellId = crypto.randomUUID();
        newCell.set("id", newCellId);

        const idx = insertAt ?? cells.length;
        cells.insert(idx, [newCell]);

        const newId = newCellId.slice(0, 8);
        recordChange(path, {
          operation: "restore",
          cellId: newCellId,
          cellIdShort: newId,
          cellIndex: idx,
          newSource: deleted.source,
          detail: `recovered from deleted cell ${cell_id}`,
          client: "claude-code",
        });

        return {
          content: [{
            type: "text",
            text: `Recovered deleted cell '${cell_id}' (deleted at ${deleted.deletedAt}) → inserted as cell ${idx} (id: ${newId}) in ${path}\n\nRecovered ${deleted.source.split("\n").length} lines of source.`,
          }],
        };
      }

      // ================================================================
      // Snapshot tools
      // ================================================================

      case "snapshot_notebook": {
        const { path, name: snapName, description: snapDesc } = args as {
          path: string;
          name: string;
          description?: string;
        };

        const { cells } = await getNotebookCells(path);
        const snapshot = createSnapshot(path, snapName, cells, snapDesc);

        return {
          content: [{
            type: "text",
            text: `Snapshot '${snapName}' saved for ${path} (${snapshot.cells.length} cells captured at ${snapshot.createdAt})${snapDesc ? `\nDescription: ${snapDesc}` : ""}`,
          }],
        };
      }

      case "restore_snapshot": {
        const { path, name: snapName } = args as {
          path: string;
          name: string;
        };

        const snapshot = getSnapshot(path, snapName);
        if (!snapshot) {
          throw new Error(`No snapshot named '${snapName}' found for ${path}. Use list_snapshots to see available snapshots.`);
        }

        // Auto-save a pre-restore snapshot for safety
        const { cells, mode, notebook, doc } = await getNotebookCells(path);
        createSnapshot(path, `pre-restore-${Date.now()}`, cells, `Auto-saved before restoring '${snapName}'`);

        if (mode === "jupyter" && doc) {
          const yCells = doc.getArray("cells");
          const restored = restoreSnapshotToYjs(snapshot, yCells, doc);

          recordChange(path, {
            operation: "restore",
            cellId: "",
            cellIdShort: "",
            cellIndex: -1,
            detail: `restored snapshot '${snapName}' (${restored} cells)`,
            client: "claude-code",
          });

          return {
            content: [{
              type: "text",
              text: `Restored snapshot '${snapName}' to ${path} (${restored} cells). A pre-restore snapshot was auto-saved.`,
            }],
          };
        } else if (notebook) {
          const newCells = restoreSnapshotToFs(snapshot);
          notebook.cells = newCells;
          const resolved = resolveNotebookPath(path);
          await writeNotebook(resolved, notebook);

          return {
            content: [{
              type: "text",
              text: `Restored snapshot '${snapName}' to ${path} (${newCells.length} cells). A pre-restore snapshot was auto-saved.`,
            }],
          };
        }

        throw new Error("Could not restore snapshot — notebook access failed.");
      }

      case "list_snapshots": {
        const { path } = args as { path: string };

        const snaps = listSnapshotsForPath(path);
        if (snaps.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No snapshots saved for ${path}. Use snapshot_notebook to create one.`,
            }],
          };
        }

        const lines = snaps.map((s) => {
          const time = new Date(s.createdAt).toLocaleTimeString();
          let line = `- **${s.name}** (${s.cells.length} cells, ${time})`;
          if (s.description) line += ` — ${s.description}`;
          return line;
        });

        return {
          content: [{
            type: "text",
            text: `Snapshots for ${path} (${snaps.length}):\n\n${lines.join("\n")}`,
          }],
        };
      }

      case "diff_snapshot": {
        const { path, name: snapName } = args as {
          path: string;
          name: string;
        };

        const snapshot = getSnapshot(path, snapName);
        if (!snapshot) {
          throw new Error(`No snapshot named '${snapName}' found for ${path}.`);
        }

        const { cells } = await getNotebookCells(path);
        const result = diffSnapshot(snapshot, cells);

        const summary = `Diff: snapshot '${snapName}' vs current ${path}:\n` +
          `  Added: ${result.added}, Deleted: ${result.deleted}, Modified: ${result.modified}, Unchanged: ${result.unchanged}`;

        const detailLines: string[] = [];
        for (const d of result.details) {
          if (d.status === "unchanged") continue;
          const prefix = d.status === "added" ? "+" : d.status === "deleted" ? "-" : "~";
          let line = `  ${prefix} ${d.cellId} (${d.status})`;

          if (d.status === "modified" && d.oldSource !== undefined && d.newSource !== undefined) {
            const oldLines = d.oldSource.split("\n").length;
            const newLines = d.newSource.split("\n").length;
            line += ` [${oldLines} → ${newLines} lines]`;
            // Show compact diff preview (first change)
            const diff = generateUnifiedDiff(d.oldSource, d.newSource, d.cellId);
            const diffLines = diff.split("\n").filter(l => l.startsWith("+") || l.startsWith("-")).slice(0, 6);
            if (diffLines.length > 0) {
              line += "\n" + diffLines.map(l => `      ${l}`).join("\n");
            }
          } else if (d.status === "deleted" && d.oldSource) {
            line += ` [${d.oldSource.split("\n").length} lines removed]`;
          } else if (d.status === "added" && d.newSource) {
            line += ` [${d.newSource.split("\n").length} lines added]`;
          }

          detailLines.push(line);
        }

        const details = detailLines.join("\n");
        return {
          content: [{
            type: "text",
            text: summary + (details ? `\n\n${details}` : "\n\n(no differences)"),
          }],
        };
      }

      // ================================================================
      // Cell locking tools
      // ================================================================

      case "lock_cells": {
        const { path, cell_ids: lockCellIds, owner = "claude-code", ttl_minutes = 5 } = args as {
          path: string;
          cell_ids: string[];
          owner?: string;
          ttl_minutes?: number;
        };

        // Resolve cell_id prefixes to full IDs
        const { cells } = await getNotebookCells(path);
        const fullIds: string[] = [];
        for (const prefix of lockCellIds) {
          const idx = resolveCellId(cells, prefix);
          const cell = cells instanceof Array ? cells[idx] : (cells as any).get(idx);
          const fullId = getCellId(cell);
          if (fullId) fullIds.push(fullId);
        }

        const ttlMs = ttl_minutes * 60 * 1000;
        const result = acquireLocks(path, fullIds, owner, ttlMs);

        const lines: string[] = [];
        if (result.acquired.length > 0) {
          lines.push(`Locked ${result.acquired.length} cell(s) for "${owner}" (expires in ${ttl_minutes} min):`);
          for (const lock of result.acquired) {
            lines.push(`  ${lock.cellId.slice(0, 8)} — locked until ${new Date(lock.expiresAt).toLocaleTimeString()}`);
          }
        }
        if (result.blocked.length > 0) {
          lines.push(`\nBlocked ${result.blocked.length} cell(s) — already locked:`);
          for (const b of result.blocked) {
            lines.push(`  ${b.cellId.slice(0, 8)} — held by "${b.owner}"`);
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") || "No cells to lock." }],
        };
      }

      case "unlock_cells": {
        const { path, cell_ids: unlockCellIds, owner = "claude-code", force = false } = args as {
          path: string;
          cell_ids: string[];
          owner?: string;
          force?: boolean;
        };

        // Resolve cell_id prefixes to full IDs
        const { cells } = await getNotebookCells(path);
        const fullIds: string[] = [];
        for (const prefix of unlockCellIds) {
          try {
            const idx = resolveCellId(cells, prefix);
            const cell = cells instanceof Array ? cells[idx] : (cells as any).get(idx);
            const fullId = getCellId(cell);
            if (fullId) fullIds.push(fullId);
          } catch {
            // Cell may have been deleted — try the prefix as-is
            fullIds.push(prefix);
          }
        }

        const result = releaseLocks(path, fullIds, owner, force);

        const lines: string[] = [];
        if (result.released.length > 0) {
          lines.push(`Unlocked ${result.released.length} cell(s):`);
          for (const id of result.released) lines.push(`  ${id.slice(0, 8)}`);
        }
        if (result.notOwned.length > 0) {
          lines.push(`\n${result.notOwned.length} cell(s) owned by someone else (use force=true):`);
          for (const id of result.notOwned) lines.push(`  ${id.slice(0, 8)}`);
        }
        if (result.notFound.length > 0) {
          lines.push(`\n${result.notFound.length} cell(s) had no lock:`);
          for (const id of result.notFound) lines.push(`  ${id.slice(0, 8)}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") || "No cells to unlock." }],
        };
      }

      case "list_locks": {
        const { path } = args as { path: string };

        const activeLocks = listLocksForPath(path);

        if (activeLocks.length === 0) {
          return {
            content: [{ type: "text", text: `No active locks on ${path}.` }],
          };
        }

        const lines = [`${activeLocks.length} active lock(s) on ${path}:\n`];
        for (const lock of activeLocks) {
          const remaining = Math.round((new Date(lock.expiresAt).getTime() - Date.now()) / 1000);
          lines.push(`  ${lock.cellId.slice(0, 8)} — owner: "${lock.owner}", expires in ${remaining}s`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
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
