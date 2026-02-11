import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  acquireLocks,
  releaseLocks,
  checkLock,
  listLocks,
  releaseAllLocks,
  clearLocks,
} from "./cell-locks.js";

const PATH = "test-notebook.ipynb";

beforeEach(() => {
  clearLocks(PATH);
  clearLocks("other.ipynb");
});

describe("acquireLocks", () => {
  it("acquires locks on free cells", () => {
    const result = acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a");
    expect(result.acquired).toHaveLength(2);
    expect(result.blocked).toHaveLength(0);
    expect(result.acquired[0].cellId).toBe("cell-1");
    expect(result.acquired[0].owner).toBe("agent-a");
    expect(result.acquired[0].path).toBe(PATH);
  });

  it("blocks when another owner holds the lock", () => {
    acquireLocks(PATH, ["cell-1"], "agent-a");
    const result = acquireLocks(PATH, ["cell-1", "cell-2"], "agent-b");

    expect(result.acquired).toHaveLength(1);
    expect(result.acquired[0].cellId).toBe("cell-2");
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toEqual({ cellId: "cell-1", owner: "agent-a" });
  });

  it("allows same owner to re-acquire (refresh) their lock", () => {
    acquireLocks(PATH, ["cell-1"], "agent-a");
    const result = acquireLocks(PATH, ["cell-1"], "agent-a");

    expect(result.acquired).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it("sets expiry based on TTL", () => {
    const result = acquireLocks(PATH, ["cell-1"], "agent-a", 10_000); // 10 seconds
    const lock = result.acquired[0];
    const acquiredTime = new Date(lock.acquiredAt).getTime();
    const expiresTime = new Date(lock.expiresAt).getTime();
    expect(expiresTime - acquiredTime).toBe(10_000);
  });

  it("allows acquiring expired lock from another owner", () => {
    // Acquire with a very short TTL, then manually expire it
    acquireLocks(PATH, ["cell-1"], "agent-a", 1);

    // Wait just enough for expiry (1ms TTL)
    vi.useFakeTimers();
    vi.advanceTimersByTime(10);

    const result = acquireLocks(PATH, ["cell-1"], "agent-b");
    // The lock is expired, so agent-b should be able to take it
    expect(result.acquired).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);

    vi.useRealTimers();
  });

  it("handles empty cellIds array", () => {
    const result = acquireLocks(PATH, [], "agent-a");
    expect(result.acquired).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });
});

describe("releaseLocks", () => {
  it("releases locks owned by the caller", () => {
    acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a");
    const result = releaseLocks(PATH, ["cell-1", "cell-2"], "agent-a");

    expect(result.released).toEqual(["cell-1", "cell-2"]);
    expect(result.notOwned).toHaveLength(0);
    expect(result.notFound).toHaveLength(0);
  });

  it("refuses to release locks owned by someone else", () => {
    acquireLocks(PATH, ["cell-1"], "agent-a");
    const result = releaseLocks(PATH, ["cell-1"], "agent-b");

    expect(result.released).toHaveLength(0);
    expect(result.notOwned).toEqual(["cell-1"]);
  });

  it("allows force release regardless of owner", () => {
    acquireLocks(PATH, ["cell-1"], "agent-a");
    const result = releaseLocks(PATH, ["cell-1"], "agent-b", true);

    expect(result.released).toEqual(["cell-1"]);
    expect(result.notOwned).toHaveLength(0);
  });

  it("reports not found for unlocked cells", () => {
    const result = releaseLocks(PATH, ["nonexistent"], "agent-a");
    expect(result.notFound).toEqual(["nonexistent"]);
  });

  it("handles mixed results", () => {
    acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a");
    const result = releaseLocks(PATH, ["cell-1", "cell-2", "cell-3"], "agent-b");

    expect(result.released).toHaveLength(0);
    expect(result.notOwned).toEqual(["cell-1", "cell-2"]);
    expect(result.notFound).toEqual(["cell-3"]);
  });
});

describe("checkLock", () => {
  it("returns undefined for unlocked cell", () => {
    expect(checkLock(PATH, "cell-1", "agent-a")).toBeUndefined();
  });

  it("returns undefined when caller is the lock owner", () => {
    acquireLocks(PATH, ["cell-1"], "agent-a");
    expect(checkLock(PATH, "cell-1", "agent-a")).toBeUndefined();
  });

  it("returns lock info when blocked by another owner", () => {
    acquireLocks(PATH, ["cell-1"], "agent-a");
    const lock = checkLock(PATH, "cell-1", "agent-b");

    expect(lock).toBeDefined();
    expect(lock!.owner).toBe("agent-a");
    expect(lock!.cellId).toBe("cell-1");
  });

  it("auto-cleans expired locks and returns undefined", () => {
    vi.useFakeTimers();
    acquireLocks(PATH, ["cell-1"], "agent-a", 1000); // 1 second TTL

    // Advance past expiry
    vi.advanceTimersByTime(2000);

    const lock = checkLock(PATH, "cell-1", "agent-b");
    expect(lock).toBeUndefined();

    // Lock should be cleaned up
    expect(listLocks(PATH)).toHaveLength(0);

    vi.useRealTimers();
  });
});

describe("listLocks", () => {
  it("returns empty for notebook with no locks", () => {
    expect(listLocks(PATH)).toEqual([]);
  });

  it("returns active locks for a notebook", () => {
    acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a");
    acquireLocks(PATH, ["cell-3"], "agent-b");

    const active = listLocks(PATH);
    expect(active).toHaveLength(3);
  });

  it("does not return locks from other notebooks", () => {
    acquireLocks(PATH, ["cell-1"], "agent-a");
    acquireLocks("other.ipynb", ["cell-2"], "agent-a");

    expect(listLocks(PATH)).toHaveLength(1);
    expect(listLocks("other.ipynb")).toHaveLength(1);
  });

  it("prunes expired locks", () => {
    vi.useFakeTimers();
    acquireLocks(PATH, ["cell-1"], "agent-a", 1000); // 1 second
    acquireLocks(PATH, ["cell-2"], "agent-b", 60_000); // 60 seconds

    vi.advanceTimersByTime(2000);

    const active = listLocks(PATH);
    expect(active).toHaveLength(1);
    expect(active[0].cellId).toBe("cell-2");

    vi.useRealTimers();
  });

  it("sorts by acquiredAt", () => {
    vi.useFakeTimers();
    const base = Date.now();

    acquireLocks(PATH, ["cell-2"], "agent-a");
    vi.advanceTimersByTime(100);
    acquireLocks(PATH, ["cell-1"], "agent-b");

    const active = listLocks(PATH);
    expect(active[0].cellId).toBe("cell-2"); // acquired first
    expect(active[1].cellId).toBe("cell-1"); // acquired second

    vi.useRealTimers();
  });
});

describe("releaseAllLocks", () => {
  it("releases all locks for an owner across notebooks", () => {
    acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a");
    acquireLocks("other.ipynb", ["cell-3"], "agent-a");
    acquireLocks(PATH, ["cell-4"], "agent-b");

    const count = releaseAllLocks("agent-a");
    expect(count).toBe(3);

    expect(listLocks(PATH)).toHaveLength(1); // only agent-b's lock
    expect(listLocks("other.ipynb")).toHaveLength(0);
  });

  it("returns 0 when owner has no locks", () => {
    expect(releaseAllLocks("nobody")).toBe(0);
  });
});

describe("clearLocks", () => {
  it("clears all locks for a notebook", () => {
    acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a");
    acquireLocks(PATH, ["cell-3"], "agent-b");

    const count = clearLocks(PATH);
    expect(count).toBe(3);
    expect(listLocks(PATH)).toHaveLength(0);
  });

  it("does not affect other notebooks", () => {
    acquireLocks(PATH, ["cell-1"], "agent-a");
    acquireLocks("other.ipynb", ["cell-2"], "agent-a");

    clearLocks(PATH);
    expect(listLocks("other.ipynb")).toHaveLength(1);
  });

  it("returns 0 for notebook with no locks", () => {
    expect(clearLocks(PATH)).toBe(0);
  });
});

// ============================================================================
// Yjs backend tests
// ============================================================================

import * as Y from "yjs";

function createSyncedDocs(): [Y.Doc, Y.Doc] {
  const doc1 = new Y.Doc();
  const doc2 = new Y.Doc();
  doc1.on("update", (update: Uint8Array) => Y.applyUpdate(doc2, update));
  doc2.on("update", (update: Uint8Array) => Y.applyUpdate(doc1, update));
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
  return [doc1, doc2];
}

describe("Yjs backend — acquireLocks", () => {
  it("acquires locks via Yjs map", () => {
    const doc = new Y.Doc();
    const result = acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a", undefined, doc);
    expect(result.acquired).toHaveLength(2);
    expect(result.blocked).toHaveLength(0);
  });

  it("blocks when another owner holds the lock", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc);
    const result = acquireLocks(PATH, ["cell-1"], "agent-b", undefined, doc);
    expect(result.acquired).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].owner).toBe("agent-a");
  });

  it("allows same owner to re-acquire (renew)", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc);
    const result = acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc);
    expect(result.acquired).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it("allows acquire after TTL expires", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", 1, doc); // 1ms TTL
    // Wait a tiny bit for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const result = acquireLocks(PATH, ["cell-1"], "agent-b", undefined, doc);
    expect(result.acquired).toHaveLength(1);
  });
});

describe("Yjs backend — releaseLocks", () => {
  it("releases owned locks", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc);
    const result = releaseLocks(PATH, ["cell-1"], "agent-a", false, doc);
    expect(result.released).toHaveLength(1);
    expect(result.notOwned).toHaveLength(0);
  });

  it("refuses to release locks owned by someone else", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc);
    const result = releaseLocks(PATH, ["cell-1"], "agent-b", false, doc);
    expect(result.released).toHaveLength(0);
    expect(result.notOwned).toHaveLength(1);
  });

  it("force releases locks owned by someone else", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc);
    const result = releaseLocks(PATH, ["cell-1"], "agent-b", true, doc);
    expect(result.released).toHaveLength(1);
  });
});

describe("Yjs backend — checkLock", () => {
  it("returns undefined for free cells", () => {
    const doc = new Y.Doc();
    expect(checkLock(PATH, "cell-1", "agent-a", doc)).toBeUndefined();
  });

  it("returns lock when blocked by another owner", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc);
    const lock = checkLock(PATH, "cell-1", "agent-b", doc);
    expect(lock).toBeDefined();
    expect(lock!.owner).toBe("agent-a");
  });

  it("returns undefined for same owner", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc);
    expect(checkLock(PATH, "cell-1", "agent-a", doc)).toBeUndefined();
  });

  it("cleans up expired locks", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", 1, doc);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(checkLock(PATH, "cell-1", "agent-b", doc)).toBeUndefined();
  });
});

describe("Yjs backend — listLocks", () => {
  it("lists active locks", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a", undefined, doc);
    const locks = listLocks(PATH, doc);
    expect(locks).toHaveLength(2);
  });

  it("prunes expired locks", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1"], "agent-a", 1, doc);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const locks = listLocks(PATH, doc);
    expect(locks).toHaveLength(0);
  });
});

describe("Yjs backend — clearLocks", () => {
  it("clears all locks", () => {
    const doc = new Y.Doc();
    acquireLocks(PATH, ["cell-1", "cell-2"], "agent-a", undefined, doc);
    const count = clearLocks(PATH, doc);
    expect(count).toBe(2);
    expect(listLocks(PATH, doc)).toHaveLength(0);
  });
});

describe("Yjs backend — cross-instance sync", () => {
  it("lock on doc1 visible on doc2", () => {
    const [doc1, doc2] = createSyncedDocs();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc1);
    const locks = listLocks(PATH, doc2);
    expect(locks).toHaveLength(1);
    expect(locks[0].owner).toBe("agent-a");
  });

  it("lock on doc1 blocks acquire on doc2", () => {
    const [doc1, doc2] = createSyncedDocs();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc1);
    const result = acquireLocks(PATH, ["cell-1"], "agent-b", undefined, doc2);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].owner).toBe("agent-a");
  });

  it("release on doc1 frees on doc2", () => {
    const [doc1, doc2] = createSyncedDocs();
    acquireLocks(PATH, ["cell-1"], "agent-a", undefined, doc1);
    releaseLocks(PATH, ["cell-1"], "agent-a", false, doc1);
    const result = acquireLocks(PATH, ["cell-1"], "agent-b", undefined, doc2);
    expect(result.acquired).toHaveLength(1);
  });
});
