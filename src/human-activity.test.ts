import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  trackHumanActivity,
  recentHumanEditInCell,
  stopHumanActivity,
} from "./human-activity.js";
import { checkHumanFocus } from "./helpers.js";

/** Build a Y.Doc with the given cells (id + source). */
function makeDoc(cells: { id: string; source: string }[]): {
  doc: Y.Doc;
  cells: Y.Array<any>;
} {
  const doc = new Y.Doc();
  const arr = doc.getArray("cells");
  doc.transact(() => {
    for (const c of cells) {
      const cell = new Y.Map();
      cell.set("id", c.id);
      cell.set("cell_type", "code");
      cell.set("source", new Y.Text(c.source));
      arr.push([cell]);
    }
  });
  return { doc, cells: arr };
}

function sourceOf(cells: Y.Array<any>, i: number): Y.Text {
  return (cells.get(i) as Y.Map<any>).get("source") as Y.Text;
}

/** A minimal fake provider whose awareness reports one human collaborator
 *  with a cursor in `cursorCell`. The provider object doubles as the
 *  transaction origin for "remote" (human) edits. */
function makeProvider(doc: Y.Doc, cursorCell: number | null) {
  const cells = doc.getArray("cells");
  const states = new Map<number, any>();
  const provider: any = {
    awareness: { clientID: 1, getStates: () => states },
  };
  const state: any = { user: { display_name: "Alice", username: "alice" } };
  if (cursorCell != null) {
    const head = Y.createRelativePositionFromTypeIndex(
      sourceOf(cells, cursorCell),
      0
    );
    state.cursors = [{ head }];
  }
  states.set(2, state); // human at clientId 2 (≠ our clientID 1)
  // Tracking starts at connect time in real usage; mirror that here.
  trackHumanActivity(doc, provider);
  return provider;
}

/** Apply an edit as if it came from a remote human (origin = provider). */
function humanEdit(doc: Y.Doc, provider: any, cellIndex: number, text = "x") {
  const src = sourceOf(doc.getArray("cells"), cellIndex);
  doc.transact(() => src.insert(0, text), provider);
}

describe("human-activity tracking", () => {
  it("records remote edits per cell, ignores Claude's own edits", () => {
    const { doc, cells } = makeDoc([
      { id: "a", source: "" },
      { id: "b", source: "" },
    ]);
    const provider: any = {};
    trackHumanActivity(doc, provider);

    humanEdit(doc, provider, 0);
    expect(recentHumanEditInCell(doc, "a")).toBe(true);
    expect(recentHumanEditInCell(doc, "b")).toBe(false);

    // Claude's write (no provider origin) must not count as human activity.
    doc.transact(() => sourceOf(cells, 1).insert(0, "z"));
    expect(recentHumanEditInCell(doc, "b")).toBe(false);

    stopHumanActivity(doc);
  });

  it("honors the recency window", () => {
    const { doc } = makeDoc([{ id: "a", source: "" }]);
    const provider: any = {};
    trackHumanActivity(doc, provider);
    humanEdit(doc, provider, 0);

    expect(recentHumanEditInCell(doc, "a", 60_000)).toBe(true);
    // A negative window is always in the past → never "recent".
    expect(recentHumanEditInCell(doc, "a", -1)).toBe(false);
    stopHumanActivity(doc);
  });

  it("returns false when tracking never started", () => {
    const { doc } = makeDoc([{ id: "a", source: "" }]);
    expect(recentHumanEditInCell(doc, "a")).toBe(false);
  });
});

describe("checkHumanFocus gating on recent edits", () => {
  it("does NOT block on a parked cursor with no recent edit", () => {
    const { doc } = makeDoc([
      { id: "a", source: "print(1)" },
      { id: "b", source: "print(2)" },
    ]);
    const provider = makeProvider(doc, 0); // cursor parked in cell 0
    expect(checkHumanFocus(provider, doc, 0).blocked).toBe(false);
  });

  it("blocks when the cursor is in a cell the human is actively editing", () => {
    const { doc } = makeDoc([
      { id: "a", source: "print(1)" },
      { id: "b", source: "print(2)" },
    ]);
    const provider = makeProvider(doc, 0);
    humanEdit(doc, provider, 0); // human types in cell 0

    const focus = checkHumanFocus(provider, doc, 0);
    expect(focus.blocked).toBe(true);
    expect(focus.user).toBe("Alice");
  });

  it("does not block a different cell than the one being edited", () => {
    const { doc } = makeDoc([
      { id: "a", source: "print(1)" },
      { id: "b", source: "print(2)" },
    ]);
    const provider = makeProvider(doc, 0);
    humanEdit(doc, provider, 0);
    // Cursor is in cell 0, not cell 1 → cell 1 is free.
    expect(checkHumanFocus(provider, doc, 1).blocked).toBe(false);
  });
});
