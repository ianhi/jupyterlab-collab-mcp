/**
 * Cell change tracking — records all modifications to notebook cells
 * with timestamps, attribution, and old/new content for undo.
 *
 * Stores an in-memory log per notebook. Each entry records:
 * - what happened (insert, update, delete, move)
 * - which cell (by cell_id)
 * - who did it (client identifier, if available)
 * - the old and new source content
 * - a monotonically increasing version number
 *
 * Provides `get_cell_history` and `get_notebook_changes` queries.
 */

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
// Global state — one tracker per notebook path
// ============================================================================

const trackers = new Map<string, NotebookTracker>();

const DEFAULT_MAX_ENTRIES = 500;

// ============================================================================
// Core API
// ============================================================================

/**
 * Get or create the tracker for a notebook.
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

/**
 * Get the change history for a specific cell.
 */
export function getCellHistory(
  path: string,
  cellId: string,
  limit: number = 20
): CellChange[] {
  const tracker = getTracker(path);
  // Match by prefix (same as cell_id resolution elsewhere)
  const matches = tracker.changes.filter(
    (c) => c.cellId.startsWith(cellId) || c.cellIdShort.startsWith(cellId)
  );
  return matches.slice(-limit);
}

/**
 * Get all changes since a given version number.
 * Useful for "what changed since I last looked?" queries.
 */
export function getChangesSince(
  path: string,
  sinceVersion: number,
  limit: number = 50
): { changes: CellChange[]; currentVersion: number } {
  const tracker = getTracker(path);
  const changes = tracker.changes.filter((c) => c.version > sinceVersion);
  return {
    changes: changes.slice(-limit),
    currentVersion: tracker.version,
  };
}

/**
 * Get the current version number for a notebook.
 */
export function getCurrentVersion(path: string): number {
  return getTracker(path).version;
}

/**
 * Clear all tracking data for a notebook (e.g. when it's closed).
 */
export function clearTracker(path: string): void {
  trackers.delete(path);
}

/**
 * Get a summary of recent changes grouped by cell.
 */
export function getChangeSummary(
  path: string,
  limit: number = 20
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

/**
 * Find the last known source for a deleted cell (for recovery).
 */
export function getDeletedCellSource(
  path: string,
  cellId: string
): { source: string; cellType?: string; deletedAt: string } | undefined {
  const tracker = getTracker(path);
  // Find the delete event for this cell
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
