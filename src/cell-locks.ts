/**
 * Cell locking — agents can claim cells to prevent accidental overwrites.
 *
 * Locks are advisory (not enforced by default). Write tools check locks
 * and warn if another client holds the lock. Use `force=true` to override.
 *
 * Dual-mode:
 * - When `doc` is provided → shared via Yjs (visible across MCP instances)
 * - When `doc` is omitted  → in-memory (single-instance, existing behavior)
 */

import * as Y from "yjs";

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
// Constants
// ============================================================================

const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const YJS_MAP_KEY = "mcp_locks";

// ============================================================================
// In-memory backend (existing behavior)
// ============================================================================

const locks = new Map<string, CellLock>();

function lockKey(path: string, cellId: string): string {
  return `${path}:${cellId}`;
}

// ============================================================================
// Yjs helpers
// ============================================================================

function getYjsLockMap(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(YJS_MAP_KEY);
}

function parseLock(json: string): CellLock | null {
  try {
    return JSON.parse(json) as CellLock;
  } catch {
    return null;
  }
}

function isExpired(lock: CellLock, now: Date = new Date()): boolean {
  return new Date(lock.expiresAt) <= now;
}

// ============================================================================
// Core API — dual-mode dispatch
// ============================================================================

/**
 * Acquire a lock on one or more cells.
 * Returns the locks that were acquired and any that were blocked.
 */
export function acquireLocks(
  path: string,
  cellIds: string[],
  owner: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
  doc?: Y.Doc
): { acquired: CellLock[]; blocked: { cellId: string; owner: string }[] } {
  if (doc) return acquireLocksYjs(doc, path, cellIds, owner, ttlMs);
  return acquireLocksInMemory(path, cellIds, owner, ttlMs);
}

/**
 * Release locks on one or more cells.
 * Only the owner can release their locks (or anyone if force=true).
 */
export function releaseLocks(
  path: string,
  cellIds: string[],
  owner: string,
  force: boolean = false,
  doc?: Y.Doc
): { released: string[]; notOwned: string[]; notFound: string[] } {
  if (doc) return releaseLocksYjs(doc, cellIds, owner, force);
  return releaseLocksInMemory(path, cellIds, owner, force);
}

/**
 * Check if a cell is locked by someone other than the caller.
 * Returns the lock if blocked, undefined if free.
 * Automatically cleans up expired locks.
 */
export function checkLock(
  path: string,
  cellId: string,
  caller: string,
  doc?: Y.Doc
): CellLock | undefined {
  if (doc) return checkLockYjs(doc, cellId, caller);
  return checkLockInMemory(path, cellId, caller);
}

/**
 * List all active locks for a notebook.
 * Automatically prunes expired locks.
 */
export function listLocks(path: string, doc?: Y.Doc): CellLock[] {
  if (doc) return listLocksYjs(doc);
  return listLocksInMemory(path);
}

/**
 * Release all locks for a given owner (e.g., when an agent disconnects).
 * In-memory only — Yjs locks are scoped to the notebook doc.
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
export function clearLocks(path: string, doc?: Y.Doc): number {
  if (doc) return clearLocksYjs(doc);
  return clearLocksInMemory(path);
}

// ============================================================================
// In-memory implementations
// ============================================================================

function acquireLocksInMemory(
  path: string,
  cellIds: string[],
  owner: string,
  ttlMs: number
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

function releaseLocksInMemory(
  path: string,
  cellIds: string[],
  owner: string,
  force: boolean
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

function checkLockInMemory(
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

function listLocksInMemory(path: string): CellLock[] {
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

function clearLocksInMemory(path: string): number {
  let count = 0;
  for (const [key, lock] of locks) {
    if (lock.path === path) {
      locks.delete(key);
      count++;
    }
  }
  return count;
}

// ============================================================================
// Yjs implementations
// ============================================================================

function acquireLocksYjs(
  doc: Y.Doc,
  path: string,
  cellIds: string[],
  owner: string,
  ttlMs: number
): { acquired: CellLock[]; blocked: { cellId: string; owner: string }[] } {
  const now = new Date();
  const acquired: CellLock[] = [];
  const blocked: { cellId: string; owner: string }[] = [];
  const lockMap = getYjsLockMap(doc);

  doc.transact(() => {
    for (const cellId of cellIds) {
      const existingJson = lockMap.get(cellId);
      if (existingJson) {
        const existing = parseLock(existingJson);
        if (existing && existing.owner !== owner && !isExpired(existing, now)) {
          blocked.push({ cellId, owner: existing.owner });
          continue;
        }
        // Expired or same owner — overwrite
      }

      const lock: CellLock = {
        cellId,
        path,
        owner,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      lockMap.set(cellId, JSON.stringify(lock));
      acquired.push(lock);
    }
  });

  return { acquired, blocked };
}

function releaseLocksYjs(
  doc: Y.Doc,
  cellIds: string[],
  owner: string,
  force: boolean
): { released: string[]; notOwned: string[]; notFound: string[] } {
  const released: string[] = [];
  const notOwned: string[] = [];
  const notFound: string[] = [];
  const lockMap = getYjsLockMap(doc);

  doc.transact(() => {
    for (const cellId of cellIds) {
      const existingJson = lockMap.get(cellId);
      if (!existingJson) {
        notFound.push(cellId);
        continue;
      }

      const existing = parseLock(existingJson);
      if (!existing) {
        notFound.push(cellId);
        continue;
      }

      if (existing.owner !== owner && !force) {
        notOwned.push(cellId);
        continue;
      }

      lockMap.delete(cellId);
      released.push(cellId);
    }
  });

  return { released, notOwned, notFound };
}

function checkLockYjs(
  doc: Y.Doc,
  cellId: string,
  caller: string
): CellLock | undefined {
  const lockMap = getYjsLockMap(doc);
  const json = lockMap.get(cellId);
  if (!json) return undefined;

  const lock = parseLock(json);
  if (!lock) return undefined;

  // Clean up expired locks opportunistically
  if (isExpired(lock)) {
    lockMap.delete(cellId);
    return undefined;
  }

  // Same owner — not blocked
  if (lock.owner === caller) return undefined;

  return lock;
}

function listLocksYjs(doc: Y.Doc): CellLock[] {
  const now = new Date();
  const lockMap = getYjsLockMap(doc);
  const results: CellLock[] = [];

  for (const [cellId, json] of lockMap.entries()) {
    const lock = parseLock(json);
    if (!lock) continue;

    if (isExpired(lock, now)) {
      lockMap.delete(cellId);
      continue;
    }

    results.push(lock);
  }

  return results.sort(
    (a, b) => new Date(a.acquiredAt).getTime() - new Date(b.acquiredAt).getTime()
  );
}

function clearLocksYjs(doc: Y.Doc): number {
  const lockMap = getYjsLockMap(doc);
  const count = lockMap.size;
  doc.transact(() => {
    for (const key of [...lockMap.keys()]) {
      lockMap.delete(key);
    }
  });
  return count;
}
