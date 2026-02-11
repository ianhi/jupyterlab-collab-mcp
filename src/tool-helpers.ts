/**
 * Shared helper functions for MCP tool handlers.
 *
 * These helpers extract common patterns from tool implementations to reduce
 * repetition and keep the main index.ts focused on tool definitions.
 *
 * Note: The connection-related imports (isJupyterConnected, listNotebookSessions,
 * connectToNotebook, NotebookSession) are expected to be extracted from index.ts
 * into a connection.ts module before this file can be used.
 */

import * as Y from "yjs";
import {
  resolveCellId,
  truncatedCellId,
  checkHumanFocus,
} from "./helpers.js";
import {
  readNotebook,
  writeNotebook,
  resolveNotebookPath,
  type NotebookData,
} from "./notebook-fs.js";
import {
  isJupyterConnected,
  listNotebookSessions,
  connectToNotebook,
  type NotebookSession,
} from "./connection.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Standard signature for an MCP tool handler function.
 */
export type ToolHandler = (
  args: Record<string, any>
) => Promise<{ content: any[] }>;

// ============================================================================
// Session helpers
// ============================================================================

/**
 * Look up the notebook session for a given path and validate that it has
 * an active kernel. Throws if no kernel is found.
 *
 * Combines the repeated pattern of:
 *   const sessions = await listNotebookSessions();
 *   const session = sessions.find(s => s.path === path);
 *   if (!session?.kernelId) throw ...
 */
export async function getSessionWithKernel(
  path: string
): Promise<NotebookSession> {
  const sessions = await listNotebookSessions();
  const session = sessions.find((s) => s.path === path);
  if (!session?.kernelId) {
    throw new Error(
      `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
    );
  }
  return session;
}

// ============================================================================
// Connection + cell access helpers
// ============================================================================

/**
 * Connect to a notebook via Yjs and return the document, provider, cells
 * array, and (optional) session.
 *
 * Combines the repeated pattern (~30 occurrences) of:
 *   const sessions = await listNotebookSessions();
 *   const session = sessions.find(s => s.path === path);
 *   const { doc, provider } = await connectToNotebook(path, session?.kernelId);
 *   const cells = doc.getArray("cells");
 */
export async function connectAndGetCells(path: string): Promise<{
  doc: Y.Doc;
  provider: any;
  cells: Y.Array<any>;
  session: NotebookSession | undefined;
}> {
  const sessions = await listNotebookSessions();
  const session = sessions.find((s) => s.path === path);
  const { doc, provider } = await connectToNotebook(path, session?.kernelId);
  const cells = doc.getArray("cells");
  return { doc, provider, cells, session };
}

// ============================================================================
// Dual-mode (filesystem / Jupyter) access
// ============================================================================

/**
 * Unified accessor that handles the filesystem/Jupyter branching automatically.
 *
 * - If not connected to JupyterLab, reads the .ipynb file from disk.
 * - If connected, connects via Yjs for real-time collaboration.
 *
 * Returns a `save` callback: in filesystem mode it writes the notebook back
 * to disk; in Jupyter mode it's a no-op (Yjs auto-saves).
 */
export async function getNotebookCells(path: string): Promise<{
  mode: "filesystem" | "jupyter";
  cells: Y.Array<any> | any[];
  notebook?: NotebookData;
  doc?: Y.Doc;
  provider?: any;
  session?: NotebookSession;
  save: (notebook: NotebookData) => Promise<void>;
}> {
  if (!isJupyterConnected()) {
    const resolved = resolveNotebookPath(path);
    const notebook = await readNotebook(resolved);
    return {
      mode: "filesystem",
      cells: notebook.cells,
      notebook,
      save: async (nb) => writeNotebook(resolved, nb),
    };
  }

  const sessions = await listNotebookSessions();
  const session = sessions.find((s) => s.path === path);
  const { doc, provider } = await connectToNotebook(path, session?.kernelId);
  const cells = doc.getArray("cells");
  return {
    mode: "jupyter",
    cells,
    doc,
    provider,
    session,
    save: async () => {}, // Jupyter mode auto-saves via Yjs
  };
}

// ============================================================================
// Cell index / ID resolution
// ============================================================================

/**
 * Resolve the cell index from either an `index` or `cell_id` parameter.
 *
 * Centralizes the common pattern (~15 occurrences) where a tool accepts
 * either a numeric index or a cell_id prefix and needs to resolve it.
 *
 * Options:
 * - `insertAfter`: If true and resolving from cell_id, adds 1 to the
 *   resolved index (useful for insert-after semantics).
 * - `required`: If true (default), throws when neither index nor cell_id
 *   is provided.
 */
export function resolveIndexParam(
  cells: Y.Array<any> | any[],
  params: { index?: number; cell_id?: string },
  options?: { insertAfter?: boolean; required?: boolean }
): number | undefined {
  const { insertAfter = false, required = true } = options ?? {};
  let resolvedIndex = params.index;

  if (params.cell_id !== undefined) {
    if (params.index !== undefined) {
      throw new Error("Specify either 'index' or 'cell_id', not both.");
    }
    resolvedIndex = resolveCellId(cells, params.cell_id);
    if (insertAfter) resolvedIndex += 1;
  }

  if (required && resolvedIndex === undefined) {
    throw new Error("Either 'index' or 'cell_id' is required.");
  }

  return resolvedIndex;
}

// ============================================================================
// Cell validation helpers
// ============================================================================

/**
 * Simple bounds check for a cell index.
 * Throws a descriptive error if the index is out of range.
 */
export function validateCellIndex(cellCount: number, index: number): void {
  if (index < 0 || index >= cellCount) {
    throw new Error(
      `Invalid cell index ${index}. Notebook has ${cellCount} cells.`
    );
  }
}

/**
 * Get the number of cells from either a Y.Array (Jupyter mode) or a plain
 * array (filesystem mode).
 */
export function cellCount(cells: Y.Array<any> | any[]): number {
  return cells instanceof Y.Array ? cells.length : (cells as any[]).length;
}

// ============================================================================
// Collaboration / focus protection
// ============================================================================

/**
 * Check whether a human collaborator is currently editing the given cell
 * and throw if so (unless `force` is true).
 *
 * Centralizes the human-focus protection pattern (~5 occurrences):
 *   const focus = checkHumanFocus(provider, doc, cellIndex);
 *   if (focus.blocked) throw ...
 */
export function assertCellNotInUse(
  provider: any,
  doc: Y.Doc,
  cells: Y.Array<any>,
  cellIndex: number,
  force: boolean = false
): void {
  if (force) return;

  const focus = checkHumanFocus(provider, doc, cellIndex);
  if (focus.blocked) {
    const cellIdStr = truncatedCellId(cells.get(cellIndex) as any);
    throw new Error(
      `Cannot modify cell ${cellIndex}${cellIdStr ? ` (${cellIdStr})` : ""} — user "${focus.user}" is currently editing it. Use force=true to override.`
    );
  }
}
