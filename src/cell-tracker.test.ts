import { describe, it, expect, beforeEach } from "vitest";
import {
  recordChange,
  getCellHistory,
  getChangesSince,
  getCurrentVersion,
  clearTracker,
  getChangeSummary,
  getDeletedCellSource,
  getTracker,
} from "./cell-tracker.js";

const PATH = "test-notebook.ipynb";

beforeEach(() => {
  clearTracker(PATH);
});

describe("getTracker", () => {
  it("creates a new tracker for unknown path", () => {
    const t = getTracker(PATH);
    expect(t.path).toBe(PATH);
    expect(t.version).toBe(0);
    expect(t.changes).toEqual([]);
    expect(t.maxEntries).toBe(500);
  });

  it("returns the same tracker on repeated calls", () => {
    const t1 = getTracker(PATH);
    const t2 = getTracker(PATH);
    expect(t1).toBe(t2);
  });

  it("returns different trackers for different paths", () => {
    const t1 = getTracker("a.ipynb");
    const t2 = getTracker("b.ipynb");
    expect(t1).not.toBe(t2);
    clearTracker("a.ipynb");
    clearTracker("b.ipynb");
  });
});

describe("recordChange", () => {
  it("increments version and returns it", () => {
    const v1 = recordChange(PATH, {
      operation: "insert",
      cellId: "abc12345-full-uuid",
      cellIdShort: "abc12345",
      cellIndex: 0,
      newSource: "print('hello')",
    });
    expect(v1).toBe(1);

    const v2 = recordChange(PATH, {
      operation: "update",
      cellId: "abc12345-full-uuid",
      cellIdShort: "abc12345",
      cellIndex: 0,
      oldSource: "print('hello')",
      newSource: "print('world')",
    });
    expect(v2).toBe(2);
  });

  it("stores change with version and timestamp", () => {
    recordChange(PATH, {
      operation: "insert",
      cellId: "cell-001",
      cellIdShort: "cell-001",
      cellIndex: 0,
      newSource: "x = 1",
      client: "test-agent",
    });

    const tracker = getTracker(PATH);
    expect(tracker.changes).toHaveLength(1);
    const entry = tracker.changes[0];
    expect(entry.version).toBe(1);
    expect(entry.operation).toBe("insert");
    expect(entry.cellId).toBe("cell-001");
    expect(entry.newSource).toBe("x = 1");
    expect(entry.client).toBe("test-agent");
    expect(entry.timestamp).toBeTruthy();
    // timestamp should be ISO-8601
    expect(() => new Date(entry.timestamp)).not.toThrow();
  });

  it("prunes oldest entries when exceeding maxEntries", () => {
    const tracker = getTracker(PATH);
    tracker.maxEntries = 5;

    for (let i = 0; i < 8; i++) {
      recordChange(PATH, {
        operation: "update",
        cellId: `cell-${i}`,
        cellIdShort: `cell-${i}`,
        cellIndex: i,
        newSource: `v${i}`,
      });
    }

    expect(tracker.changes).toHaveLength(5);
    // oldest 3 should be pruned — remaining are versions 4,5,6,7,8
    expect(tracker.changes[0].version).toBe(4);
    expect(tracker.changes[4].version).toBe(8);
  });

  it("stores optional detail field", () => {
    recordChange(PATH, {
      operation: "move",
      cellId: "cell-x",
      cellIdShort: "cell-x",
      cellIndex: 5,
      detail: "moved from index 2 to 5",
    });

    const tracker = getTracker(PATH);
    expect(tracker.changes[0].detail).toBe("moved from index 2 to 5");
  });

  it("records copy operations with source attribution", () => {
    recordChange(PATH, {
      operation: "copy",
      cellId: "new-cell-uuid",
      cellIdShort: "new-cell",
      cellIndex: 3,
      newSource: "def lorenz(): ...",
      client: "analysis-agent",
      detail: "copied from lorenz_simulation.ipynb",
    });

    const tracker = getTracker(PATH);
    expect(tracker.changes).toHaveLength(1);
    const entry = tracker.changes[0];
    expect(entry.operation).toBe("copy");
    expect(entry.client).toBe("analysis-agent");
    expect(entry.detail).toBe("copied from lorenz_simulation.ipynb");
    expect(entry.newSource).toBe("def lorenz(): ...");
    expect(entry.oldSource).toBeUndefined();
  });
});

describe("getCellHistory", () => {
  beforeEach(() => {
    recordChange(PATH, {
      operation: "insert",
      cellId: "abc12345-full-uuid",
      cellIdShort: "abc12345",
      cellIndex: 0,
      newSource: "v1",
    });
    recordChange(PATH, {
      operation: "update",
      cellId: "abc12345-full-uuid",
      cellIdShort: "abc12345",
      cellIndex: 0,
      oldSource: "v1",
      newSource: "v2",
    });
    recordChange(PATH, {
      operation: "insert",
      cellId: "def67890-full-uuid",
      cellIdShort: "def67890",
      cellIndex: 1,
      newSource: "other cell",
    });
    recordChange(PATH, {
      operation: "update",
      cellId: "abc12345-full-uuid",
      cellIdShort: "abc12345",
      cellIndex: 0,
      oldSource: "v2",
      newSource: "v3",
    });
  });

  it("returns changes for a specific cell by full ID prefix", () => {
    const history = getCellHistory(PATH, "abc12345-full-uuid");
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.operation)).toEqual(["insert", "update", "update"]);
  });

  it("matches by short ID prefix", () => {
    const history = getCellHistory(PATH, "abc12345");
    expect(history).toHaveLength(3);
  });

  it("matches by even shorter prefix", () => {
    const history = getCellHistory(PATH, "abc");
    expect(history).toHaveLength(3);
  });

  it("returns empty for non-matching ID", () => {
    const history = getCellHistory(PATH, "zzz");
    expect(history).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    const history = getCellHistory(PATH, "abc12345", 2);
    expect(history).toHaveLength(2);
    // should return the most recent 2
    expect(history[0].newSource).toBe("v2");
    expect(history[1].newSource).toBe("v3");
  });

  it("matches via cellIdShort when full cellId does not match", () => {
    clearTracker(PATH);
    recordChange(PATH, {
      operation: "insert",
      cellId: "zzz-full-id",
      cellIdShort: "abc12345",
      cellIndex: 0,
      newSource: "found via short",
    });

    // "abc" doesn't match "zzz-full-id" but does match cellIdShort "abc12345"
    const history = getCellHistory(PATH, "abc");
    expect(history).toHaveLength(1);
    expect(history[0].newSource).toBe("found via short");
  });

  it("returns empty for non-existent notebook", () => {
    const history = getCellHistory("nonexistent.ipynb", "abc");
    expect(history).toHaveLength(0);
  });
});

describe("getChangesSince", () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) {
      recordChange(PATH, {
        operation: "insert",
        cellId: `cell-${i}`,
        cellIdShort: `cell-${i}`,
        cellIndex: i,
        newSource: `code ${i}`,
      });
    }
  });

  it("returns all changes since version 0", () => {
    const result = getChangesSince(PATH, 0);
    expect(result.changes).toHaveLength(5);
    expect(result.currentVersion).toBe(5);
  });

  it("returns changes after a specific version", () => {
    const result = getChangesSince(PATH, 3);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].version).toBe(4);
    expect(result.changes[1].version).toBe(5);
  });

  it("returns empty when no new changes", () => {
    const result = getChangesSince(PATH, 5);
    expect(result.changes).toHaveLength(0);
    expect(result.currentVersion).toBe(5);
  });

  it("respects limit", () => {
    const result = getChangesSince(PATH, 0, 2);
    expect(result.changes).toHaveLength(2);
    // should return the most recent 2
    expect(result.changes[0].version).toBe(4);
    expect(result.changes[1].version).toBe(5);
  });

  it("creates tracker for non-existent notebook", () => {
    const result = getChangesSince("new.ipynb", 0);
    expect(result.changes).toHaveLength(0);
    expect(result.currentVersion).toBe(0);
    clearTracker("new.ipynb");
  });
});

describe("getCurrentVersion", () => {
  it("returns 0 for new notebook", () => {
    expect(getCurrentVersion(PATH)).toBe(0);
  });

  it("tracks version after changes", () => {
    recordChange(PATH, {
      operation: "insert",
      cellId: "c1",
      cellIdShort: "c1",
      cellIndex: 0,
    });
    expect(getCurrentVersion(PATH)).toBe(1);

    recordChange(PATH, {
      operation: "insert",
      cellId: "c2",
      cellIdShort: "c2",
      cellIndex: 1,
    });
    expect(getCurrentVersion(PATH)).toBe(2);
  });
});

describe("clearTracker", () => {
  it("removes tracker for a path", () => {
    recordChange(PATH, {
      operation: "insert",
      cellId: "c1",
      cellIdShort: "c1",
      cellIndex: 0,
    });
    expect(getCurrentVersion(PATH)).toBe(1);

    clearTracker(PATH);
    expect(getCurrentVersion(PATH)).toBe(0);
  });

  it("does nothing for non-existent path", () => {
    clearTracker("nonexistent.ipynb");
    // should not throw
  });
});

describe("getChangeSummary", () => {
  it("returns summary of recent changes", () => {
    recordChange(PATH, {
      operation: "insert",
      cellId: "c1",
      cellIdShort: "c1",
      cellIndex: 0,
    });
    recordChange(PATH, {
      operation: "update",
      cellId: "c1",
      cellIdShort: "c1",
      cellIndex: 0,
    });
    recordChange(PATH, {
      operation: "insert",
      cellId: "c2",
      cellIdShort: "c2",
      cellIndex: 1,
    });

    const summary = getChangeSummary(PATH);
    expect(summary.currentVersion).toBe(3);
    expect(summary.recentChanges).toHaveLength(3);
    expect(summary.cellsModified).toBe(2); // c1 and c2
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      recordChange(PATH, {
        operation: "insert",
        cellId: `cell-${i}`,
        cellIdShort: `cell-${i}`,
        cellIndex: i,
      });
    }

    const summary = getChangeSummary(PATH, 3);
    expect(summary.recentChanges).toHaveLength(3);
    expect(summary.currentVersion).toBe(10);
    expect(summary.cellsModified).toBe(3);
  });
});

describe("getDeletedCellSource", () => {
  it("returns source of a deleted cell", () => {
    recordChange(PATH, {
      operation: "insert",
      cellId: "abc12345",
      cellIdShort: "abc12345",
      cellIndex: 0,
      newSource: "original code",
    });
    recordChange(PATH, {
      operation: "delete",
      cellId: "abc12345",
      cellIdShort: "abc12345",
      cellIndex: 0,
      oldSource: "original code",
    });

    const result = getDeletedCellSource(PATH, "abc12345");
    expect(result).toBeDefined();
    expect(result!.source).toBe("original code");
    expect(result!.deletedAt).toBeTruthy();
  });

  it("returns undefined for non-deleted cell", () => {
    recordChange(PATH, {
      operation: "insert",
      cellId: "abc12345",
      cellIdShort: "abc12345",
      cellIndex: 0,
      newSource: "still alive",
    });

    const result = getDeletedCellSource(PATH, "abc12345");
    expect(result).toBeUndefined();
  });

  it("returns the most recent delete event", () => {
    recordChange(PATH, {
      operation: "delete",
      cellId: "abc12345",
      cellIdShort: "abc12345",
      cellIndex: 0,
      oldSource: "first version",
    });
    recordChange(PATH, {
      operation: "insert",
      cellId: "abc12345",
      cellIdShort: "abc12345",
      cellIndex: 0,
      newSource: "recovered",
    });
    recordChange(PATH, {
      operation: "delete",
      cellId: "abc12345",
      cellIdShort: "abc12345",
      cellIndex: 0,
      oldSource: "recovered",
    });

    const result = getDeletedCellSource(PATH, "abc12345");
    expect(result!.source).toBe("recovered");
  });

  it("returns undefined when delete has no oldSource", () => {
    recordChange(PATH, {
      operation: "delete",
      cellId: "abc12345",
      cellIdShort: "abc12345",
      cellIndex: 0,
      // oldSource intentionally omitted
    });

    const result = getDeletedCellSource(PATH, "abc12345");
    expect(result).toBeUndefined();
  });

  it("matches by full cellId prefix", () => {
    recordChange(PATH, {
      operation: "delete",
      cellId: "abc12345-long-uuid",
      cellIdShort: "abc12345",
      cellIndex: 0,
      oldSource: "deleted code",
    });

    const result = getDeletedCellSource(PATH, "abc12345-long");
    expect(result).toBeDefined();
    expect(result!.source).toBe("deleted code");
  });

  it("matches by cellIdShort when full cellId does not match", () => {
    recordChange(PATH, {
      operation: "delete",
      cellId: "xyz99999-long-uuid",
      cellIdShort: "abc12345",
      cellIndex: 0,
      oldSource: "found via short id",
    });

    // "abc" doesn't match "xyz99999-long-uuid" but does match "abc12345"
    const result = getDeletedCellSource(PATH, "abc");
    expect(result).toBeDefined();
    expect(result!.source).toBe("found via short id");
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

function makeChange(overrides: Partial<Omit<import("./cell-tracker.js").CellChange, "version" | "timestamp">> = {}) {
  return {
    operation: "update" as const,
    cellId: "cell-1-full-uuid",
    cellIdShort: "cell-1-f",
    cellIndex: 0,
    oldSource: "old",
    newSource: "new",
    client: "test-agent",
    ...overrides,
  };
}

describe("Yjs backend — recordChange", () => {
  it("records a change and increments version", () => {
    const doc = new Y.Doc();
    const v1 = recordChange(PATH, makeChange(), doc);
    expect(v1).toBe(1);
    const v2 = recordChange(PATH, makeChange({ cellIndex: 1 }), doc);
    expect(v2).toBe(2);
  });

  it("stores changes retrievable via getChangesSince", () => {
    const doc = new Y.Doc();
    recordChange(PATH, makeChange(), doc);
    recordChange(PATH, makeChange({ operation: "insert" }), doc);
    const { changes, currentVersion } = getChangesSince(PATH, 0, 50, doc);
    expect(currentVersion).toBe(2);
    expect(changes).toHaveLength(2);
    expect(changes[0].operation).toBe("update");
    expect(changes[1].operation).toBe("insert");
  });
});

describe("Yjs backend — getCellHistory", () => {
  it("filters by cell ID prefix", () => {
    const doc = new Y.Doc();
    recordChange(PATH, makeChange({ cellId: "aaa-111", cellIdShort: "aaa-111" }), doc);
    recordChange(PATH, makeChange({ cellId: "bbb-222", cellIdShort: "bbb-222" }), doc);
    recordChange(PATH, makeChange({ cellId: "aaa-111", cellIdShort: "aaa-111", operation: "delete" }), doc);

    const history = getCellHistory(PATH, "aaa", 20, doc);
    expect(history).toHaveLength(2);
    expect(history[0].operation).toBe("update");
    expect(history[1].operation).toBe("delete");
  });

  it("respects limit", () => {
    const doc = new Y.Doc();
    for (let i = 0; i < 10; i++) {
      recordChange(PATH, makeChange(), doc);
    }
    const history = getCellHistory(PATH, "cell-1", 3, doc);
    expect(history).toHaveLength(3);
  });
});

describe("Yjs backend — getChangesSince", () => {
  it("filters by version", () => {
    const doc = new Y.Doc();
    recordChange(PATH, makeChange(), doc); // v1
    recordChange(PATH, makeChange(), doc); // v2
    recordChange(PATH, makeChange(), doc); // v3

    const { changes } = getChangesSince(PATH, 1, 50, doc);
    expect(changes).toHaveLength(2);
    expect(changes[0].version).toBe(2);
    expect(changes[1].version).toBe(3);
  });
});

describe("Yjs backend — getCurrentVersion", () => {
  it("returns 0 for fresh doc", () => {
    const doc = new Y.Doc();
    expect(getCurrentVersion(PATH, doc)).toBe(0);
  });

  it("returns latest version", () => {
    const doc = new Y.Doc();
    recordChange(PATH, makeChange(), doc);
    recordChange(PATH, makeChange(), doc);
    expect(getCurrentVersion(PATH, doc)).toBe(2);
  });
});

describe("Yjs backend — clearTracker", () => {
  it("clears all tracking data", () => {
    const doc = new Y.Doc();
    recordChange(PATH, makeChange(), doc);
    clearTracker(PATH, doc);
    expect(getCurrentVersion(PATH, doc)).toBe(0);
    const { changes } = getChangesSince(PATH, 0, 50, doc);
    expect(changes).toHaveLength(0);
  });
});

describe("Yjs backend — getChangeSummary", () => {
  it("returns recent changes and cell count", () => {
    const doc = new Y.Doc();
    recordChange(PATH, makeChange({ cellId: "a" }), doc);
    recordChange(PATH, makeChange({ cellId: "b" }), doc);
    recordChange(PATH, makeChange({ cellId: "a" }), doc);

    const summary = getChangeSummary(PATH, 20, doc);
    expect(summary.currentVersion).toBe(3);
    expect(summary.recentChanges).toHaveLength(3);
    expect(summary.cellsModified).toBe(2);
  });
});

describe("Yjs backend — getDeletedCellSource", () => {
  it("finds deleted cell source", () => {
    const doc = new Y.Doc();
    recordChange(PATH, makeChange({ operation: "delete", cellId: "del-cell", cellIdShort: "del-cell", oldSource: "deleted code", newSource: undefined }), doc);
    const result = getDeletedCellSource(PATH, "del", doc);
    expect(result).toBeDefined();
    expect(result!.source).toBe("deleted code");
  });

  it("returns undefined when no delete found", () => {
    const doc = new Y.Doc();
    recordChange(PATH, makeChange(), doc);
    expect(getDeletedCellSource(PATH, "nonexistent", doc)).toBeUndefined();
  });
});

describe("Yjs backend — cross-instance sync", () => {
  it("change on doc1 visible on doc2", () => {
    const [doc1, doc2] = createSyncedDocs();
    recordChange(PATH, makeChange(), doc1);
    const { changes, currentVersion } = getChangesSince(PATH, 0, 50, doc2);
    expect(currentVersion).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0].client).toBe("test-agent");
  });

  it("changes from both docs merge", () => {
    const [doc1, doc2] = createSyncedDocs();
    recordChange(PATH, makeChange({ client: "agent-1" }), doc1);
    recordChange(PATH, makeChange({ client: "agent-2" }), doc2);

    const { changes: c1 } = getChangesSince(PATH, 0, 50, doc1);
    const { changes: c2 } = getChangesSince(PATH, 0, 50, doc2);
    // Both docs should see both changes
    expect(c1.length).toBeGreaterThanOrEqual(2);
    expect(c2.length).toBeGreaterThanOrEqual(2);
  });

  it("deleted cell source recoverable cross-instance", () => {
    const [doc1, doc2] = createSyncedDocs();
    recordChange(PATH, makeChange({ operation: "delete", cellId: "del-x", cellIdShort: "del-x", oldSource: "recover me" }), doc1);
    const result = getDeletedCellSource(PATH, "del-x", doc2);
    expect(result).toBeDefined();
    expect(result!.source).toBe("recover me");
  });
});

describe("Yjs backend — pruning", () => {
  it("prunes when over 2x limit", () => {
    const doc = new Y.Doc();
    // YJS_MAX_ENTRIES = 1000, prune threshold = 2000
    for (let i = 0; i < 2005; i++) {
      recordChange(PATH, makeChange({ cellIndex: i }), doc);
    }
    const { changes } = getChangesSince(PATH, 0, 5000, doc);
    // After pruning, should have ~1000 entries
    expect(changes.length).toBeLessThanOrEqual(1005);
    expect(changes.length).toBeGreaterThan(0);
    // Latest version should still be correct
    expect(getCurrentVersion(PATH, doc)).toBe(2005);
  });
});
