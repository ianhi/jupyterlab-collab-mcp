import type { ToolResult } from "../handler-types.js";
import * as Y from "yjs";
import {
  extractSource,
  getCellType,
  getCellId,
  resolveCellId,
  resolveCellIds,
  truncatedCellId,
  generateUnifiedDiff,
  truncateDiff,
  getCodePreview,
  checkHumanFocus,
  formatTimeRemaining,
  updateCellOutputs,
  buildExecutionContent,
} from "../helpers.js";
import {
  readNotebook,
  writeNotebook,
  resolveNotebookPath,
  type NotebookCell,
} from "../notebook-fs.js";
import {
  isJupyterConnected,
  listNotebookSessions,
  connectToNotebook,
  executeCode,
  cacheExecution,
} from "../connection.js";
import { recordChange } from "../cell-tracker.js";
import { checkLock } from "../cell-locks.js";

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  "insert_cell": async (args) => {
    const { path, index, cell_id, source, cell_type = "code", execute, timeout, max_images, include_images, client_name } = args as {
      path: string;
      index?: number;
      cell_id?: string;
      source: string;
      cell_type?: string;
      execute?: boolean;
      timeout?: number;
      max_images?: number;
      include_images?: boolean;
      client_name?: string;
    };
    const clientId = client_name || "claude-code";

    if (!isJupyterConnected()) {
      if (execute) {
        throw new Error("execute=true requires JupyterLab connection. Use connect_jupyter first.");
      }
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
      return {
        content: [{ type: "text", text: `Inserted ${cell_type} cell at index ${insertIndex} (id: ${newId}) in ${path}` }],
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
    }, doc);

    const newId = newCellId.slice(0, 8);

    if (execute) {
      if (!session?.kernelId) {
        throw new Error(
          `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
        );
      }
      const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
      const result = await executeCode(session.kernelId, source, timeoutMs);
      updateCellOutputs(newCell, result);
      const executionId = cacheExecution(path, { text: result.text, images: result.images, cellIndex: insertIndex, cellId: newCellId });
      const content = buildExecutionContent(result, `Inserted and executed cell at index ${insertIndex} (id: ${newId}) in ${path}\n\nOutput:\n`, { max_images, include_images });
      content[0].text += `\n(execution_id: ${executionId} — use filter_output to refine)`;
      return { content };
    }

    return {
      content: [
        {
          type: "text",
          text: `Inserted ${cell_type} cell at index ${insertIndex} (id: ${newId}) in ${path}`,
        },
      ],
    };
  },

  "update_cell": async (args) => {
    const { path, index, cell_id, source, force = false, execute, timeout, max_images, include_images, show_diff = false, client_name } = args as {
      path: string;
      index?: number;
      cell_id?: string;
      source: string;
      force?: boolean;
      execute?: boolean;
      timeout?: number;
      max_images?: number;
      include_images?: boolean;
      show_diff?: boolean;
      client_name?: string;
    };
    const clientId = client_name || "claude-code";

    if (!isJupyterConnected()) {
      if (execute) {
        throw new Error("execute=true requires JupyterLab connection. Use connect_jupyter first.");
      }
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
      const lock = checkLock(path, fullCellId, clientId, doc);
      if (lock) {
        if (!force) {
          const cellIdStr = truncatedCellId(cell);
          throw new Error(`Cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} is locked by "${lock.owner}" (expires in ${formatTimeRemaining(Math.round((new Date(lock.expiresAt).getTime() - Date.now()) / 1000))}). Use force=true to override.`);
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
    }, doc);

    if (execute) {
      if (!session?.kernelId) {
        throw new Error(
          `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
        );
      }
      const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
      const result = await executeCode(session.kernelId, source, timeoutMs);
      if (cell instanceof Y.Map) {
        updateCellOutputs(cell, result);
      }

      const fullCellIdStr = getCellId(cell);
      let prefix = `Updated and executed cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} in ${path}`;
      if (show_diff) {
        const diff = generateUnifiedDiff(oldSource, source, `${path}:cell[${resolvedIndex}]`);
        prefix += `\n\n${truncateDiff(diff)}`;
      }
      prefix += "\n\nOutput:\n";

      const executionId = cacheExecution(path, { text: result.text, images: result.images, cellIndex: resolvedIndex, cellId: fullCellIdStr });
      const content = buildExecutionContent(result, prefix, { max_images, include_images });
      content[0].text += `\n(execution_id: ${executionId} — use filter_output to refine)`;
      return { content };
    }

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
  },

  "batch_update_cells": async (args) => {
    const { path, updates, client_name } = args as {
      path: string;
      updates: { index: number; source: string }[];
      client_name?: string;
    };
    const clientId = client_name || "claude-code";

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
        const cell = notebook.cells[update.index];
        const oldSource = extractSource(cell);
        cell.source = update.source;

        const cellIdStr = truncatedCellId(cell);
        recordChange(path, {
          operation: "update",
          cellId: getCellId(cell) || "",
          cellIdShort: cellIdStr || "",
          cellIndex: update.index,
          oldSource,
          newSource: update.source,
          client: clientId,
        });

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
    const changeRecords: { cellId: string; cellIdShort: string; index: number; oldSource: string; newSource: string }[] = [];

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

        changeRecords.push({
          cellId: getCellId(cell) || "",
          cellIdShort: truncatedCellId(cell) || "",
          index: update.index,
          oldSource,
          newSource: update.source,
        });

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

    // Record changes after transaction completes
    for (const rec of changeRecords) {
      recordChange(path, {
        operation: "update",
        cellId: rec.cellId,
        cellIdShort: rec.cellIdShort,
        cellIndex: rec.index,
        oldSource: rec.oldSource,
        newSource: rec.newSource,
        client: clientId,
      }, doc);
    }

    return {
      content: [
        {
          type: "text",
          text: `Updated ${updates.length} cells in ${path}\n\n${diffs.join("\n\n")}`,
        },
      ],
    };
  },

  "batch_insert_cells": async (args) => {
    const { path, inserts, client_name } = args as {
      path: string;
      inserts: { source: string; cell_type?: string; cell_id?: string; index?: number }[];
      client_name?: string;
    };
    const clientId = client_name || "claude-code";

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);
      const cells = notebook.cells;

      const results: string[] = [];
      let offset = 0;

      for (const ins of inserts) {
        const cellType = ins.cell_type || "code";
        const newCell: NotebookCell = {
          cell_type: cellType,
          source: ins.source,
          metadata: {},
          id: crypto.randomUUID(),
          ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
        };

        // Resolve insert position
        let insertIndex: number;
        if (ins.cell_id !== undefined) {
          if (ins.index !== undefined) throw new Error("Specify either 'index' or 'cell_id' per insert, not both.");
          insertIndex = resolveCellId(cells, ins.cell_id) + 1; // insert after
        } else if (ins.index === undefined || ins.index === -1) {
          insertIndex = cells.length;
        } else {
          insertIndex = ins.index + offset;
        }

        if (insertIndex < 0 || insertIndex > cells.length) {
          throw new Error(`Invalid index ${insertIndex}. Notebook has ${cells.length} cells.`);
        }

        cells.splice(insertIndex, 0, newCell);
        offset++;

        const newId = (newCell.id || "").slice(0, 8);
        recordChange(path, {
          operation: "insert",
          cellId: newCell.id || "",
          cellIdShort: newId,
          cellIndex: insertIndex,
          newSource: ins.source,
          client: clientId,
        });

        results.push(`  [${insertIndex}] ${newId} (${cellType})`);
      }

      await writeNotebook(resolved, notebook);

      return {
        content: [{ type: "text", text: `Inserted ${inserts.length} cells in ${path}\n${results.join("\n")}` }],
      };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    const results: string[] = [];
    let offset = 0;

    for (const ins of inserts) {
      const cellType = ins.cell_type || "code";
      const newCell = new Y.Map();
      newCell.set("cell_type", cellType);
      newCell.set("source", new Y.Text(ins.source));
      newCell.set("metadata", new Y.Map());
      if (cellType === "code") {
        newCell.set("outputs", new Y.Array());
        newCell.set("execution_count", null);
      }
      const newCellId = crypto.randomUUID();
      newCell.set("id", newCellId);

      // Resolve insert position
      let insertIndex: number;
      if (ins.cell_id !== undefined) {
        if (ins.index !== undefined) throw new Error("Specify either 'index' or 'cell_id' per insert, not both.");
        insertIndex = resolveCellId(cells, ins.cell_id) + 1; // insert after
      } else if (ins.index === undefined || ins.index === -1) {
        insertIndex = cells.length;
      } else {
        insertIndex = ins.index + offset;
      }

      if (insertIndex < 0 || insertIndex > cells.length) {
        throw new Error(`Invalid index ${insertIndex}. Notebook has ${cells.length} cells.`);
      }

      cells.insert(insertIndex, [newCell]);
      offset++;

      const newId = newCellId.slice(0, 8);
      recordChange(path, {
        operation: "insert",
        cellId: newCellId,
        cellIdShort: newId,
        cellIndex: insertIndex,
        newSource: ins.source,
        client: clientId,
      }, doc);

      results.push(`  [${insertIndex}] ${newId} (${cellType})`);
    }

    return {
      content: [
        {
          type: "text",
          text: `Inserted ${inserts.length} cells in ${path}\n${results.join("\n")}`,
        },
      ],
    };
  },

  "delete_cell": async (args) => {
    const { path, index, cell_id, indices, cell_ids, start_index, end_index, force = false, client_name } = args as {
      path: string;
      index?: number;
      cell_id?: string;
      indices?: number[];
      cell_ids?: string[];
      start_index?: number;
      end_index?: number;
      force?: boolean;
      client_name?: string;
    };
    const clientId = client_name || "claude-code";

    // Determine if this is a batch delete (indices, cell_ids, or start_index+end_index)
    const isBatch = (indices && indices.length > 0) || (cell_ids && cell_ids.length > 0) || (start_index !== undefined && end_index !== undefined);

    if (isBatch) {
      // --- Batch delete logic ---
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

    // --- Single cell delete logic ---
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
      const lock = checkLock(path, fullCellId, clientId, doc);
      if (lock) {
        if (!force) {
          const cellIdStr = truncatedCellId(cell);
          throw new Error(`Cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} is locked by "${lock.owner}" (expires in ${formatTimeRemaining(Math.round((new Date(lock.expiresAt).getTime() - Date.now()) / 1000))}). Use force=true to override.`);
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
    }, doc);

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
  },

  "change_cell_type": async (args) => {
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
  },

  "copy_cells": async (args) => {
    const { source_path, dest_path, start_index, end_index, cell_ids: copyCellIds, dest_index, dest_cell_id, delete_source = false, client_name } = args as {
      source_path: string;
      dest_path: string;
      start_index?: number;
      end_index?: number;
      cell_ids?: string[];
      dest_index?: number;
      dest_cell_id?: string;
      delete_source?: boolean;
      client_name?: string;
    };
    const clientId = client_name || "claude-code";
    const operation = delete_source ? "move" : "copy";
    const operationPast = delete_source ? "Moved" : "Copied";

    if (!isJupyterConnected()) {
      const resolvedSrc = resolveNotebookPath(source_path);
      const resolvedDest = resolveNotebookPath(dest_path);
      const srcNb = await readNotebook(resolvedSrc);
      const sameNotebook = resolvedSrc === resolvedDest;
      const destNb = sameNotebook ? srcNb : await readNotebook(resolvedDest);

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

      // If delete_source (move), delete source cells and adjust destination
      let adjustedInsertAt = insertAt;
      if (delete_source) {
        // Delete from source (reverse order to preserve indices)
        for (let i = sourceIndices.length - 1; i >= 0; i--) {
          srcNb.cells.splice(sourceIndices[i], 1);
        }
        // Adjust dest for same-notebook case
        if (sameNotebook) {
          const deletedBefore = sourceIndices.filter((i) => i < insertAt).length;
          adjustedInsertAt = Math.max(0, insertAt - deletedBefore);
        }
      }

      destNb.cells.splice(adjustedInsertAt, 0, ...copiedCells);

      if (delete_source) {
        await writeNotebook(resolvedSrc, srcNb);
        if (!sameNotebook) await writeNotebook(resolvedDest, destNb);
      } else {
        await writeNotebook(resolvedDest, destNb);
      }

      // Track each cell in change history
      for (let i = 0; i < copiedCells.length; i++) {
        const cell = copiedCells[i];
        const cellSource = typeof cell.source === "string" ? cell.source : "";
        const cellId = cell.id || "";
        if (delete_source) {
          recordChange(source_path, {
            operation: "move",
            cellId,
            cellIdShort: cellId.slice(0, 8),
            cellIndex: sourceIndices[i],
            oldSource: cellSource,
            client: clientId,
            detail: `moved to ${dest_path} index ${adjustedInsertAt + i}`,
          });
          recordChange(dest_path, {
            operation: "move",
            cellId,
            cellIdShort: cellId.slice(0, 8),
            cellIndex: adjustedInsertAt + i,
            newSource: cellSource,
            client: clientId,
            detail: `moved from ${source_path}`,
          });
        } else {
          recordChange(dest_path, {
            operation: "copy",
            cellId,
            cellIdShort: cellId.slice(0, 8),
            cellIndex: adjustedInsertAt + i,
            newSource: cellSource,
            client: clientId,
            detail: `copied from ${source_path}`,
          });
        }
      }

      const cellSummaries = copiedCells.map((cell, i) => {
        const newId = (cell.id || "").slice(0, 8);
        const preview = getCodePreview(typeof cell.source === "string" ? cell.source : "", 50);
        return `  [${adjustedInsertAt + i}] (${newId}) ${cell.cell_type}: ${preview}`;
      });

      const rangeLabel = copyCellIds ? `${copyCellIds.length} cells by ID` : `[${start_index}:${end_index}]`;
      const destLabel = delete_source && sameNotebook
        ? `index ${adjustedInsertAt} in ${source_path}`
        : `${dest_path} at index ${adjustedInsertAt}`;
      return {
        content: [{ type: "text", text: `${operationPast} ${copiedCells.length} cell(s) from ${source_path} ${rangeLabel} to ${destLabel}:\n${cellSummaries.join("\n")}` }],
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

    const sameNotebook = source_path === dest_path;

    const { doc: destDoc } = sameNotebook
      ? { doc: sourceDoc }
      : await connectToNotebook(dest_path, destSession?.kernelId);
    const destCells = sameNotebook ? sourceCells : destDoc.getArray("cells");

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

    let adjustedInsertAt = insertAt;

    if (delete_source && sameNotebook) {
      // Same notebook move: delete first, adjust dest, then insert
      for (let i = sourceIndices.length - 1; i >= 0; i--) {
        sourceCells.delete(sourceIndices[i], 1);
      }
      const deletedBefore = sourceIndices.filter((si) => si < insertAt).length;
      adjustedInsertAt = Math.max(0, insertAt - deletedBefore);
      destCells.insert(adjustedInsertAt, copiedCells);
    } else {
      // Insert first (for cross-notebook move or copy)
      destCells.insert(insertAt, copiedCells);
      if (delete_source) {
        // Delete from source after inserting into dest
        for (let i = sourceIndices.length - 1; i >= 0; i--) {
          sourceCells.delete(sourceIndices[i], 1);
        }
      }
    }

    // Track each cell in change history
    for (let i = 0; i < copiedCells.length; i++) {
      const cell = copiedCells[i];
      const cellId = cell.get("id") || "";
      const source = cell.get("source")?.toString() || "";
      if (delete_source) {
        recordChange(source_path, {
          operation: "move",
          cellId,
          cellIdShort: cellId.slice(0, 8),
          cellIndex: sourceIndices[i],
          oldSource: source,
          client: clientId,
          detail: `moved to ${dest_path} index ${adjustedInsertAt + i}`,
        }, sourceDoc);
        recordChange(dest_path, {
          operation: "move",
          cellId,
          cellIdShort: cellId.slice(0, 8),
          cellIndex: adjustedInsertAt + i,
          newSource: source,
          client: clientId,
          detail: `moved from ${source_path}`,
        }, destDoc);
      } else {
        recordChange(dest_path, {
          operation: "copy",
          cellId,
          cellIdShort: cellId.slice(0, 8),
          cellIndex: adjustedInsertAt + i,
          newSource: source,
          client: clientId,
          detail: `copied from ${source_path}`,
        }, destDoc);
      }
    }

    const cellSummaries: string[] = [];
    for (let i = 0; i < copiedCells.length; i++) {
      const cell = copiedCells[i];
      const type = cell.get("cell_type") || "code";
      const newId = (cell.get("id") || "").slice(0, 8);
      const source = cell.get("source")?.toString() || "";
      const preview = getCodePreview(source, 50);
      cellSummaries.push(`  [${adjustedInsertAt + i}] (${newId}) ${type}: ${preview}`);
    }

    const rangeLabel = copyCellIds ? `${copyCellIds.length} cells by ID` : `[${start_index}:${end_index}]`;
    const destLabel = delete_source && sameNotebook
      ? `index ${adjustedInsertAt} in ${source_path}`
      : `${dest_path} at index ${adjustedInsertAt}`;
    return {
      content: [
        {
          type: "text",
          text: `${operationPast} ${copiedCells.length} cell(s) from ${source_path} ${rangeLabel} to ${destLabel}:\n${cellSummaries.join("\n")}`,
        },
      ],
    };
  },
};
