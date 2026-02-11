/**
 * Cell locking — agents can claim cells to prevent accidental overwrites.
 *
 * Locks are advisory (not enforced by default). Write tools check locks
 * and warn if another client holds the lock. Use `force=true` to override.
 *
 * Locks are in-memory, scoped to the MCP server session. They auto-expire
 * after a configurable timeout (default 5 minutes) to prevent stale locks.
 */

// ============================================================================
// Types
// ============================================================================

export interface CellLock {
  /** Cell ID (full UUID) */
  cellId: string;
  /** Notebook path */
  path: string;
  /** Who holds the lock (agent name or "claude-code") */
  owner: string;
  /** ISO-8601 timestamp when lock was acquired */
  acquiredAt: string;
  /** ISO-8601 timestamp when lock expires */
  expiresAt: string;
}

// ============================================================================
// Global state — locks keyed by "path:cellId"
// ============================================================================

const locks = new Map<string, CellLock>();

const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

function lockKey(path: string, cellId: string): string {
  return `${path}:${cellId}`;
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Acquire a lock on one or more cells.
 * Returns the locks that were acquired and any that were blocked.
 */
export function acquireLocks(
  path: string,
  cellIds: string[],
  owner: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS
): { acquired: CellLock[]; blocked: { cellId: string; owner: string }[] } {
  const now = new Date();
  const acquired: CellLock[] = [];
  const blocked: { cellId: string; owner: string }[] = [];

  for (const cellId of cellIds) {
    const key = lockKey(path, cellId);
    const existing = locks.get(key);

    // Check if there's an active lock by someone else
    if (existing && existing.owner !== owner && new Date(existing.expiresAt) > now) {
      blocked.push({ cellId, owner: existing.owner });
      continue;
    }

    const lock: CellLock = {
      cellId,
      path,
      owner,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    locks.set(key, lock);
    acquired.push(lock);
  }

  return { acquired, blocked };
}

/**
 * Release locks on one or more cells.
 * Only the owner can release their locks (or anyone if force=true).
 */
export function releaseLocks(
  path: string,
  cellIds: string[],
  owner: string,
  force: boolean = false
): { released: string[]; notOwned: string[]; notFound: string[] } {
  const released: string[] = [];
  const notOwned: string[] = [];
  const notFound: string[] = [];

  for (const cellId of cellIds) {
    const key = lockKey(path, cellId);
    const existing = locks.get(key);

    if (!existing) {
      notFound.push(cellId);
      continue;
    }

    if (existing.owner !== owner && !force) {
      notOwned.push(cellId);
      continue;
    }

    locks.delete(key);
    released.push(cellId);
  }

  return { released, notOwned, notFound };
}

/**
 * Check if a cell is locked by someone other than the caller.
 * Returns the lock if blocked, undefined if free.
 * Automatically cleans up expired locks.
 */
export function checkLock(
  path: string,
  cellId: string,
  caller: string
): CellLock | undefined {
  const key = lockKey(path, cellId);
  const existing = locks.get(key);

  if (!existing) return undefined;

  // Clean up expired locks
  if (new Date(existing.expiresAt) <= new Date()) {
    locks.delete(key);
    return undefined;
  }

  // Same owner — not blocked
  if (existing.owner === caller) return undefined;

  return existing;
}

/**
 * List all active locks for a notebook.
 * Automatically prunes expired locks.
 */
export function listLocks(path: string): CellLock[] {
  const now = new Date();
  const results: CellLock[] = [];

  for (const [key, lock] of locks) {
    if (lock.path !== path) continue;

    if (new Date(lock.expiresAt) <= now) {
      locks.delete(key);
      continue;
    }

    results.push(lock);
  }

  return results.sort(
    (a, b) => new Date(a.acquiredAt).getTime() - new Date(b.acquiredAt).getTime()
  );
}

/**
 * Release all locks for a given owner (e.g., when an agent disconnects).
 */
export function releaseAllLocks(owner: string): number {
  let count = 0;
  for (const [key, lock] of locks) {
    if (lock.owner === owner) {
      locks.delete(key);
      count++;
    }
  }
  return count;
}

/**
 * Clear all locks for a notebook (e.g., when closing it).
 */
export function clearLocks(path: string): number {
  let count = 0;
  for (const [key, lock] of locks) {
    if (lock.path === path) {
      locks.delete(key);
      count++;
    }
  }
  return count;
}
