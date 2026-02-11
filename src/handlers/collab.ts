import type { ToolResult } from "../handler-types.js";
import * as Y from "yjs";
import {
  getCellId,
  resolveCellId,
  generateUnifiedDiff,
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
import { getNotebookCells } from "../tool-helpers.js";
import {
  recordChange,
  getCellHistory,
  getChangesSince,
  getDeletedCellSource,
} from "../cell-tracker.js";
import {
  createSnapshot,
  getSnapshot,
  listSnapshots as listSnapshotsForPath,
  restoreSnapshotToYjs,
  restoreSnapshotToFs,
  diffSnapshot,
} from "../snapshots.js";
import {
  acquireLocks,
  releaseLocks,
  listLocks as listLocksForPath,
} from "../cell-locks.js";

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  "get_cell_history": async (args) => {
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
  },

  "get_notebook_changes": async (args) => {
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
  },

  "recover_cell": async (args) => {
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
  },

  "snapshot_notebook": async (args) => {
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
  },

  "restore_snapshot": async (args) => {
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
  },

  "list_snapshots": async (args) => {
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
  },

  "diff_snapshot": async (args) => {
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
  },

  "lock_cells": async (args) => {
    const { path, cell_ids: lockCellIds, owner = "claude-code", ttl_minutes = 10 } = args as {
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
  },

  "unlock_cells": async (args) => {
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
  },

  "list_locks": async (args) => {
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
  },
};
