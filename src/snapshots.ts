/**
 * Notebook snapshots — save and restore named checkpoints.
 *
 * Snapshots capture the full cell content of a notebook at a point in time.
 * They're stored in-memory (keyed by notebook path + snapshot name).
 *
 * Use cases:
 * - Save state before risky operations
 * - Recover from accidental or malicious bulk changes
 * - Compare current state vs a known-good checkpoint
 */

import * as Y from "yjs";
import { extractSource, getCellType, getCellId } from "./helpers.js";

// ============================================================================
// Types
// ============================================================================

export interface CellSnapshot {
  id: string;
  cell_type: string;
  source: string;
  metadata: Record<string, any>;
}

export interface NotebookSnapshot {
  /** Name of this snapshot */
  name: string;
  /** Notebook path */
  path: string;
  /** ISO-8601 timestamp when snapshot was taken */
  createdAt: string;
  /** Cells at time of snapshot */
  cells: CellSnapshot[];
  /** Optional description */
  description?: string;
}

// ============================================================================
// Global state — snapshots keyed by "path:name"
// ============================================================================

const snapshots = new Map<string, NotebookSnapshot>();

function snapshotKey(path: string, name: string): string {
  return `${path}:${name}`;
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Capture the current state of a notebook's cells as a snapshot.
 * Works with both Y.Array cells (Jupyter mode) and plain objects (filesystem mode).
 */
export function createSnapshot(
  path: string,
  name: string,
  cells: Y.Array<any> | any[],
  description?: string
): NotebookSnapshot {
  const cellSnapshots: CellSnapshot[] = [];
  const length = cells instanceof Y.Array ? cells.length : cells.length;

  for (let i = 0; i < length; i++) {
    const cell = cells instanceof Y.Array ? cells.get(i) : cells[i];
    const id = getCellId(cell) || `unknown-${i}`;
    const cellType = getCellType(cell);
    const source = extractSource(cell);

    // Extract metadata
    let metadata: Record<string, any> = {};
    if (cell instanceof Y.Map) {
      const meta = cell.get("metadata");
      if (meta instanceof Y.Map) {
        metadata = meta.toJSON();
      }
    } else if (cell?.metadata) {
      metadata = { ...cell.metadata };
    }

    cellSnapshots.push({ id, cell_type: cellType, source, metadata });
  }

  const snapshot: NotebookSnapshot = {
    name,
    path,
    createdAt: new Date().toISOString(),
    cells: cellSnapshots,
    description,
  };

  snapshots.set(snapshotKey(path, name), snapshot);
  return snapshot;
}

/**
 * Get a snapshot by name.
 */
export function getSnapshot(
  path: string,
  name: string
): NotebookSnapshot | undefined {
  return snapshots.get(snapshotKey(path, name));
}

/**
 * List all snapshots for a notebook.
 */
export function listSnapshots(path: string): NotebookSnapshot[] {
  const results: NotebookSnapshot[] = [];
  for (const [key, snap] of snapshots) {
    if (snap.path === path) {
      results.push(snap);
    }
  }
  return results.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

/**
 * Delete a snapshot.
 */
export function deleteSnapshot(path: string, name: string): boolean {
  return snapshots.delete(snapshotKey(path, name));
}

/**
 * Restore a snapshot into a Y.Array of cells (Jupyter mode).
 * Replaces all cells in the notebook with the snapshot's cells.
 * Returns the number of cells restored.
 */
export function restoreSnapshotToYjs(
  snapshot: NotebookSnapshot,
  cells: Y.Array<any>,
  doc: Y.Doc
): number {
  doc.transact(() => {
    // Remove all existing cells
    if (cells.length > 0) {
      cells.delete(0, cells.length);
    }

    // Insert snapshot cells
    for (const cellSnap of snapshot.cells) {
      const newCell = new Y.Map();
      newCell.set("cell_type", cellSnap.cell_type);
      newCell.set("source", new Y.Text(cellSnap.source));
      newCell.set("id", cellSnap.id);

      // Restore metadata
      const metaMap = new Y.Map();
      for (const [key, value] of Object.entries(cellSnap.metadata)) {
        metaMap.set(key, value);
      }
      newCell.set("metadata", metaMap);

      if (cellSnap.cell_type === "code") {
        newCell.set("outputs", new Y.Array());
        newCell.set("execution_count", null);
      }

      cells.push([newCell]);
    }
  });

  return snapshot.cells.length;
}

/**
 * Restore a snapshot to a filesystem notebook data structure.
 * Returns the new cells array.
 */
export function restoreSnapshotToFs(snapshot: NotebookSnapshot): any[] {
  return snapshot.cells.map((cellSnap) => ({
    cell_type: cellSnap.cell_type,
    source: cellSnap.source,
    metadata: { ...cellSnap.metadata },
    id: cellSnap.id,
    ...(cellSnap.cell_type === "code"
      ? { outputs: [], execution_count: null }
      : {}),
  }));
}

/**
 * Diff a snapshot against current notebook state.
 * Returns a summary of what changed.
 */
export function diffSnapshot(
  snapshot: NotebookSnapshot,
  currentCells: Y.Array<any> | any[]
): {
  added: number;
  deleted: number;
  modified: number;
  unchanged: number;
  details: {
    cellId: string;
    status: "added" | "deleted" | "modified" | "unchanged";
    /** For modified cells: old source from snapshot */
    oldSource?: string;
    /** For modified/added cells: current source */
    newSource?: string;
  }[];
} {
  const snapMap = new Map(snapshot.cells.map((c) => [c.id, c]));
  const currentMap = new Map<string, { source: string }>();
  const length =
    currentCells instanceof Y.Array ? currentCells.length : currentCells.length;

  for (let i = 0; i < length; i++) {
    const cell =
      currentCells instanceof Y.Array ? currentCells.get(i) : currentCells[i];
    const id = getCellId(cell) || `unknown-${i}`;
    const source = extractSource(cell);
    currentMap.set(id, { source });
  }

  let added = 0,
    deleted = 0,
    modified = 0,
    unchanged = 0;
  const details: {
    cellId: string;
    status: "added" | "deleted" | "modified" | "unchanged";
    oldSource?: string;
    newSource?: string;
  }[] = [];

  // Check snapshot cells against current
  for (const [id, snap] of snapMap) {
    const current = currentMap.get(id);
    if (!current) {
      deleted++;
      details.push({ cellId: id.slice(0, 8), status: "deleted", oldSource: snap.source });
    } else if (current.source !== snap.source) {
      modified++;
      details.push({ cellId: id.slice(0, 8), status: "modified", oldSource: snap.source, newSource: current.source });
    } else {
      unchanged++;
      details.push({ cellId: id.slice(0, 8), status: "unchanged" });
    }
  }

  // Check for new cells not in snapshot
  for (const id of currentMap.keys()) {
    if (!snapMap.has(id)) {
      added++;
      details.push({ cellId: id.slice(0, 8), status: "added", newSource: currentMap.get(id)!.source });
    }
  }

  return { added, deleted, modified, unchanged, details };
}
