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

/**
 * Generate a unified diff between two strings
 */
export function generateUnifiedDiff(
  oldStr: string,
  newStr: string,
  filename: string
): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const diffLines: string[] = [];
  diffLines.push(`--- ${filename} (before)`);
  diffLines.push(`+++ ${filename} (after)`);

  // Find changed regions
  const maxLen = Math.max(oldLines.length, newLines.length);
  let inChange = false;
  let changeStart = 0;
  const changes: { oldStart: number; oldLines: string[]; newLines: string[] }[] = [];
  let currentOld: string[] = [];
  let currentNew: string[] = [];

  for (let i = 0; i <= maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine !== newLine) {
      if (!inChange) {
        inChange = true;
        changeStart = i;
        currentOld = [];
        currentNew = [];
      }
      if (oldLine !== undefined) currentOld.push(oldLine);
      if (newLine !== undefined) currentNew.push(newLine);
    } else if (inChange) {
      changes.push({ oldStart: changeStart, oldLines: currentOld, newLines: currentNew });
      inChange = false;
    }
  }

  if (inChange) {
    changes.push({ oldStart: changeStart, oldLines: currentOld, newLines: currentNew });
  }

  // Format hunks
  for (const change of changes) {
    const contextStart = Math.max(0, change.oldStart - 2);

    diffLines.push(
      `@@ -${change.oldStart + 1},${change.oldLines.length} +${change.oldStart + 1},${change.newLines.length} @@`
    );

    // Add context before
    for (let i = contextStart; i < change.oldStart && i < oldLines.length; i++) {
      diffLines.push(` ${oldLines[i]}`);
    }

    // Add removed lines
    for (const line of change.oldLines) {
      diffLines.push(`-${line}`);
    }

    // Add added lines
    for (const line of change.newLines) {
      diffLines.push(`+${line}`);
    }

    // Add context after
    const oldEnd = change.oldStart + change.oldLines.length;
    const contextEnd = Math.min(oldLines.length, oldEnd + 2);
    for (let i = oldEnd; i < contextEnd; i++) {
      diffLines.push(` ${oldLines[i]}`);
    }
  }

  if (changes.length === 0) {
    return "(no changes)";
  }

  return diffLines.join("\n");
}

/**
 * Format notebook outputs for display.
 * Returns text representation of outputs.
 */
export function formatOutputsAsText(outputs: any[]): string {
  if (!outputs || outputs.length === 0) return "";

  const parts: string[] = [];
  for (const out of outputs) {
    switch (out.output_type) {
      case "stream":
        parts.push(out.text || "");
        break;
      case "execute_result":
      case "display_data":
        const text = out.data?.["text/plain"];
        if (text) parts.push(text);
        break;
      case "error":
        parts.push(`${out.ename}: ${out.evalue}`);
        break;
    }
  }
  return parts.join("");
}

/**
 * Extract text/plain from a single output object
 */
export function extractOutputText(output: any): string {
  if (!output) return "";

  switch (output.output_type) {
    case "stream":
      return output.text || "";
    case "execute_result":
    case "display_data":
      return output.data?.["text/plain"] || "";
    case "error":
      return `${output.ename}: ${output.evalue}`;
    default:
      return "";
  }
}

/**
 * Notebook output interface for execution results
 */
export interface NotebookOutput {
  output_type: "stream" | "execute_result" | "error" | "display_data";
  [key: string]: any;
}

/**
 * Execution result from kernel
 */
export interface ExecutionResult {
  status: "ok" | "error";
  executionCount: number | null;
  outputs: NotebookOutput[];
  text: string;
  images: { data: string; mimeType: string }[];
  html: string[];
}

/**
 * Update a cell's outputs in a Y.Map
 */
export function updateCellOutputs(
  cell: Y.Map<any>,
  result: ExecutionResult
): void {
  cell.set("execution_count", result.executionCount);

  let outputsArray = cell.get("outputs");
  if (!(outputsArray instanceof Y.Array)) {
    outputsArray = new Y.Array();
    cell.set("outputs", outputsArray);
  }

  // Clear existing outputs
  if (outputsArray.length > 0) {
    outputsArray.delete(0, outputsArray.length);
  }

  // Add new outputs as Y.Maps
  for (const output of result.outputs) {
    const outputMap = new Y.Map();
    for (const [key, value] of Object.entries(output)) {
      if (Array.isArray(value)) {
        const arr = new Y.Array();
        arr.push(value);
        outputMap.set(key, arr);
      } else if (typeof value === "object" && value !== null) {
        const map = new Y.Map();
        for (const [k, v] of Object.entries(value)) {
          map.set(k, v);
        }
        outputMap.set(key, map);
      } else {
        outputMap.set(key, value);
      }
    }
    outputsArray.push([outputMap]);
  }
}

/**
 * Create a RegExp from a pattern, escaping special characters if invalid regex
 */
export function createSafeRegex(pattern: string, caseSensitive: boolean = false): RegExp {
  const flags = caseSensitive ? "g" : "gi";
  try {
    return new RegExp(pattern, flags);
  } catch {
    // Escape special regex characters and use as literal string
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
  }
}

/**
 * Extract markdown headers from source text
 * Returns array of { level, text } for each header found
 */
export function extractMarkdownHeaders(source: string): { level: number; text: string }[] {
  const headers: { level: number; text: string }[] = [];
  const lines = source.split("\n");

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headers.push({
        level: match[1].length,
        text: match[2].trim(),
      });
    }
  }

  return headers;
}

/**
 * Get a preview of code (first non-empty line, truncated)
 */
export function getCodePreview(source: string, maxLength: number = 60): string {
  const firstLine = source.split("\n").find((line) => line.trim()) || "(empty)";
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return firstLine.slice(0, maxLength) + "...";
}

/**
 * Extract text from outputs including traceback for errors.
 * More comprehensive than formatOutputsAsText - includes full error traceback.
 */
export function extractOutputsWithTraceback(outputs: any[]): string {
  if (!outputs || outputs.length === 0) return "";

  const parts: string[] = [];
  for (const out of outputs) {
    switch (out.output_type) {
      case "stream":
        parts.push(out.text || "");
        break;
      case "execute_result":
      case "display_data":
        const text = out.data?.["text/plain"];
        if (text) parts.push(text);
        break;
      case "error":
        parts.push(`${out.ename}: ${out.evalue}`);
        if (out.traceback) {
          parts.push(out.traceback.join("\n"));
        }
        break;
    }
  }
  return parts.join("\n");
}

/**
 * Resolve a cell ID prefix to a numeric index.
 * Works with both Y.Map cells (Jupyter mode) and plain objects (filesystem mode).
 * Throws if no match or ambiguous match.
 */
export function resolveCellId(
  cells: Y.Array<any> | any[],
  cellId: string
): number {
  const matches: { index: number; id: string }[] = [];

  const length = cells instanceof Y.Array ? cells.length : cells.length;

  for (let i = 0; i < length; i++) {
    const cell = cells instanceof Y.Array ? cells.get(i) : cells[i];
    const id = getCellId(cell);
    if (id && id.startsWith(cellId)) {
      matches.push({ index: i, id });
    }
  }

  if (matches.length === 0) {
    throw new Error(`Cell ID '${cellId}' not found. Use get_notebook_content to see available cell IDs.`);
  }

  if (matches.length > 1) {
    const locations = matches.map((m) => `index ${m.index}`).join(" and ");
    throw new Error(
      `Cell ID '${cellId}' is ambiguous, matches cells at ${locations}. Use more characters.`
    );
  }

  return matches[0].index;
}

/**
 * Resolve multiple cell ID prefixes to numeric indices.
 * Returns sorted unique indices.
 */
export function resolveCellIds(
  cells: Y.Array<any> | any[],
  cellIds: string[]
): number[] {
  const indices = cellIds.map((id) => resolveCellId(cells, id));
  return [...new Set(indices)].sort((a, b) => a - b);
}

/**
 * Get truncated cell ID (first 8 characters) for display.
 */
export function truncatedCellId(cell: any): string | undefined {
  const id = getCellId(cell);
  return id ? id.slice(0, 8) : undefined;
}

/**
 * Check if a human (non-Claude) collaborator is editing a specific cell.
 * Uses the awareness protocol to detect active cursors.
 * Returns { blocked: true, user: "Name" } if someone is editing, { blocked: false } otherwise.
 */
export function checkHumanFocus(
  provider: any, // WebsocketProvider
  doc: Y.Doc,
  cellIndex: number
): { blocked: boolean; user?: string } {
  const awareness = provider.awareness;
  if (!awareness) return { blocked: false };

  const states = awareness.getStates();
  const myClientId = awareness.clientID;
  const cells = doc.getArray("cells");

  for (const [clientId, state] of states.entries()) {
    if (clientId === myClientId) continue;

    // Skip other Claude instances
    const username = state.user?.username;
    if (username === "claude-code") continue;

    const displayName = state.user?.display_name || state.user?.name || "Unknown";

    // Check cursor positions
    if (state.cursors && state.cursors.length > 0) {
      for (const cursor of state.cursors) {
        if (cursor.head && cursor.head.type) {
          for (let i = 0; i < cells.length; i++) {
            if (i !== cellIndex) continue;
            const cell = cells.get(i) as Y.Map<any>;
            if (cell instanceof Y.Map) {
              const source = cell.get("source");
              if (source instanceof Y.Text) {
                try {
                  const absPos = Y.createAbsolutePositionFromRelativePosition(
                    cursor.head,
                    doc
                  );
                  if (absPos && absPos.type === source) {
                    return { blocked: true, user: displayName };
                  }
                } catch {
                  // Not this cell
                }
              }
            }
          }
        }
      }
    }
  }

  return { blocked: false };
}

/**
 * Truncate a diff string if it exceeds maxLines.
 * Shows first and last portions with a "... X lines omitted ..." message.
 */
export function truncateDiff(diff: string, maxLines: number = 30): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) {
    return diff;
  }

  const keepTop = Math.floor(maxLines / 2);
  const keepBottom = maxLines - keepTop;
  const omitted = lines.length - maxLines;

  return [
    ...lines.slice(0, keepTop),
    `... ${omitted} lines omitted ...`,
    ...lines.slice(-keepBottom),
  ].join("\n");
}

/**
 * Build MCP content array from execution result, with image limiting.
 * Returns the content array for the MCP response.
 */
export function buildExecutionContent(
  result: ExecutionResult,
  textPrefix: string,
  options: { max_images?: number; include_images?: boolean } = {}
): any[] {
  const { max_images, include_images = true } = options;

  const content: any[] = [
    {
      type: "text",
      text: textPrefix + (result.text || "(no output)"),
    },
  ];

  if (!include_images || max_images === 0) {
    if (result.images.length > 0) {
      content[0].text += `\n\n(${result.images.length} image${result.images.length === 1 ? "" : "s"} not shown — set include_images=true or increase max_images to see them)`;
    }
    return content;
  }

  const effectiveMax = max_images ?? result.images.length; // default: show all
  const images = result.images;

  if (images.length > effectiveMax) {
    // Show last N images (most recent/final plots are usually most relevant)
    const omitted = images.length - effectiveMax;
    content[0].text += `\n\n(showing last ${effectiveMax} of ${images.length} images — ${omitted} omitted, use max_images to adjust)`;
    const kept = images.slice(-effectiveMax);
    for (const img of kept) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  } else {
    for (const img of images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }

  return content;
}
