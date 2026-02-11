/**
 * Cell change tracking — records all modifications to notebook cells
 * with timestamps, attribution, and old/new content for undo.
 *
 * Dual-mode:
 * - When `doc` is provided → shared via Yjs (visible across MCP instances)
 * - When `doc` is omitted  → in-memory (single-instance, existing behavior)
 *
 * Provides `get_cell_history` and `get_notebook_changes` queries.
 */

import * as Y from "yjs";

// ============================================================================
// Types
// ============================================================================

export type ChangeOperation =
  | "insert"
  | "update"
  | "delete"
  | "move"
  | "copy"
  | "execute"
  | "change_type"
  | "clear_outputs"
  | "batch_update"
  | "restore";

export interface CellChange {
  /** Monotonically increasing version for the notebook */
  version: number;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** What happened */
  operation: ChangeOperation;
  /** Cell ID (full UUID, not truncated) */
  cellId: string;
  /** Truncated cell ID for display (first 8 chars) */
  cellIdShort: string;
  /** Cell index at time of change */
  cellIndex: number;
  /** Source before the change (undefined for inserts) */
  oldSource?: string;
  /** Source after the change (undefined for deletes) */
  newSource?: string;
  /** Who made this change (e.g. "claude-code", "user", agent name) */
  client?: string;
  /** Extra context (e.g. "moved from index 3 to 7") */
  detail?: string;
}

export interface NotebookTracker {
  /** Path to the notebook */
  path: string;
  /** Current version (incremented on each change) */
  version: number;
  /** Full change log (bounded by maxEntries) */
  changes: CellChange[];
  /** Max entries to keep (oldest are pruned) */
  maxEntries: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_ENTRIES = 500;
const YJS_MAP_KEY = "mcp_changes";
const YJS_KEY_VERSION = "version";
const YJS_KEY_BASE_VERSION = "base_version";
const YJS_KEY_ENTRIES = "entries";
const YJS_MAX_ENTRIES = 1000;

// ============================================================================
// In-memory backend — one tracker per notebook path
// ============================================================================

const trackers = new Map<string, NotebookTracker>();

// ============================================================================
// Yjs helpers
// ============================================================================

function getYjsChangeMap(doc: Y.Doc): Y.Map<any> {
  return doc.getMap<any>(YJS_MAP_KEY);
}

function getYjsEntries(doc: Y.Doc): Y.Array<string> {
  const map = getYjsChangeMap(doc);
  let entries = map.get(YJS_KEY_ENTRIES) as Y.Array<string> | undefined;
  if (!entries) {
    entries = new Y.Array<string>();
    map.set(YJS_KEY_ENTRIES, entries);
  }
  return entries;
}

function getYjsVersion(doc: Y.Doc): number {
  const map = getYjsChangeMap(doc);
  return (map.get(YJS_KEY_VERSION) as number) || 0;
}

function parseChange(json: string): CellChange | null {
  try {
    return JSON.parse(json) as CellChange;
  } catch {
    return null;
  }
}

// ============================================================================
// Core API — dual-mode dispatch
// ============================================================================

/**
 * Get or create the tracker for a notebook (in-memory only).
 */
export function getTracker(path: string): NotebookTracker {
  let tracker = trackers.get(path);
  if (!tracker) {
    tracker = {
      path,
      version: 0,
      changes: [],
      maxEntries: DEFAULT_MAX_ENTRIES,
    };
    trackers.set(path, tracker);
  }
  return tracker;
}

/**
 * Record a cell change. Returns the new version number.
 */
export function recordChange(
  path: string,
  change: Omit<CellChange, "version" | "timestamp">,
  doc?: Y.Doc
): number {
  if (doc) return recordChangeYjs(doc, change);
  return recordChangeInMemory(path, change);
}

/**
 * Get the change history for a specific cell.
 */
export function getCellHistory(
  path: string,
  cellId: string,
  limit: number = 20,
  doc?: Y.Doc
): CellChange[] {
  if (doc) return getCellHistoryYjs(doc, cellId, limit);
  return getCellHistoryInMemory(path, cellId, limit);
}

/**
 * Get all changes since a given version number.
 * Useful for "what changed since I last looked?" queries.
 */
export function getChangesSince(
  path: string,
  sinceVersion: number,
  limit: number = 50,
  doc?: Y.Doc
): { changes: CellChange[]; currentVersion: number } {
  if (doc) return getChangesSinceYjs(doc, sinceVersion, limit);
  return getChangesSinceInMemory(path, sinceVersion, limit);
}

/**
 * Get the current version number for a notebook.
 */
export function getCurrentVersion(path: string, doc?: Y.Doc): number {
  if (doc) return getYjsVersion(doc);
  return getTracker(path).version;
}

/**
 * Clear all tracking data for a notebook (e.g. when it's closed).
 */
export function clearTracker(path: string, doc?: Y.Doc): void {
  if (doc) {
    const map = getYjsChangeMap(doc);
    doc.transact(() => {
      map.delete(YJS_KEY_VERSION);
      map.delete(YJS_KEY_BASE_VERSION);
      map.delete(YJS_KEY_ENTRIES);
    });
    return;
  }
  trackers.delete(path);
}

/**
 * Get a summary of recent changes grouped by cell.
 */
export function getChangeSummary(
  path: string,
  limit: number = 20,
  doc?: Y.Doc
): {
  currentVersion: number;
  recentChanges: CellChange[];
  cellsModified: number;
} {
  if (doc) return getChangeSummaryYjs(doc, limit);
  return getChangeSummaryInMemory(path, limit);
}

/**
 * Find the last known source for a deleted cell (for recovery).
 */
export function getDeletedCellSource(
  path: string,
  cellId: string,
  doc?: Y.Doc
): { source: string; cellType?: string; deletedAt: string } | undefined {
  if (doc) return getDeletedCellSourceYjs(doc, cellId);
  return getDeletedCellSourceInMemory(path, cellId);
}

// ============================================================================
// In-memory implementations
// ============================================================================

function recordChangeInMemory(
  path: string,
  change: Omit<CellChange, "version" | "timestamp">
): number {
  const tracker = getTracker(path);
  tracker.version++;

  const entry: CellChange = {
    ...change,
    version: tracker.version,
    timestamp: new Date().toISOString(),
  };

  tracker.changes.push(entry);

  // Prune oldest entries if over limit
  if (tracker.changes.length > tracker.maxEntries) {
    const excess = tracker.changes.length - tracker.maxEntries;
    tracker.changes.splice(0, excess);
  }

  return tracker.version;
}

function getCellHistoryInMemory(
  path: string,
  cellId: string,
  limit: number
): CellChange[] {
  const tracker = getTracker(path);
  const matches = tracker.changes.filter(
    (c) => c.cellId.startsWith(cellId) || c.cellIdShort.startsWith(cellId)
  );
  return matches.slice(-limit);
}

function getChangesSinceInMemory(
  path: string,
  sinceVersion: number,
  limit: number
): { changes: CellChange[]; currentVersion: number } {
  const tracker = getTracker(path);
  const changes = tracker.changes.filter((c) => c.version > sinceVersion);
  return {
    changes: changes.slice(-limit),
    currentVersion: tracker.version,
  };
}

function getChangeSummaryInMemory(
  path: string,
  limit: number
): {
  currentVersion: number;
  recentChanges: CellChange[];
  cellsModified: number;
} {
  const tracker = getTracker(path);
  const recent = tracker.changes.slice(-limit);
  const uniqueCells = new Set(recent.map((c) => c.cellId));
  return {
    currentVersion: tracker.version,
    recentChanges: recent,
    cellsModified: uniqueCells.size,
  };
}

function getDeletedCellSourceInMemory(
  path: string,
  cellId: string
): { source: string; cellType?: string; deletedAt: string } | undefined {
  const tracker = getTracker(path);
  const deleteEvent = [...tracker.changes]
    .reverse()
    .find(
      (c) =>
        c.operation === "delete" &&
        (c.cellId.startsWith(cellId) || c.cellIdShort.startsWith(cellId))
    );

  if (deleteEvent && deleteEvent.oldSource !== undefined) {
    return {
      source: deleteEvent.oldSource,
      deletedAt: deleteEvent.timestamp,
    };
  }
  return undefined;
}

// ============================================================================
// Yjs implementations
// ============================================================================

function recordChangeYjs(
  doc: Y.Doc,
  change: Omit<CellChange, "version" | "timestamp">
): number {
  const map = getYjsChangeMap(doc);
  let newVersion = 0;

  doc.transact(() => {
    const currentVersion = (map.get(YJS_KEY_VERSION) as number) || 0;
    newVersion = currentVersion + 1;
    map.set(YJS_KEY_VERSION, newVersion);

    const entry: CellChange = {
      ...change,
      version: newVersion,
      timestamp: new Date().toISOString(),
    };

    const entries = getYjsEntries(doc);
    entries.push([JSON.stringify(entry)]);

    // Prune if over 2x limit
    if (entries.length > YJS_MAX_ENTRIES * 2) {
      const excess = entries.length - YJS_MAX_ENTRIES;
      entries.delete(0, excess);
      const baseVersion = (map.get(YJS_KEY_BASE_VERSION) as number) || 0;
      map.set(YJS_KEY_BASE_VERSION, baseVersion + excess);
    }
  });

  return newVersion;
}

function getCellHistoryYjs(
  doc: Y.Doc,
  cellId: string,
  limit: number
): CellChange[] {
  const entries = getYjsEntries(doc);
  const matches: CellChange[] = [];

  for (let i = 0; i < entries.length; i++) {
    const change = parseChange(entries.get(i));
    if (!change) continue;
    if (change.cellId.startsWith(cellId) || change.cellIdShort.startsWith(cellId)) {
      matches.push(change);
    }
  }

  return matches.slice(-limit);
}

function getChangesSinceYjs(
  doc: Y.Doc,
  sinceVersion: number,
  limit: number
): { changes: CellChange[]; currentVersion: number } {
  const entries = getYjsEntries(doc);
  const currentVersion = getYjsVersion(doc);
  const changes: CellChange[] = [];

  for (let i = 0; i < entries.length; i++) {
    const change = parseChange(entries.get(i));
    if (!change) continue;
    if (change.version > sinceVersion) {
      changes.push(change);
    }
  }

  return {
    changes: changes.slice(-limit),
    currentVersion,
  };
}

function getChangeSummaryYjs(
  doc: Y.Doc,
  limit: number
): {
  currentVersion: number;
  recentChanges: CellChange[];
  cellsModified: number;
} {
  const entries = getYjsEntries(doc);
  const currentVersion = getYjsVersion(doc);
  const all: CellChange[] = [];

  for (let i = 0; i < entries.length; i++) {
    const change = parseChange(entries.get(i));
    if (change) all.push(change);
  }

  const recent = all.slice(-limit);
  const uniqueCells = new Set(recent.map((c) => c.cellId));
  return {
    currentVersion,
    recentChanges: recent,
    cellsModified: uniqueCells.size,
  };
}

function getDeletedCellSourceYjs(
  doc: Y.Doc,
  cellId: string
): { source: string; cellType?: string; deletedAt: string } | undefined {
  const entries = getYjsEntries(doc);

  // Scan from end for the most recent delete event
  for (let i = entries.length - 1; i >= 0; i--) {
    const change = parseChange(entries.get(i));
    if (!change) continue;
    if (
      change.operation === "delete" &&
      (change.cellId.startsWith(cellId) || change.cellIdShort.startsWith(cellId))
    ) {
      if (change.oldSource !== undefined) {
        return {
          source: change.oldSource,
          deletedAt: change.timestamp,
        };
      }
    }
  }

  return undefined;
}
