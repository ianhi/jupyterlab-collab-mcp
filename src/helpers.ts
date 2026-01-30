/**
 * Helper functions for notebook manipulation.
 * Extracted for testability.
 */

import * as Y from "yjs";

/**
 * Extract source code from a cell (handles Y.Map, Y.Text, plain objects, arrays)
 */
export function extractSource(cell: any): string {
  if (!cell) return "";

  if (cell instanceof Y.Map) {
    const source = cell.get("source");
    if (source instanceof Y.Text) return source.toString();
    if (typeof source === "string") return source;
    if (Array.isArray(source)) return source.join("");
    return String(source || "");
  }

  const source = cell.source;
  if (typeof source === "string") return source;
  if (source instanceof Y.Text) return source.toString();
  if (Array.isArray(source)) return source.join("");
  return String(source || "");
}

/**
 * Get cell type (code or markdown), defaulting to "code"
 */
export function getCellType(cell: any): string {
  if (cell instanceof Y.Map) {
    return cell.get("cell_type") || "code";
  }
  return cell?.cell_type || "code";
}

/**
 * Get cell ID if present
 */
export function getCellId(cell: any): string | undefined {
  if (cell instanceof Y.Map) {
    return cell.get("id");
  }
  return cell?.id;
}

/**
 * Resolves cell indices from flexible parameters.
 * - If indices array is provided, use it (non-contiguous)
 * - Otherwise use index/end_index for range (contiguous)
 * - Returns sorted unique indices and a description string
 */
export function resolveCellIndices(
  cellCount: number,
  params: { index?: number; end_index?: number; indices?: number[] }
): { indices: number[]; description: string } {
  if (params.indices && params.indices.length > 0) {
    // Non-contiguous indices specified
    const indices = [...new Set(params.indices)].sort((a, b) => a - b);
    for (const idx of indices) {
      if (idx < 0 || idx >= cellCount) {
        throw new Error(`Invalid cell index ${idx}. Notebook has ${cellCount} cells.`);
      }
    }
    const description = indices.length === 1
      ? `cell ${indices[0]}`
      : `cells ${indices.join(", ")}`;
    return { indices, description };
  }

  // Contiguous range via index/end_index
  const index = params.index ?? 0;
  const endIdx = params.end_index ?? index;

  if (index < 0 || endIdx >= cellCount || index > endIdx) {
    throw new Error(`Invalid range [${index}, ${endIdx}]. Notebook has ${cellCount} cells.`);
  }

  const indices: number[] = [];
  for (let i = index; i <= endIdx; i++) {
    indices.push(i);
  }

  const description = indices.length === 1
    ? `cell ${index}`
    : `cells ${index}-${endIdx}`;
  return { indices, description };
}

/**
 * Parse a JupyterLab URL to extract host, port, and token
 */
export function parseJupyterUrl(url: string): { host: string; port: number; token: string } {
  const parsed = new URL(url);
  const token = parsed.searchParams.get("token");
  if (!token) {
    throw new Error("URL must include a token parameter (e.g., ?token=xxx)");
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80),
    token,
  };
}
