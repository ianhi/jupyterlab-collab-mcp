import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  registerHandoffTarget,
  backfillRunOutputs,
  _clearHandoffTargets,
  _getHandoffTarget,
} from "./handoff-targets.js";
import type { Run } from "./kernel-client.js";

function makeRun(id: string): Run {
  return {
    id,
    kernelId: "k1",
    state: "completed",
    startedAt: Date.now() - 100,
    completedAt: Date.now(),
    outputs: [
      {
        output_type: "stream",
        name: "stdout",
        text: "hello\n",
      } as any,
    ],
    executionCount: 7,
    status: "ok",
    text: "hello\n",
    images: [],
    html: [],
    wasHandedOff: true,
  };
}

function makeCell(id: string, source = "print('x')") {
  const cell = new Y.Map<any>();
  cell.set("cell_type", "code");
  cell.set("source", new Y.Text(source));
  cell.set("metadata", new Y.Map());
  cell.set("outputs", new Y.Array());
  cell.set("execution_count", null);
  cell.set("id", id);
  return cell;
}

describe("handoff-targets", () => {
  beforeEach(() => {
    _clearHandoffTargets();
  });

  it("registers and reads back a target", () => {
    registerHandoffTarget("r1", "nb.ipynb", "cell-a");
    expect(_getHandoffTarget("r1")).toEqual({
      notebookPath: "nb.ipynb",
      cellId: "cell-a",
    });
  });

  it("backfills a registered target into the y-doc cell", () => {
    const doc = new Y.Doc();
    const cells = doc.getArray("cells");
    cells.push([makeCell("cell-a")]);

    registerHandoffTarget("r1", "nb.ipynb", "cell-a");
    const ok = backfillRunOutputs(makeRun("r1"), () => doc);
    expect(ok).toBe(true);

    const cell = cells.get(0) as Y.Map<any>;
    expect(cell.get("execution_count")).toBe(7);
    const outputs = cell.get("outputs") as Y.Array<any>;
    expect(outputs.length).toBe(1);
    const first = outputs.get(0) as Y.Map<any>;
    expect(first.get("output_type")).toBe("stream");
    expect(first.get("text")).toBe("hello\n");

    // Target is consumed.
    expect(_getHandoffTarget("r1")).toBeUndefined();
  });

  it("no-ops silently if the notebook is disconnected", () => {
    registerHandoffTarget("r2", "nb.ipynb", "cell-a");
    const ok = backfillRunOutputs(makeRun("r2"), () => undefined);
    expect(ok).toBe(false);
  });

  it("no-ops silently if the cell was deleted", () => {
    const doc = new Y.Doc();
    // No cells with that id
    registerHandoffTarget("r3", "nb.ipynb", "cell-missing");
    const ok = backfillRunOutputs(makeRun("r3"), () => doc);
    expect(ok).toBe(false);
  });

  it("no-ops silently when run has no registered target", () => {
    const doc = new Y.Doc();
    const ok = backfillRunOutputs(makeRun("unknown"), () => doc);
    expect(ok).toBe(false);
  });
});
