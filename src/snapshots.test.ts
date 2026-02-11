import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  createSnapshot,
  getSnapshot,
  listSnapshots,
  deleteSnapshot,
  restoreSnapshotToYjs,
  restoreSnapshotToFs,
  diffSnapshot,
} from "./snapshots.js";

const PATH = "test-notebook.ipynb";

/**
 * Helper: create a Y.Doc with cells for testing.
 */
function createYjsNotebook(
  cellDefs: { id: string; type: string; source: string; metadata?: Record<string, any> }[]
): { doc: Y.Doc; cells: Y.Array<any> } {
  const doc = new Y.Doc();
  const cells = doc.getArray("cells");

  doc.transact(() => {
    for (const def of cellDefs) {
      const cell = new Y.Map();
      cell.set("id", def.id);
      cell.set("cell_type", def.type);
      cell.set("source", new Y.Text(def.source));

      const meta = new Y.Map();
      if (def.metadata) {
        for (const [k, v] of Object.entries(def.metadata)) {
          meta.set(k, v);
        }
      }
      cell.set("metadata", meta);

      if (def.type === "code") {
        cell.set("outputs", new Y.Array());
        cell.set("execution_count", null);
      }

      cells.push([cell]);
    }
  });

  return { doc, cells };
}

/**
 * Helper: create plain object cells (filesystem mode).
 */
function createPlainCells(
  cellDefs: { id: string; cell_type: string; source: string; metadata?: Record<string, any> }[]
): any[] {
  return cellDefs.map((def) => ({
    id: def.id,
    cell_type: def.cell_type,
    source: def.source,
    metadata: def.metadata || {},
    ...(def.cell_type === "code" ? { outputs: [], execution_count: null } : {}),
  }));
}

// Clean up snapshots between tests
beforeEach(() => {
  // Delete any leftover snapshots
  for (const snap of listSnapshots(PATH)) {
    deleteSnapshot(PATH, snap.name);
  }
  for (const snap of listSnapshots("other.ipynb")) {
    deleteSnapshot("other.ipynb", snap.name);
  }
});

describe("createSnapshot", () => {
  it("captures Yjs cells", () => {
    const { cells } = createYjsNotebook([
      { id: "cell-1", type: "code", source: "x = 1" },
      { id: "cell-2", type: "markdown", source: "# Header" },
    ]);

    const snap = createSnapshot(PATH, "v1", cells, "initial version");

    expect(snap.name).toBe("v1");
    expect(snap.path).toBe(PATH);
    expect(snap.description).toBe("initial version");
    expect(snap.cells).toHaveLength(2);
    expect(snap.cells[0].id).toBe("cell-1");
    expect(snap.cells[0].cell_type).toBe("code");
    expect(snap.cells[0].source).toBe("x = 1");
    expect(snap.cells[1].id).toBe("cell-2");
    expect(snap.cells[1].source).toBe("# Header");
    expect(snap.createdAt).toBeTruthy();
  });

  it("captures plain object cells", () => {
    const cells = createPlainCells([
      { id: "cell-1", cell_type: "code", source: "y = 2", metadata: { tags: ["test"] } },
    ]);

    const snap = createSnapshot(PATH, "v1", cells);

    expect(snap.cells).toHaveLength(1);
    expect(snap.cells[0].source).toBe("y = 2");
    expect(snap.cells[0].metadata).toEqual({ tags: ["test"] });
  });

  it("overwrites existing snapshot with same name", () => {
    const cells1 = createPlainCells([{ id: "c1", cell_type: "code", source: "v1" }]);
    const cells2 = createPlainCells([{ id: "c1", cell_type: "code", source: "v2" }]);

    createSnapshot(PATH, "test", cells1);
    createSnapshot(PATH, "test", cells2);

    const snap = getSnapshot(PATH, "test");
    expect(snap!.cells[0].source).toBe("v2");
  });

  it("uses fallback ID when cell has no id", () => {
    const doc = new Y.Doc();
    const cells = doc.getArray("cells");
    doc.transact(() => {
      const cell = new Y.Map();
      cell.set("cell_type", "code");
      cell.set("source", new Y.Text("no id cell"));
      cell.set("metadata", new Y.Map());
      // deliberately NOT setting "id"
      cells.push([cell]);
    });

    const snap = createSnapshot(PATH, "no-id", cells);
    expect(snap.cells[0].id).toBe("unknown-0");
  });

  it("handles Yjs cell with non-YMap metadata", () => {
    const doc = new Y.Doc();
    const cells = doc.getArray("cells");
    doc.transact(() => {
      const cell = new Y.Map();
      cell.set("id", "c1");
      cell.set("cell_type", "code");
      cell.set("source", new Y.Text("x"));
      // Set metadata as a plain string instead of Y.Map
      cell.set("metadata", "not-a-map");
      cells.push([cell]);
    });

    const snap = createSnapshot(PATH, "bad-meta", cells);
    // Should fall through to empty metadata since it's not a Y.Map
    expect(snap.cells[0].metadata).toEqual({});
  });

  it("captures Yjs metadata", () => {
    const { cells } = createYjsNotebook([
      { id: "c1", type: "code", source: "x = 1", metadata: { trusted: true, custom: "value" } },
    ]);

    const snap = createSnapshot(PATH, "meta-test", cells);
    expect(snap.cells[0].metadata).toEqual({ trusted: true, custom: "value" });
  });
});

describe("getSnapshot", () => {
  it("returns snapshot by name", () => {
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);
    createSnapshot(PATH, "my-snap", cells);

    const snap = getSnapshot(PATH, "my-snap");
    expect(snap).toBeDefined();
    expect(snap!.name).toBe("my-snap");
  });

  it("returns undefined for non-existent snapshot", () => {
    expect(getSnapshot(PATH, "nope")).toBeUndefined();
  });

  it("differentiates snapshots by path", () => {
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);
    createSnapshot(PATH, "snap", cells);

    expect(getSnapshot("other.ipynb", "snap")).toBeUndefined();
  });
});

describe("listSnapshots", () => {
  it("returns empty for notebook with no snapshots", () => {
    expect(listSnapshots(PATH)).toEqual([]);
  });

  it("returns snapshots sorted by creation time", () => {
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);
    createSnapshot(PATH, "second", cells);
    createSnapshot(PATH, "first", cells);

    const list = listSnapshots(PATH);
    expect(list).toHaveLength(2);
    // Both created almost simultaneously, so order depends on timestamp precision
    // but they should all be present
    const names = list.map((s) => s.name);
    expect(names).toContain("first");
    expect(names).toContain("second");
  });

  it("only returns snapshots for the requested path", () => {
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);
    createSnapshot(PATH, "snap-a", cells);
    createSnapshot("other.ipynb", "snap-b", cells);

    expect(listSnapshots(PATH)).toHaveLength(1);
    expect(listSnapshots("other.ipynb")).toHaveLength(1);
  });
});

describe("deleteSnapshot", () => {
  it("deletes an existing snapshot", () => {
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);
    createSnapshot(PATH, "doomed", cells);

    expect(deleteSnapshot(PATH, "doomed")).toBe(true);
    expect(getSnapshot(PATH, "doomed")).toBeUndefined();
  });

  it("returns false for non-existent snapshot", () => {
    expect(deleteSnapshot(PATH, "nope")).toBe(false);
  });
});

describe("restoreSnapshotToYjs", () => {
  it("replaces all cells in the Y.Doc", () => {
    // Create initial notebook with 2 cells
    const { doc, cells } = createYjsNotebook([
      { id: "old-1", type: "code", source: "old code 1" },
      { id: "old-2", type: "markdown", source: "old text" },
    ]);

    // Create a snapshot with different cells
    const snapCells = createPlainCells([
      { id: "snap-1", cell_type: "code", source: "restored code" },
      { id: "snap-2", cell_type: "code", source: "restored code 2" },
      { id: "snap-3", cell_type: "markdown", source: "restored text" },
    ]);
    const snap = createSnapshot(PATH, "restore-test", snapCells);

    // Restore
    const count = restoreSnapshotToYjs(snap, cells, doc);
    expect(count).toBe(3);
    expect(cells.length).toBe(3);

    // Verify restored cells
    const cell0 = cells.get(0) as Y.Map<any>;
    expect(cell0.get("id")).toBe("snap-1");
    expect(cell0.get("cell_type")).toBe("code");
    expect(cell0.get("source").toString()).toBe("restored code");
    expect(cell0.get("outputs")).toBeInstanceOf(Y.Array);
    expect(cell0.get("execution_count")).toBeNull();

    const cell2 = cells.get(2) as Y.Map<any>;
    expect(cell2.get("id")).toBe("snap-3");
    expect(cell2.get("cell_type")).toBe("markdown");
  });

  it("restores metadata", () => {
    const { doc, cells } = createYjsNotebook([]);
    const snapCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x", metadata: { tags: ["important"] } },
    ]);
    const snap = createSnapshot(PATH, "meta-restore", snapCells);

    restoreSnapshotToYjs(snap, cells, doc);

    const meta = (cells.get(0) as Y.Map<any>).get("metadata") as Y.Map<any>;
    expect(meta.get("tags")).toEqual(["important"]);
  });

  it("handles empty snapshot", () => {
    const { doc, cells } = createYjsNotebook([
      { id: "c1", type: "code", source: "will be removed" },
    ]);
    const snap = createSnapshot(PATH, "empty-snap", []);

    const count = restoreSnapshotToYjs(snap, cells, doc);
    expect(count).toBe(0);
    expect(cells.length).toBe(0);
  });
});

describe("restoreSnapshotToFs", () => {
  it("returns plain cell objects from snapshot", () => {
    const cells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1", metadata: { trusted: true } },
      { id: "c2", cell_type: "markdown", source: "# Title" },
    ]);
    const snap = createSnapshot(PATH, "fs-test", cells);

    const restored = restoreSnapshotToFs(snap);
    expect(restored).toHaveLength(2);

    expect(restored[0].cell_type).toBe("code");
    expect(restored[0].source).toBe("x = 1");
    expect(restored[0].id).toBe("c1");
    expect(restored[0].outputs).toEqual([]);
    expect(restored[0].execution_count).toBeNull();
    expect(restored[0].metadata).toEqual({ trusted: true });

    expect(restored[1].cell_type).toBe("markdown");
    expect(restored[1].outputs).toBeUndefined();
  });
});

describe("diffSnapshot", () => {
  it("detects no changes when identical", () => {
    const cells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1" },
      { id: "c2", cell_type: "code", source: "y = 2" },
    ]);
    const snap = createSnapshot(PATH, "baseline", cells);

    const diff = diffSnapshot(snap, cells);
    expect(diff.added).toBe(0);
    expect(diff.deleted).toBe(0);
    expect(diff.modified).toBe(0);
    expect(diff.unchanged).toBe(2);
  });

  it("detects modified cells", () => {
    const originalCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1" },
    ]);
    const snap = createSnapshot(PATH, "before", originalCells);

    const modifiedCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 999" },
    ]);

    const diff = diffSnapshot(snap, modifiedCells);
    expect(diff.modified).toBe(1);
    expect(diff.unchanged).toBe(0);
    expect(diff.details[0]).toEqual({
      cellId: "c1",
      status: "modified",
      oldSource: "x = 1",
      newSource: "x = 999",
    });
  });

  it("detects deleted cells", () => {
    const originalCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1" },
      { id: "c2", cell_type: "code", source: "y = 2" },
    ]);
    const snap = createSnapshot(PATH, "before-delete", originalCells);

    const currentCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1" },
    ]);

    const diff = diffSnapshot(snap, currentCells);
    expect(diff.deleted).toBe(1);
    expect(diff.unchanged).toBe(1);
    expect(diff.details.find((d) => d.status === "deleted")!.cellId).toBe("c2");
  });

  it("detects added cells", () => {
    const originalCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1" },
    ]);
    const snap = createSnapshot(PATH, "before-add", originalCells);

    const currentCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1" },
      { id: "c3", cell_type: "code", source: "z = 3" },
    ]);

    const diff = diffSnapshot(snap, currentCells);
    expect(diff.added).toBe(1);
    expect(diff.unchanged).toBe(1);
    const addedDetail = diff.details.find((d) => d.status === "added")!;
    expect(addedDetail.cellId).toBe("c3");
    expect(addedDetail.newSource).toBe("z = 3");
  });

  it("handles complex mixed changes", () => {
    const originalCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "keep" },
      { id: "c2", cell_type: "code", source: "modify me" },
      { id: "c3", cell_type: "code", source: "delete me" },
    ]);
    const snap = createSnapshot(PATH, "complex", originalCells);

    const currentCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "keep" },
      { id: "c2", cell_type: "code", source: "modified!" },
      { id: "c4", cell_type: "code", source: "new cell" },
    ]);

    const diff = diffSnapshot(snap, currentCells);
    expect(diff.unchanged).toBe(1);
    expect(diff.modified).toBe(1);
    expect(diff.deleted).toBe(1);
    expect(diff.added).toBe(1);
  });

  it("works with Yjs cells as current state", () => {
    const plainCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "original" },
    ]);
    const snap = createSnapshot(PATH, "yjs-diff", plainCells);

    const { cells: yjsCells } = createYjsNotebook([
      { id: "c1", type: "code", source: "changed" },
    ]);

    const diff = diffSnapshot(snap, yjsCells);
    expect(diff.modified).toBe(1);
  });

  it("handles empty snapshot vs non-empty current", () => {
    const snap = createSnapshot(PATH, "empty", []);
    const currentCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "new" },
    ]);

    const diff = diffSnapshot(snap, currentCells);
    expect(diff.added).toBe(1);
    expect(diff.deleted).toBe(0);
  });

  it("uses fallback IDs for cells without id in current state", () => {
    const originalCells = createPlainCells([
      { id: "unknown-0", cell_type: "code", source: "same" },
    ]);
    const snap = createSnapshot(PATH, "fallback-test", originalCells);

    // Create Yjs cells without id field
    const doc = new Y.Doc();
    const cells = doc.getArray("cells");
    doc.transact(() => {
      const cell = new Y.Map();
      cell.set("cell_type", "code");
      cell.set("source", new Y.Text("same"));
      cell.set("metadata", new Y.Map());
      // No "id" set — will get "unknown-0"
      cells.push([cell]);
    });

    const diff = diffSnapshot(snap, cells);
    expect(diff.unchanged).toBe(1);
    expect(diff.modified).toBe(0);
  });

  it("handles non-empty snapshot vs empty current", () => {
    const originalCells = createPlainCells([
      { id: "c1", cell_type: "code", source: "old" },
    ]);
    const snap = createSnapshot(PATH, "full", originalCells);

    const diff = diffSnapshot(snap, []);
    expect(diff.deleted).toBe(1);
    expect(diff.added).toBe(0);
  });
});

// ============================================================================
// Yjs backend tests
// ============================================================================

function createSyncedDocs(): [Y.Doc, Y.Doc] {
  const doc1 = new Y.Doc();
  const doc2 = new Y.Doc();
  doc1.on("update", (update: Uint8Array) => Y.applyUpdate(doc2, update));
  doc2.on("update", (update: Uint8Array) => Y.applyUpdate(doc1, update));
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
  return [doc1, doc2];
}

describe("Yjs backend — createSnapshot", () => {
  it("stores snapshot in Yjs doc", () => {
    const doc = new Y.Doc();
    const cells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1" },
    ]);

    const snap = createSnapshot(PATH, "v1", cells, "test desc", doc);
    expect(snap.name).toBe("v1");
    expect(snap.description).toBe("test desc");
    expect(snap.cells).toHaveLength(1);
  });

  it("overwrites existing snapshot with same name", () => {
    const doc = new Y.Doc();
    const cells1 = createPlainCells([{ id: "c1", cell_type: "code", source: "v1" }]);
    const cells2 = createPlainCells([{ id: "c1", cell_type: "code", source: "v2" }]);

    createSnapshot(PATH, "test", cells1, undefined, doc);
    createSnapshot(PATH, "test", cells2, undefined, doc);

    const snap = getSnapshot(PATH, "test", doc);
    expect(snap!.cells[0].source).toBe("v2");
  });

  it("enforces cap of 20 snapshots", () => {
    const doc = new Y.Doc();
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);

    // Create 25 snapshots
    for (let i = 0; i < 25; i++) {
      createSnapshot(PATH, `snap-${i}`, cells, undefined, doc);
    }

    const list = listSnapshots(PATH, doc);
    expect(list.length).toBeLessThanOrEqual(20);
    // Oldest should have been pruned — snap-0 through snap-4
    const names = list.map((s) => s.name);
    expect(names).not.toContain("snap-0");
    expect(names).toContain("snap-24");
  });
});

describe("Yjs backend — getSnapshot", () => {
  it("returns snapshot by name from Yjs", () => {
    const doc = new Y.Doc();
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);
    createSnapshot(PATH, "my-snap", cells, undefined, doc);

    const snap = getSnapshot(PATH, "my-snap", doc);
    expect(snap).toBeDefined();
    expect(snap!.name).toBe("my-snap");
    expect(snap!.cells[0].source).toBe("x");
  });

  it("returns undefined for non-existent snapshot", () => {
    const doc = new Y.Doc();
    expect(getSnapshot(PATH, "nope", doc)).toBeUndefined();
  });

  it("JSON round-trip preserves all fields", () => {
    const doc = new Y.Doc();
    const cells = createPlainCells([
      { id: "c1", cell_type: "code", source: "x = 1", metadata: { tags: ["important"], trusted: true } },
      { id: "c2", cell_type: "markdown", source: "# Header", metadata: {} },
    ]);
    createSnapshot(PATH, "full", cells, "detailed description", doc);

    const snap = getSnapshot(PATH, "full", doc);
    expect(snap!.name).toBe("full");
    expect(snap!.path).toBe(PATH);
    expect(snap!.description).toBe("detailed description");
    expect(snap!.createdAt).toBeTruthy();
    expect(snap!.cells).toHaveLength(2);
    expect(snap!.cells[0].id).toBe("c1");
    expect(snap!.cells[0].cell_type).toBe("code");
    expect(snap!.cells[0].source).toBe("x = 1");
    expect(snap!.cells[0].metadata).toEqual({ tags: ["important"], trusted: true });
    expect(snap!.cells[1].id).toBe("c2");
    expect(snap!.cells[1].cell_type).toBe("markdown");
    expect(snap!.cells[1].source).toBe("# Header");
  });
});

describe("Yjs backend — listSnapshots", () => {
  it("returns empty when no snapshots", () => {
    const doc = new Y.Doc();
    expect(listSnapshots(PATH, doc)).toEqual([]);
  });

  it("returns all snapshots sorted by creation time", () => {
    const doc = new Y.Doc();
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);
    createSnapshot(PATH, "b", cells, undefined, doc);
    createSnapshot(PATH, "a", cells, undefined, doc);

    const list = listSnapshots(PATH, doc);
    expect(list).toHaveLength(2);
    const names = list.map((s) => s.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });
});

describe("Yjs backend — deleteSnapshot", () => {
  it("deletes an existing snapshot", () => {
    const doc = new Y.Doc();
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);
    createSnapshot(PATH, "doomed", cells, undefined, doc);

    expect(deleteSnapshot(PATH, "doomed", doc)).toBe(true);
    expect(getSnapshot(PATH, "doomed", doc)).toBeUndefined();
  });

  it("returns false for non-existent snapshot", () => {
    const doc = new Y.Doc();
    expect(deleteSnapshot(PATH, "nope", doc)).toBe(false);
  });
});

describe("Yjs backend — cross-instance sync", () => {
  it("snapshot on doc1 is retrievable on doc2", () => {
    const [doc1, doc2] = createSyncedDocs();
    const cells = createPlainCells([
      { id: "c1", cell_type: "code", source: "shared data" },
    ]);

    createSnapshot(PATH, "shared", cells, "cross-instance", doc1);

    const snap = getSnapshot(PATH, "shared", doc2);
    expect(snap).toBeDefined();
    expect(snap!.cells[0].source).toBe("shared data");
    expect(snap!.description).toBe("cross-instance");
  });

  it("list on doc2 shows snapshots from doc1", () => {
    const [doc1, doc2] = createSyncedDocs();
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);

    createSnapshot(PATH, "snap-1", cells, undefined, doc1);
    createSnapshot(PATH, "snap-2", cells, undefined, doc1);

    const list = listSnapshots(PATH, doc2);
    expect(list).toHaveLength(2);
  });

  it("delete on doc1 removes from doc2", () => {
    const [doc1, doc2] = createSyncedDocs();
    const cells = createPlainCells([{ id: "c1", cell_type: "code", source: "x" }]);

    createSnapshot(PATH, "temp", cells, undefined, doc1);
    expect(getSnapshot(PATH, "temp", doc2)).toBeDefined();

    deleteSnapshot(PATH, "temp", doc1);
    expect(getSnapshot(PATH, "temp", doc2)).toBeUndefined();
  });
});
