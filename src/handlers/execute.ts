import type { ToolResult } from "../handler-types.js";
import * as Y from "yjs";
import {
  extractSource,
  getCellType,
  getCellId,
  resolveCellId,
  resolveCellIds,
  resolveCellIndices,
  truncatedCellId,
  updateCellOutputs,
  buildExecutionContent,
  generateUnifiedDiff,
  truncateDiff,
  checkHumanFocus,
  formatTimeRemaining,
} from "../helpers.js";
import { readNotebook, writeNotebook, resolveNotebookPath } from "../notebook-fs.js";
import { isJupyterConnected, listNotebookSessions, connectToNotebook, executeCode } from "../connection.js";
import { recordChange } from "../cell-tracker.js";
import { checkLock } from "../cell-locks.js";

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  "execute_cell": async (args) => {
    const { path, index, cell_id, timeout, max_images, include_images } = args as {
      path: string;
      index?: number;
      cell_id?: string;
      timeout?: number;
      max_images?: number;
      include_images?: boolean;
    };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      throw new Error(
        `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
      );
    }

    const { doc } = await connectToNotebook(path, session.kernelId);
    const cells = doc.getArray("cells");

    let resolvedIndex = index;
    if (cell_id !== undefined) {
      if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
      resolvedIndex = resolveCellId(cells, cell_id);
    }
    if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

    if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
      throw new Error(
        `Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`
      );
    }

    const cell = cells.get(resolvedIndex) as Y.Map<any>;
    const source = extractSource(cell);
    const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
    const result = await executeCode(session.kernelId, source, timeoutMs);

    // Update cell outputs in the notebook
    if (cell instanceof Y.Map) {
      updateCellOutputs(cell, result);
    }

    return { content: buildExecutionContent(result, "", { max_images, include_images }) };
  },

  "execute_code": async (args) => {
    const { path, code, insertCell, timeout, max_images, include_images } = args as {
      path: string;
      code: string;
      insertCell?: boolean;
      timeout?: number;
      max_images?: number;
      include_images?: boolean;
    };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      throw new Error(
        `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
      );
    }

    const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
    const imgOpts = { max_images, include_images };

    if (insertCell) {
      // Insert as a new cell and execute with visible outputs
      const { doc } = await connectToNotebook(path, session.kernelId);
      const cells = doc.getArray("cells");

      // Create the cell
      const newCell = new Y.Map();
      newCell.set("cell_type", "code");
      newCell.set("source", new Y.Text(code));
      newCell.set("metadata", new Y.Map());
      newCell.set("outputs", new Y.Array());
      newCell.set("execution_count", null);
      newCell.set("id", crypto.randomUUID());
      cells.push([newCell]);

      // Execute and update outputs
      const result = await executeCode(session.kernelId, code, timeoutMs);
      updateCellOutputs(newCell, result);

      return { content: buildExecutionContent(result, `Cell inserted at index ${cells.length - 1}\n\nOutput:\n`, imgOpts) };
    } else {
      // Execute without inserting a cell
      const result = await executeCode(session.kernelId, code, timeoutMs);
      return { content: buildExecutionContent(result, "", imgOpts) };
    }
  },

  "insert_and_execute": async (args) => {
    const { path, index, cell_id, source, timeout, max_images, include_images, client_name } = args as {
      path: string;
      index?: number;
      cell_id?: string;
      source: string;
      timeout?: number;
      max_images?: number;
      include_images?: boolean;
      client_name?: string;
    };
    const clientId = client_name || "claude-code";

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      throw new Error(
        `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
      );
    }

    const { doc } = await connectToNotebook(path, session.kernelId);
    const cells = doc.getArray("cells");

    // Resolve cell_id to "insert after" position
    let resolvedIndex = index;
    if (cell_id !== undefined) {
      if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
      resolvedIndex = resolveCellId(cells, cell_id) + 1; // insert after
    }

    // Create cell as Y.Map with Y.Text for source
    const newCell = new Y.Map();
    newCell.set("cell_type", "code");
    newCell.set("source", new Y.Text(source));
    newCell.set("metadata", new Y.Map());
    newCell.set("outputs", new Y.Array());
    newCell.set("execution_count", null);
    const newCellId = crypto.randomUUID();
    newCell.set("id", newCellId);

    const insertIndex = resolvedIndex === undefined || resolvedIndex === -1 ? cells.length : resolvedIndex;
    cells.insert(insertIndex, [newCell]);

    recordChange(path, {
      operation: "insert",
      cellId: newCellId,
      cellIdShort: newCellId.slice(0, 8),
      cellIndex: insertIndex,
      newSource: source,
      client: clientId,
    });

    // Execute the cell
    const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
    const result = await executeCode(session.kernelId, source, timeoutMs);

    // Update cell outputs in the notebook
    updateCellOutputs(newCell, result);

    const newId = newCellId.slice(0, 8);
    return { content: buildExecutionContent(result, `Inserted and executed cell at index ${insertIndex} (id: ${newId}) in ${path}\n\nOutput:\n`, { max_images, include_images }) };
  },

  "update_and_execute": async (args) => {
    const { path, index, cell_id, source, force = false, timeout, max_images, include_images, client_name } = args as {
      path: string;
      index?: number;
      cell_id?: string;
      source: string;
      force?: boolean;
      timeout?: number;
      max_images?: number;
      include_images?: boolean;
      client_name?: string;
    };
    const clientId = client_name || "claude-code";

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      throw new Error(
        `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
      );
    }

    const { doc, provider } = await connectToNotebook(path, session.kernelId);
    const cells = doc.getArray("cells");

    let resolvedIndex = index;
    if (cell_id !== undefined) {
      if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
      resolvedIndex = resolveCellId(cells, cell_id);
    }
    if (resolvedIndex === undefined) throw new Error("Either 'index' or 'cell_id' is required.");

    if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
      throw new Error(
        `Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`
      );
    }

    // Check human focus
    if (!force) {
      const focus = checkHumanFocus(provider, doc, resolvedIndex);
      if (focus.blocked) {
        const cellIdStr = truncatedCellId(cells.get(resolvedIndex) as any);
        throw new Error(`Cannot modify cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} — user "${focus.user}" is currently editing it. Use force=true to override.`);
      }
    }

    const cell = cells.get(resolvedIndex) as Y.Map<any>;

    // Check advisory lock
    let lockOverrideDetail: string | undefined;
    const fullCellId = getCellId(cell) || "";
    if (fullCellId) {
      const lock = checkLock(path, fullCellId, clientId);
      if (lock) {
        if (!force) {
          const cellIdStr = truncatedCellId(cell);
          throw new Error(`Cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} is locked by "${lock.owner}" (expires in ${formatTimeRemaining(Math.round((new Date(lock.expiresAt).getTime() - Date.now()) / 1000))}). Use force=true to override.`);
        }
        lockOverrideDetail = `force-overrode lock held by "${lock.owner}"`;
      }
    }

    // Update the cell source
    const oldSource = extractSource(cell);
    if (cell instanceof Y.Map) {
      const sourceField = cell.get("source");
      if (sourceField instanceof Y.Text) {
        sourceField.delete(0, sourceField.length);
        sourceField.insert(0, source);
      } else {
        cell.set("source", new Y.Text(source));
      }
    }

    recordChange(path, {
      operation: "update",
      cellId: getCellId(cell) || "",
      cellIdShort: truncatedCellId(cell) || "",
      cellIndex: resolvedIndex,
      oldSource,
      newSource: source,
      client: clientId,
      detail: lockOverrideDetail,
    });

    // Execute the cell
    const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
    const result = await executeCode(session.kernelId, source, timeoutMs);

    // Update cell outputs in the notebook
    if (cell instanceof Y.Map) {
      updateCellOutputs(cell, result);
    }

    // Generate diff
    const cellIdStr = truncatedCellId(cell);
    const diff = generateUnifiedDiff(oldSource, source, `${path}:cell[${resolvedIndex}]`);

    return { content: buildExecutionContent(result, `Updated and executed cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} in ${path}\n\n${truncateDiff(diff)}\n\nOutput:\n`, { max_images, include_images }) };
  },

  "execute_range": async (args) => {
    const { path, start_index, end_index, cell_ids, timeout } = args as {
      path: string;
      start_index?: number;
      end_index?: number;
      cell_ids?: string[];
      timeout?: number;
    };

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    if (!session?.kernelId) {
      throw new Error(
        `No kernel found for notebook '${path}'. Make sure the notebook has an active kernel.`
      );
    }

    const { doc } = await connectToNotebook(path, session.kernelId);
    const cells = doc.getArray("cells");

    // Resolve which indices to execute
    let indicesToExecute: number[];
    let rangeLabel: string;

    if (cell_ids && cell_ids.length > 0) {
      indicesToExecute = resolveCellIds(cells, cell_ids);
      rangeLabel = `${indicesToExecute.length} cells by ID`;
    } else {
      const startIdx = start_index ?? 0;
      const endIdx = end_index ?? cells.length - 1;
      if (startIdx < 0 || endIdx >= cells.length || startIdx > endIdx) {
        throw new Error(
          `Invalid range [${startIdx}, ${endIdx}]. Notebook has ${cells.length} cells.`
        );
      }
      indicesToExecute = [];
      for (let i = startIdx; i <= endIdx; i++) indicesToExecute.push(i);
      rangeLabel = `cells ${startIdx}-${endIdx}`;
    }

    const timeoutMs = Math.min(Math.max(timeout || 30000, 1000), 300000);
    const results: { index: number; cellId?: string; status: string; output?: string }[] = [];

    for (const i of indicesToExecute) {
      const cell = cells.get(i) as Y.Map<any>;
      const type = getCellType(cell);
      const cid = truncatedCellId(cell);

      if (type !== "code") {
        results.push({ index: i, cellId: cid, status: "skipped (not code)" });
        continue;
      }

      const source = extractSource(cell);
      if (!source.trim()) {
        results.push({ index: i, cellId: cid, status: "skipped (empty)" });
        continue;
      }

      try {
        const result = await executeCode(session.kernelId, source, timeoutMs);
        updateCellOutputs(cell, result);
        results.push({
          index: i,
          cellId: cid,
          status: result.status,
          output: result.text ? result.text.slice(0, 100) + (result.text.length > 100 ? "..." : "") : undefined,
        });
      } catch (err: any) {
        results.push({ index: i, cellId: cid, status: `error: ${err.message}` });
      }
    }

    const successCount = results.filter((r) => r.status === "ok").length;
    const errorCount = results.filter((r) => r.status === "error" || r.status.startsWith("error:")).length;

    return {
      content: [
        {
          type: "text",
          text: `Executed ${rangeLabel} in ${path}\n${successCount} succeeded, ${errorCount} failed\n\n${JSON.stringify(results, null, 2)}`,
        },
      ],
    };
  },

  "clear_outputs": async (args) => {
    const { path, index, cell_id, force = false } = args as {
      path: string;
      index?: number;
      cell_id?: string;
      force?: boolean;
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      let resolvedIndex = index;
      if (cell_id !== undefined) {
        if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
        resolvedIndex = resolveCellId(notebook.cells, cell_id);
      }

      if (resolvedIndex !== undefined) {
        if (resolvedIndex < 0 || resolvedIndex >= notebook.cells.length) {
          throw new Error(`Invalid cell index ${resolvedIndex}. Notebook has ${notebook.cells.length} cells.`);
        }
        const cell = notebook.cells[resolvedIndex];
        cell.outputs = [];
        cell.execution_count = null;
        await writeNotebook(resolved, notebook);
        return { content: [{ type: "text", text: `Cleared outputs from cell ${resolvedIndex} in ${path}` }] };
      } else {
        let clearedCount = 0;
        for (const cell of notebook.cells) {
          if (getCellType(cell) === "code") {
            if (cell.outputs && cell.outputs.length > 0) {
              clearedCount++;
            }
            cell.outputs = [];
            cell.execution_count = null;
          }
        }
        await writeNotebook(resolved, notebook);
        const message = clearedCount === 0
          ? `No cells had outputs to clear in ${path}`
          : `Cleared outputs from ${clearedCount} cell${clearedCount === 1 ? "" : "s"} in ${path}`;
        return { content: [{ type: "text", text: message }] };
      }
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc, provider } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    let resolvedIndex = index;
    if (cell_id !== undefined) {
      if (index !== undefined) throw new Error("Specify either 'index' or 'cell_id', not both.");
      resolvedIndex = resolveCellId(cells, cell_id);
    }

    if (resolvedIndex !== undefined) {
      // Clear single cell
      if (resolvedIndex < 0 || resolvedIndex >= cells.length) {
        throw new Error(`Invalid cell index ${resolvedIndex}. Notebook has ${cells.length} cells.`);
      }

      // Check human focus
      if (!force) {
        const focus = checkHumanFocus(provider, doc, resolvedIndex);
        if (focus.blocked) {
          const cellIdStr = truncatedCellId(cells.get(resolvedIndex) as any);
          throw new Error(`Cannot modify cell ${resolvedIndex}${cellIdStr ? ` (${cellIdStr})` : ""} — user "${focus.user}" is currently editing it. Use force=true to override.`);
        }
      }

      const cell = cells.get(resolvedIndex) as Y.Map<any>;
      const outputs = cell.get("outputs");
      if (outputs instanceof Y.Array && outputs.length > 0) {
        outputs.delete(0, outputs.length);
      }
      cell.set("execution_count", null);

      return {
        content: [
          {
            type: "text",
            text: `Cleared outputs from cell ${resolvedIndex} in ${path}`,
          },
        ],
      };
    } else {
      // Clear all cells
      let clearedCount = 0;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells.get(i) as Y.Map<any>;
        if (getCellType(cell) === "code") {
          const outputs = cell.get("outputs");
          if (outputs instanceof Y.Array && outputs.length > 0) {
            outputs.delete(0, outputs.length);
            clearedCount++;
          }
          cell.set("execution_count", null);
        }
      }

      const message = clearedCount === 0
        ? `No cells had outputs to clear in ${path}`
        : `Cleared outputs from ${clearedCount} cell${clearedCount === 1 ? "" : "s"} in ${path}`;

      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
      };
    }
  },

  "get_cell_outputs": async (args) => {
    const { path, index, end_index, indices, cell_ids, max_images, include_images } = args as {
      path: string;
      index?: number;
      end_index?: number;
      indices?: number[];
      cell_ids?: string[];
      max_images?: number;
      include_images?: boolean;
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      const effectiveIndices = cell_ids && cell_ids.length > 0
        ? resolveCellIds(notebook.cells, cell_ids)
        : indices;
      const { indices: cellIndices, description } = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });

      const results: any[] = [];
      for (const idx of cellIndices) {
        const cell = notebook.cells[idx];
        const type = getCellType(cell);

        if (type !== "code") {
          results.push({ index: idx, type, outputs: "(not a code cell)" });
          continue;
        }

        const executionCount = cell.execution_count;
        const outputs = cell.outputs;

        if (!outputs || outputs.length === 0) {
          const status = executionCount === null || executionCount === undefined ? "(not executed)" : "(no output)";
          results.push({ index: idx, type, execution_count: executionCount, outputs: status });
          continue;
        }

        const textParts: string[] = [];
        for (const out of outputs) {
          if (out.output_type === "stream") {
            textParts.push(out.text || "");
          } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
            if (out.data?.["text/plain"]) textParts.push(out.data["text/plain"]);
          } else if (out.output_type === "error") {
            textParts.push(`${out.ename}: ${out.evalue}`);
          }
        }

        results.push({
          index: idx,
          type,
          execution_count: executionCount,
          text: textParts.join(""),
          output_count: outputs.length,
        });
      }

      return {
        content: [{ type: "text", text: `Outputs from ${description} in ${path}:\n\n${JSON.stringify(results, null, 2)}` }],
      };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    const effectiveIndicesJup = cell_ids && cell_ids.length > 0
      ? resolveCellIds(cells, cell_ids)
      : indices;
    const { indices: cellIndices, description } = resolveCellIndices(cells.length, {
      index,
      end_index,
      indices: effectiveIndicesJup,
    });

    const results: any[] = [];
    const images: { data: string; mimeType: string }[] = [];

    for (const idx of cellIndices) {
      const cell = cells.get(idx) as Y.Map<any>;
      const type = getCellType(cell);

      if (type !== "code") {
        results.push({ index: idx, type, outputs: "(not a code cell)" });
        continue;
      }

      const outputs = cell.get("outputs");
      const executionCount = cell.get("execution_count");

      if (!outputs || !(outputs instanceof Y.Array) || outputs.length === 0) {
        // Distinguish "not executed" from "no output"
        const status = executionCount === null ? "(not executed)" : "(no output)";
        results.push({ index: idx, type, execution_count: executionCount, outputs: status });
        continue;
      }

      const outputsJson = outputs.toJSON();
      const textParts: string[] = [];

      for (const out of outputsJson) {
        if (out.output_type === "stream") {
          textParts.push(out.text || "");
        } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
          if (out.data?.["text/plain"]) {
            textParts.push(out.data["text/plain"]);
          }
          // Collect images
          if (out.data?.["image/png"]) {
            images.push({ data: out.data["image/png"], mimeType: "image/png" });
          }
          if (out.data?.["image/jpeg"]) {
            images.push({ data: out.data["image/jpeg"], mimeType: "image/jpeg" });
          }
        } else if (out.output_type === "error") {
          textParts.push(`${out.ename}: ${out.evalue}`);
        }
      }

      results.push({
        index: idx,
        type,
        execution_count: executionCount,
        text: textParts.join(""),
        output_count: outputsJson.length,
      });
    }

    const textContent = `Outputs from ${description} in ${path}:\n\n${JSON.stringify(results, null, 2)}`;
    const effectiveInclude = include_images !== false;
    const effectiveMax = max_images ?? images.length;

    const content: any[] = [{ type: "text", text: textContent }];

    if (effectiveInclude && images.length > 0) {
      if (images.length > effectiveMax) {
        const omitted = images.length - effectiveMax;
        content[0].text += `\n\n(showing last ${effectiveMax} of ${images.length} images — ${omitted} omitted, use max_images to adjust)`;
        for (const img of images.slice(-effectiveMax)) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
      } else {
        for (const img of images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
      }
    } else if (images.length > 0) {
      content[0].text += `\n\n(${images.length} image${images.length === 1 ? "" : "s"} not shown — set include_images=true or increase max_images to see them)`;
    }

    return { content };
  },
};
