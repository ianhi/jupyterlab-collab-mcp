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
} from "../connection.js";
import { recordChange } from "../cell-tracker.js";
import { checkLock } from "../cell-locks.js";

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  "insert_cell": async (args) => {
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
  },

  "update_cell": async (args) => {
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
  },

  "batch_update_cells": async (args) => {
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
  },

  "delete_cell": async (args) => {
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
  },

  "delete_cells": async (args) => {
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
  },

  "move_cells": async (args) => {
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
  },
};
