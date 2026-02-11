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
