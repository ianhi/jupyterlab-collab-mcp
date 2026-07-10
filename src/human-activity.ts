/**
 * Human edit-activity tracking.
 *
 * Why this exists: JupyterLab's collaborative cursor (jupyter-collaboration
 * `cursors.ts`) only ever *sets* the awareness `cursors` field when the editor
 * is focused and never clears it on blur. So a cell that was merely clicked
 * (or whose output was clicked) keeps a stale cursor pinned in awareness,
 * indistinguishable from a cell being actively edited. Command mode vs edit
 * mode is not represented in awareness at all.
 *
 * To avoid blocking the agent on a parked/stale cursor, we watch the doc for
 * *actual text edits* made by a human (remote) collaborator and remember when
 * each cell was last edited. The focus check then only blocks when the cursor
 * is in the cell AND the human has edited that cell's source recently.
 *
 * Human edits are identified by transaction origin: the y-websocket provider
 * applies remote updates with the provider instance as the transaction origin,
 * whereas Claude's own writes run with a different origin (null). This is
 * purely in-memory (no filesystem) and survives for the life of the doc.
 */

import * as Y from "yjs";

/** Default window: how recently a human must have edited a cell for it to
 *  count as "actively editing". Overridable via env. */
const DEFAULT_WINDOW_MS = 10_000;

export function getHumanEditWindowMs(): number {
  const raw = process.env.JUPYTER_MCP_HUMAN_EDIT_WINDOW_MS;
  if (raw != null) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_WINDOW_MS;
}

interface ActivityState {
  /** cellId → last human edit timestamp (ms since epoch) */
  edits: Map<string, number>;
  detach: () => void;
}

// Keyed by doc so state is dropped automatically when the doc is GC'd.
const activity = new WeakMap<Y.Doc, ActivityState>();

/**
 * Begin tracking human edits on this doc. Idempotent — safe to call on every
 * connection and from the focus check.
 */
export function trackHumanActivity(doc: Y.Doc, provider: any): void {
  if (activity.has(doc)) return;

  const edits = new Map<string, number>();

  const handler = (tr: Y.Transaction) => {
    // Only remote (human) edits — the websocket applies those with the
    // provider as origin. Claude's own writes have a different origin.
    if (tr.origin !== provider) return;

    // Fast path: did any Y.Text change in this transaction?
    let textChanged = false;
    for (const type of tr.changed.keys()) {
      if (type instanceof Y.Text) {
        textChanged = true;
        break;
      }
    }
    if (!textChanged) return;

    const cells = doc.getArray("cells");
    const now = Date.now();
    for (let i = 0; i < cells.length; i++) {
      const cell = cells.get(i);
      if (!(cell instanceof Y.Map)) continue;
      const source = cell.get("source");
      if (source instanceof Y.Text && tr.changed.has(source as any)) {
        const id = cell.get("id");
        if (typeof id === "string") edits.set(id, now);
      }
    }
  };

  doc.on("afterTransaction", handler);
  activity.set(doc, {
    edits,
    detach: () => doc.off("afterTransaction", handler),
  });
}

/**
 * True if a human edited the given cell's source within `windowMs`.
 * Returns false if tracking hasn't started or the cell was never edited.
 */
export function recentHumanEditInCell(
  doc: Y.Doc,
  cellId: string,
  windowMs: number = getHumanEditWindowMs()
): boolean {
  const state = activity.get(doc);
  if (!state) return false;
  const ts = state.edits.get(cellId);
  if (ts == null) return false;
  return Date.now() - ts <= windowMs;
}

/** Stop tracking and drop state for a doc (e.g. on disconnect). */
export function stopHumanActivity(doc: Y.Doc): void {
  const state = activity.get(doc);
  if (state) {
    state.detach();
    activity.delete(doc);
  }
}
