/**
 * Filesystem backend for notebook operations.
 * Reads/writes .ipynb files directly without JupyterLab.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

/** A single notebook cell (matches .ipynb JSON structure) */
export interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata: Record<string, any>;
  outputs?: any[];
  execution_count?: number | null;
  id?: string;
}

/** Full notebook structure (matches .ipynb JSON structure) */
export interface NotebookData {
  cells: NotebookCell[];
  metadata: Record<string, any>;
  nbformat: number;
  nbformat_minor: number;
}

/**
 * Read and parse a .ipynb file from disk.
 */
export async function readNotebook(path: string): Promise<NotebookData> {
  const content = await readFile(path, "utf-8");
  const nb = JSON.parse(content) as NotebookData;

  // Normalize cell sources to strings (join arrays)
  for (const cell of nb.cells) {
    if (Array.isArray(cell.source)) {
      cell.source = cell.source.join("");
    }
  }

  return nb;
}

/**
 * Write a notebook to disk in standard .ipynb format.
 * Uses 1-space indent and trailing newline (matches Jupyter's format).
 */
export async function writeNotebook(
  path: string,
  nb: NotebookData
): Promise<void> {
  // Convert string sources back to line arrays for .ipynb format
  const serialized: NotebookData = {
    ...nb,
    cells: nb.cells.map((cell) => ({
      ...cell,
      source: sourceToLines(
        typeof cell.source === "string" ? cell.source : cell.source.join("")
      ),
    })),
  };

  const json = JSON.stringify(serialized, null, 1) + "\n";
  await writeFile(path, json, "utf-8");
}

/**
 * Resolve a notebook path relative to cwd (or return as-is if absolute).
 */
export function resolveNotebookPath(path: string): string {
  if (isAbsolute(path)) {
    return path;
  }
  return resolve(process.cwd(), path);
}

/**
 * Convert a source string to the .ipynb line array format.
 * Each line except the last ends with \n.
 * Example: "a\nb" → ["a\n", "b"]
 * Empty string → []
 */
export function sourceToLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
}

/**
 * Create a blank notebook structure.
 */
export function createEmptyNotebook(kernelName: string = "python3"): NotebookData {
  return {
    cells: [],
    metadata: {
      kernelspec: {
        display_name: kernelName === "python3" ? "Python 3" : kernelName,
        language: "python",
        name: kernelName,
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}
