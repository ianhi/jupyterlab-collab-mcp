import type { ToolResult } from "../handler-types.js";
import * as Y from "yjs";
import {
  extractSource,
  getCellType,
  truncatedCellId,
  resolveCellIds,
  createSafeRegex,
  extractMarkdownHeaders,
  getCodePreview,
  formatOutputsAsText,
} from "../helpers.js";
import {
  readNotebook,
  writeNotebook,
  resolveNotebookPath,
} from "../notebook-fs.js";
import {
  isJupyterConnected,
  listNotebookSessions,
  connectToNotebook,
} from "../connection.js";

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  "get_notebook_content": async (args) => {
    const {
      path,
      cell_type = "code",
      include_outputs = false,
      output_format = "text",
      start_index = 0,
      end_index,
      indices,
      cell_ids,
    } = args as {
      path: string;
      cell_type?: "all" | "code" | "markdown";
      include_outputs?: boolean;
      output_format?: "text" | "structured";
      start_index?: number;
      end_index?: number;
      indices?: number[];
      cell_ids?: string[];
    };

    // Helper to build cell data from either backend
    const buildCellData = (cell: any, i: number): any | null => {
      const type = getCellType(cell);
      if (cell_type !== "all" && type !== cell_type) return null;

      const cellData: any = {
        index: i,
        id: truncatedCellId(cell),
        type,
        source: extractSource(cell),
      };

      if (include_outputs && type === "code") {
        const outputs = cell instanceof Y.Map ? cell.get("outputs") : cell?.outputs;
        if (outputs) {
          const outputsJson = outputs instanceof Y.Array ? outputs.toJSON() : (Array.isArray(outputs) ? outputs : []);
          if (output_format === "text") {
            const combinedText = formatOutputsAsText(outputsJson);
            if (combinedText) cellData.output = combinedText;
          } else {
            cellData.outputs = outputsJson.map((out: any) => {
              if (out.data && (out.output_type === "display_data" || out.output_type === "execute_result")) {
                return {
                  output_type: out.output_type,
                  text: out.data["text/plain"] || "[rich output]",
                  has_image: !!out.data["image/png"] || !!out.data["image/jpeg"],
                  has_html: !!out.data["text/html"],
                };
              }
              return out;
            });
          }
        }
        cellData.execution_count = cell instanceof Y.Map ? cell.get("execution_count") : cell?.execution_count;
      }

      return cellData;
    };

    // Determine which cell indices to iterate
    const getCellIndicesToRead = (cellsOrLength: any): number[] => {
      const length = typeof cellsOrLength === "number" ? cellsOrLength : (cellsOrLength instanceof Y.Array ? cellsOrLength.length : cellsOrLength.length);
      if (cell_ids && cell_ids.length > 0) {
        // cell_ids takes highest priority
        return resolveCellIds(cellsOrLength, cell_ids);
      }
      if (indices && indices.length > 0) {
        const sorted = [...new Set(indices)].sort((a, b) => a - b);
        for (const idx of sorted) {
          if (idx < 0 || idx >= length) {
            throw new Error(`Invalid cell index ${idx}. Notebook has ${length} cells.`);
          }
        }
        return sorted;
      }
      // Default: start_index/end_index range
      const endIdx = end_index ?? (length - 1);
      const result: number[] = [];
      for (let i = start_index; i <= endIdx && i < length; i++) {
        result.push(i);
      }
      return result;
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);
      const cells = notebook.cells;
      const cellIndices = getCellIndicesToRead(cells);

      const content = [];
      for (const i of cellIndices) {
        const cellData = buildCellData(cells[i], i);
        if (cellData) content.push(cellData);
      }

      const totalCells = cells.length;
      const returnedCells = content.length;
      const summary = `Notebook: ${path} (${totalCells} total cells, returning ${returnedCells}${cell_type !== "all" ? ` ${cell_type} cells` : ""}${include_outputs ? " with outputs" : ""})`;

      return {
        content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(content, null, 2)}` }],
      };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");
    const cellIndices = getCellIndicesToRead(cells);

    const content = [];
    for (const i of cellIndices) {
      const cell = cells.get(i) as any;
      const cellData = buildCellData(cell, i);
      if (cellData) content.push(cellData);
    }

    // Add summary header
    const totalCells = cells.length;
    const returnedCells = content.length;
    const summary = `Notebook: ${path} (${totalCells} total cells, returning ${returnedCells}${cell_type !== "all" ? ` ${cell_type} cells` : ""}${include_outputs ? " with outputs" : ""})`;

    return {
      content: [
        {
          type: "text",
          text: `${summary}\n\n${JSON.stringify(content, null, 2)}`,
        },
      ],
    };
  },

  "get_notebook_outline": async (args) => {
    const { path } = args as { path: string };

    const buildOutline = (cells: any[], getCell: (i: number) => any): any[] => {
      const outline: any[] = [];
      for (let i = 0; i < cells.length; i++) {
        const cell = getCell(i);
        const type = getCellType(cell);
        const source = extractSource(cell);
        const id = truncatedCellId(cell);

        if (type === "markdown") {
          const headers = extractMarkdownHeaders(source);
          for (let h = 0; h < headers.length; h++) {
            const header = headers[h];
            const entry: any = { index: i, id, type: "header", level: header.level, text: header.text };
            if (headers.length > 1) entry.header_num = h + 1;
            outline.push(entry);
          }
        } else if (type === "code") {
          outline.push({ index: i, id, type: "code", preview: getCodePreview(source) });
        }
      }
      return outline;
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);
      const outline = buildOutline(notebook.cells, (i) => notebook.cells[i]);
      return {
        content: [{ type: "text", text: `Outline of ${path} (${notebook.cells.length} cells):\n\n${JSON.stringify(outline, null, 2)}` }],
      };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");
    const outline = buildOutline(
      Array.from({ length: cells.length }),
      (i) => cells.get(i)
    );

    return {
      content: [
        {
          type: "text",
          text: `Outline of ${path} (${cells.length} cells):\n\n${JSON.stringify(outline, null, 2)}`,
        },
      ],
    };
  },

  "search_notebook": async (args) => {
    const {
      path,
      pattern,
      search_in = "all",
      case_sensitive = false,
      max_results,
      max_source_length = 500,
    } = args as {
      path: string;
      pattern: string;
      search_in?: "source" | "outputs" | "all";
      case_sensitive?: boolean;
      max_results?: number;
      max_source_length?: number;
    };

    const regex = createSafeRegex(pattern, case_sensitive);
    const truncate = (text: string): string => {
      if (text.length <= max_source_length) return text;
      return text.slice(0, max_source_length) + "...";
    };

    // Shared search logic for both backends
    const searchCells = (cells: any[], getCell: (i: number) => any, getOutputs: (cell: any) => any[] | null): any[] => {
      const matches: any[] = [];
      for (let i = 0; i < cells.length; i++) {
        if (max_results !== undefined && matches.length >= max_results) break;

        const cell = getCell(i);
        const type = getCellType(cell);
        const source = extractSource(cell);

        const id = truncatedCellId(cell);
        const cellMatches: any = { index: i, id, type };
        let hasMatch = false;

        if (search_in === "source" || search_in === "all") {
          const sourceMatches = source.match(regex);
          if (sourceMatches) {
            hasMatch = true;
            cellMatches.source_matches = sourceMatches.length;
            cellMatches.source = truncate(source);
          }
        }

        if ((search_in === "outputs" || search_in === "all") && type === "code") {
          const outputs = getOutputs(cell);
          if (outputs) {
            const outputTexts: string[] = [];
            for (const out of outputs) {
              if (out.output_type === "stream") {
                outputTexts.push(out.text || "");
              } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
                const text = out.data?.["text/plain"];
                if (text) outputTexts.push(text);
              } else if (out.output_type === "error") {
                outputTexts.push(`${out.ename}: ${out.evalue}`);
                if (out.traceback) {
                  outputTexts.push(out.traceback.join("\n"));
                }
              }
            }
            const combinedOutput = outputTexts.join("\n");
            const outputMatches = combinedOutput.match(regex);
            if (outputMatches) {
              hasMatch = true;
              cellMatches.output_matches = outputMatches.length;
              cellMatches.output = truncate(combinedOutput);
            }
          }
        }

        if (hasMatch) matches.push(cellMatches);
      }
      return matches;
    };

    let matches: any[];

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);
      matches = searchCells(
        notebook.cells,
        (i) => notebook.cells[i],
        (cell) => cell.outputs || null,
      );
    } else {
      const sessions = await listNotebookSessions();
      const session = sessions.find((s) => s.path === path);
      const { doc } = await connectToNotebook(path, session?.kernelId);
      const cells = doc.getArray("cells");
      matches = searchCells(
        Array.from({ length: cells.length }),
        (i) => cells.get(i),
        (cell) => {
          const outputs = cell instanceof Y.Map ? cell.get("outputs") : cell?.outputs;
          if (!outputs) return null;
          return outputs instanceof Y.Array ? outputs.toJSON() : outputs;
        },
      );
    }

    const summary = `Search for "${pattern}" in ${path}: ${matches.length} cell(s) matched`;

    return {
      content: [
        {
          type: "text",
          text: matches.length > 0
            ? `${summary}\n\n${JSON.stringify(matches, null, 2)}`
            : `${summary}`,
        },
      ],
    };
  },

  "replace_in_notebook": async (args) => {
    const {
      path,
      search,
      replace,
      cell_type = "code",
      case_sensitive = false,
      regex: useRegex = false,
      indices,
      dry_run = false,
    } = args as {
      path: string;
      search: string;
      replace: string;
      cell_type?: "code" | "markdown" | "all";
      case_sensitive?: boolean;
      regex?: boolean;
      indices?: number[];
      dry_run?: boolean;
    };

    // Build search regex
    let searchRegex: RegExp;
    const flags = case_sensitive ? "g" : "gi";
    if (useRegex) {
      searchRegex = createSafeRegex(search, case_sensitive);
    } else {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      searchRegex = new RegExp(escaped, flags);
    }

    // Helper to build preview
    const makePreview = (source: string): string => {
      const firstMatch = source.match(searchRegex);
      const matchIdx = firstMatch ? source.indexOf(firstMatch[0]) : 0;
      const contextStart = Math.max(0, matchIdx - 20);
      const contextEnd = Math.min(source.length, matchIdx + search.length + 20);
      return (contextStart > 0 ? "..." : "") +
        source.slice(contextStart, contextEnd).replace(/\n/g, "\\n") +
        (contextEnd < source.length ? "..." : "");
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);
      const cells = notebook.cells;

      const targetIndices = indices && indices.length > 0
        ? [...new Set(indices)].sort((a, b) => a - b)
        : Array.from({ length: cells.length }, (_, i) => i);

      const replacements: { index: number; count: number; preview?: string }[] = [];
      let totalReplacements = 0;

      for (const i of targetIndices) {
        if (i < 0 || i >= cells.length) {
          throw new Error(`Invalid cell index ${i}. Notebook has ${cells.length} cells.`);
        }
        const cell = cells[i];
        const type = getCellType(cell);
        if (cell_type !== "all" && type !== cell_type) continue;

        const source = extractSource(cell);
        const matchCount = (source.match(searchRegex) || []).length;

        if (matchCount > 0) {
          totalReplacements += matchCount;
          const preview = makePreview(source);

          if (!dry_run) {
            cell.source = source.replace(searchRegex, replace);
          }
          replacements.push({ index: i, count: matchCount, preview });
        }
      }

      if (!dry_run && replacements.length > 0) {
        await writeNotebook(resolved, notebook);
      }

      const action = dry_run ? "Would replace" : "Replaced";
      const summary = `${action} "${search}" → "${replace}" in ${path}: ${totalReplacements} occurrence(s) in ${replacements.length} cell(s)`;

      if (replacements.length === 0) {
        return { content: [{ type: "text", text: `No matches found for "${search}" in ${path}` }] };
      }

      const details = replacements
        .map((r) => `  Cell ${r.index}: ${r.count} replacement(s) — ${r.preview}`)
        .join("\n");

      return { content: [{ type: "text", text: `${summary}\n\n${details}` }] };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    // Determine which cells to process
    const targetIndices = indices && indices.length > 0
      ? [...new Set(indices)].sort((a, b) => a - b)
      : Array.from({ length: cells.length }, (_, i) => i);

    const replacements: { index: number; count: number; preview?: string }[] = [];
    let totalReplacements = 0;

    for (const i of targetIndices) {
      if (i < 0 || i >= cells.length) {
        throw new Error(`Invalid cell index ${i}. Notebook has ${cells.length} cells.`);
      }

      const cell = cells.get(i) as Y.Map<any>;
      const type = getCellType(cell);

      // Skip cells that don't match the cell_type filter
      if (cell_type !== "all" && type !== cell_type) continue;

      const source = extractSource(cell);
      const matchCount = (source.match(searchRegex) || []).length;

      if (matchCount > 0) {
        const newSource = source.replace(searchRegex, replace);
        totalReplacements += matchCount;

        if (!dry_run && cell instanceof Y.Map) {
          const sourceField = cell.get("source");
          if (sourceField instanceof Y.Text) {
            sourceField.delete(0, sourceField.length);
            sourceField.insert(0, newSource);
          } else {
            cell.set("source", new Y.Text(newSource));
          }
        }

        replacements.push({ index: i, count: matchCount, preview: makePreview(source) });
      }
    }

    const action = dry_run ? "Would replace" : "Replaced";
    const summary = `${action} "${search}" → "${replace}" in ${path}: ${totalReplacements} occurrence(s) in ${replacements.length} cell(s)`;

    if (replacements.length === 0) {
      return {
        content: [{ type: "text", text: `No matches found for "${search}" in ${path}` }],
      };
    }

    const details = replacements
      .map((r) => `  Cell ${r.index}: ${r.count} replacement(s) — ${r.preview}`)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `${summary}\n\n${details}`,
        },
      ],
    };
  },

  "diff_notebooks": async (args) => {
    const { path1, path2, include_outputs, summary_only, max_diffs } = args as {
      path1: string;
      path2: string;
      include_outputs?: boolean;
      summary_only?: boolean;
      max_diffs?: number;
    };

    if (!isJupyterConnected()) {
      const resolved1 = resolveNotebookPath(path1);
      const resolved2 = resolveNotebookPath(path2);
      const nb1 = await readNotebook(resolved1);
      const nb2 = await readNotebook(resolved2);

      const diffs: string[] = [];
      let sourceDiffs = 0, typeDiffs = 0, outputDiffs = 0, onlyIn1 = 0, onlyIn2 = 0;

      const maxCells = Math.max(nb1.cells.length, nb2.cells.length);
      for (let i = 0; i < maxCells; i++) {
        const cell1 = i < nb1.cells.length ? nb1.cells[i] : null;
        const cell2 = i < nb2.cells.length ? nb2.cells[i] : null;

        if (!cell1) {
          onlyIn2++;
          if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
            diffs.push(`[${i}] Only in ${path2}: ${getCellType(cell2)} cell`);
          }
          continue;
        }
        if (!cell2) {
          onlyIn1++;
          if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
            diffs.push(`[${i}] Only in ${path1}: ${getCellType(cell1)} cell`);
          }
          continue;
        }

        const type1 = getCellType(cell1);
        const type2 = getCellType(cell2);
        if (type1 !== type2) {
          typeDiffs++;
          if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
            diffs.push(`[${i}] Type differs: ${type1} vs ${type2}`);
          }
        }

        const source1 = extractSource(cell1);
        const source2 = extractSource(cell2);
        if (source1 !== source2) {
          sourceDiffs++;
          if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
            const preview1 = source1.slice(0, 50).replace(/\n/g, "\\n");
            const preview2 = source2.slice(0, 50).replace(/\n/g, "\\n");
            diffs.push(`[${i}] Source differs:\n  ${path1}: "${preview1}..."\n  ${path2}: "${preview2}..."`);
          }
        }

        if (include_outputs && type1 === "code") {
          const out1 = JSON.stringify(cell1.outputs || []);
          const out2 = JSON.stringify(cell2.outputs || []);
          if (out1 !== out2) {
            outputDiffs++;
            if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
              diffs.push(`[${i}] Outputs differ`);
            }
          }
        }
      }

      const totalDiffs = sourceDiffs + typeDiffs + outputDiffs + onlyIn1 + onlyIn2;
      const diffSummary = `Summary: ${totalDiffs} differences (${sourceDiffs} source, ${typeDiffs} type, ${outputDiffs} output, ${onlyIn1} only in ${path1}, ${onlyIn2} only in ${path2})`;

      let resultText: string;
      if (totalDiffs === 0) {
        resultText = `Notebooks ${path1} and ${path2} are identical`;
      } else if (summary_only) {
        resultText = diffSummary;
      } else {
        const shownDiffs = max_diffs && diffs.length >= max_diffs ? `\n\n(showing first ${max_diffs} of ${totalDiffs} differences)` : "";
        resultText = `${diffSummary}\n\n${diffs.join("\n\n")}${shownDiffs}`;
      }

      return { content: [{ type: "text", text: resultText }] };
    }

    const sessions = await listNotebookSessions();
    const session1 = sessions.find((s) => s.path === path1);
    const session2 = sessions.find((s) => s.path === path2);

    const { doc: doc1 } = await connectToNotebook(path1, session1?.kernelId);
    const { doc: doc2 } = await connectToNotebook(path2, session2?.kernelId);

    const cells1 = doc1.getArray("cells");
    const cells2 = doc2.getArray("cells");

    const diffs: string[] = [];
    let sourceDiffs = 0;
    let typeDiffs = 0;
    let outputDiffs = 0;
    let onlyIn1 = 0;
    let onlyIn2 = 0;

    // Compare cells
    const maxCells = Math.max(cells1.length, cells2.length);
    for (let i = 0; i < maxCells; i++) {
      const cell1 = i < cells1.length ? (cells1.get(i) as Y.Map<any>) : null;
      const cell2 = i < cells2.length ? (cells2.get(i) as Y.Map<any>) : null;

      if (!cell1) {
        onlyIn2++;
        if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
          diffs.push(`[${i}] Only in ${path2}: ${getCellType(cell2)} cell`);
        }
        continue;
      }
      if (!cell2) {
        onlyIn1++;
        if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
          diffs.push(`[${i}] Only in ${path1}: ${getCellType(cell1)} cell`);
        }
        continue;
      }

      const type1 = getCellType(cell1);
      const type2 = getCellType(cell2);
      if (type1 !== type2) {
        typeDiffs++;
        if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
          diffs.push(`[${i}] Type differs: ${type1} vs ${type2}`);
        }
      }

      const source1 = extractSource(cell1);
      const source2 = extractSource(cell2);
      if (source1 !== source2) {
        sourceDiffs++;
        if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
          const preview1 = source1.slice(0, 50).replace(/\n/g, "\\n");
          const preview2 = source2.slice(0, 50).replace(/\n/g, "\\n");
          diffs.push(`[${i}] Source differs:\n  ${path1}: "${preview1}..."\n  ${path2}: "${preview2}..."`);
        }
      }

      if (include_outputs && type1 === "code") {
        const outputs1 = cell1.get("outputs");
        const outputs2 = cell2.get("outputs");
        const out1Json = outputs1 instanceof Y.Array ? JSON.stringify(outputs1.toJSON()) : "[]";
        const out2Json = outputs2 instanceof Y.Array ? JSON.stringify(outputs2.toJSON()) : "[]";
        if (out1Json !== out2Json) {
          outputDiffs++;
          if (!summary_only && (!max_diffs || diffs.length < max_diffs)) {
            diffs.push(`[${i}] Outputs differ`);
          }
        }
      }
    }

    const totalDiffs = sourceDiffs + typeDiffs + outputDiffs + onlyIn1 + onlyIn2;
    const summary = `Summary: ${totalDiffs} differences (${sourceDiffs} source, ${typeDiffs} type, ${outputDiffs} output, ${onlyIn1} only in ${path1}, ${onlyIn2} only in ${path2})`;

    let resultText: string;
    if (totalDiffs === 0) {
      resultText = `Notebooks ${path1} and ${path2} are identical`;
    } else if (summary_only) {
      resultText = summary;
    } else {
      const shownDiffs = max_diffs && diffs.length >= max_diffs ? `\n\n(showing first ${max_diffs} of ${totalDiffs} differences)` : "";
      resultText = `${summary}\n\n${diffs.join("\n\n")}${shownDiffs}`;
    }

    return {
      content: [
        {
          type: "text",
          text: resultText,
        },
      ],
    };
  },

  "get_user_focus": async (args) => {
    const { path } = args as { path: string };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc, provider } = await connectToNotebook(path, session?.kernelId);
    const awareness = provider.awareness;
    const cells = doc.getArray("cells");

    // Get all awareness states
    const states = awareness.getStates();
    const myClientId = awareness.clientID;

    const collaborators: any[] = [];
    states.forEach((state: any, clientId: number) => {
      if (clientId === myClientId) return; // Skip ourselves

      const info: any = {
        clientId,
        user: state.user?.display_name || state.user?.name || "Unknown",
      };

      // Try to find which cell the cursor is in
      if (state.cursors && state.cursors.length > 0) {
        for (const cursor of state.cursors) {
          // The RelativePosition contains a reference to the Y.Text type
          // Try to resolve it to find the cell
          if (cursor.head && cursor.head.type) {
            // cursor.head.type is the ID of the Y.Text
            // We need to find which cell's source matches this
            for (let i = 0; i < cells.length; i++) {
              const cell = cells.get(i) as Y.Map<any>;
              if (cell instanceof Y.Map) {
                const source = cell.get("source");
                if (source instanceof Y.Text) {
                  try {
                    // Try to create absolute position - if it works, this is the right cell
                    const absPos = Y.createAbsolutePositionFromRelativePosition(
                      cursor.head,
                      doc
                    );
                    if (absPos && absPos.type === source) {
                      info.focusedCell = i;
                      info.cursorPosition = absPos.index;
                      break;
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

      // Check for current document
      if (state.current) {
        info.current = state.current;
      }

      collaborators.push(info);
    });

    if (collaborators.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No other collaborators found in ${path}. Make sure the notebook is open in JupyterLab.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Collaborators in ${path}:\n${JSON.stringify(collaborators, null, 2)}`,
        },
      ],
    };
  },
};
