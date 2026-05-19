/**
 * Registry mapping a handed-off run_id to the notebook cell that initiated
 * it. When the kernel finally settles the run, we look up the target and
 * write the final outputs into the y-doc cell so the JupyterLab UI sees
 * the result.
 *
 * Targets are addressed by `cell_id` (stable across reorderings) rather
 * than `cell_index` (volatile). Targets without a matching cell at
 * settlement time are silently dropped — the cell may have been deleted
 * between handoff and completion, or the notebook may have disconnected.
 */

import * as Y from "yjs";
import type { Run } from "./kernel-client.js";
import { connectedNotebooks } from "./connection.js";
import {
  getCellId,
  updateCellOutputs,
  type ExecutionResult,
} from "./helpers.js";

export interface HandoffTarget {
  notebookPath: string;
  cellId: string;
}

const targets = new Map<string, HandoffTarget>();

/** Register a handed-off run as targeting a specific notebook cell. */
export function registerHandoffTarget(
  runId: string,
  notebookPath: string,
  cellId: string
): void {
  if (!runId || !cellId) return;
  targets.set(runId, { notebookPath, cellId });
}

/** Test helper: clear the registry. */
export function _clearHandoffTargets(): void {
  targets.clear();
}

/** Test helper: read a target (or undefined). */
export function _getHandoffTarget(runId: string): HandoffTarget | undefined {
  return targets.get(runId);
}

/**
 * Find the Y.Map cell with the matching cell_id, or undefined if missing.
 */
function findCellById(doc: Y.Doc, cellId: string): Y.Map<any> | undefined {
  const cells = doc.getArray("cells");
  for (let i = 0; i < cells.length; i++) {
    const cell = cells.get(i) as Y.Map<any>;
    if (getCellId(cell) === cellId) return cell;
  }
  return undefined;
}

/**
 * Apply final outputs from a settled Run to the y-doc cell registered as
 * its handoff target. No-ops silently when the notebook has disconnected
 * or the cell was deleted.
 *
 * Exposed for testing alongside the connection-wired callback.
 */
export function backfillRunOutputs(run: Run, docResolver?: (path: string) => Y.Doc | undefined): boolean {
  const target = targets.get(run.id);
  if (!target) return false;
  targets.delete(run.id);

  const resolveDoc = docResolver ?? ((p: string) => connectedNotebooks.get(p)?.doc);
  const doc = resolveDoc(target.notebookPath);
  if (!doc) return false; // disconnected
  const cell = findCellById(doc, target.cellId);
  if (!cell) return false; // cell deleted

  const result: ExecutionResult = {
    status: run.status,
    executionCount: run.executionCount,
    outputs: run.outputs,
    text: run.text,
    images: run.images,
    html: run.html,
  };
  updateCellOutputs(cell, result);
  return true;
}
