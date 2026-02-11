import type { ToolResult } from "../handler-types.js";
import * as Y from "yjs";
import {
  extractSource,
  getCellType,
  getCodePreview,
  resolveCellIds,
  resolveCellIndices,
  truncatedCellId,
} from "../helpers.js";
import { readNotebook, resolveNotebookPath, writeNotebook } from "../notebook-fs.js";
import { connectToNotebook, isJupyterConnected, listNotebookSessions } from "../connection.js";

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  "get_cell_metadata": async (args) => {
    const { path, index, end_index, indices, cell_ids } = args as {
      path: string;
      index?: number;
      end_index?: number;
      indices?: number[];
      cell_ids?: string[];
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      const effectiveIndices = cell_ids && cell_ids.length > 0
        ? resolveCellIds(notebook.cells, cell_ids)
        : indices;
      const resolved2 = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });
      const results: any[] = [];
      for (const i of resolved2.indices) {
        const metadataJson = notebook.cells[i].metadata || {};
        results.push({ index: i, metadata: metadataJson, tags: metadataJson.tags || [] });
      }

      return {
        content: [{
          type: "text",
          text: results.length === 1
            ? `Cell ${resolved2.indices[0]} metadata:\n${JSON.stringify(results[0].metadata, null, 2)}`
            : `Metadata for ${resolved2.description}:\n${JSON.stringify(results, null, 2)}`,
        }],
      };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    const effectiveIndicesJup = cell_ids && cell_ids.length > 0
      ? resolveCellIds(cells, cell_ids)
      : indices;
    const resolved = resolveCellIndices(cells.length, { index, end_index, indices: effectiveIndicesJup });

    const results: any[] = [];
    for (const i of resolved.indices) {
      const cell = cells.get(i) as Y.Map<any>;
      const metadata = cell.get("metadata");
      const metadataJson = metadata instanceof Y.Map ? metadata.toJSON() : (metadata || {});
      results.push({
        index: i,
        metadata: metadataJson,
        tags: metadataJson.tags || [],
      });
    }

    return {
      content: [
        {
          type: "text",
          text: results.length === 1
            ? `Cell ${resolved.indices[0]} metadata:\n${JSON.stringify(results[0].metadata, null, 2)}`
            : `Metadata for ${resolved.description}:\n${JSON.stringify(results, null, 2)}`,
        },
      ],
    };
  },

  "set_cell_metadata": async (args) => {
    const { path, index, end_index, indices, cell_ids, metadata } = args as {
      path: string;
      index?: number;
      end_index?: number;
      indices?: number[];
      cell_ids?: string[];
      metadata: Record<string, any>;
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      const effectiveIndices = cell_ids && cell_ids.length > 0
        ? resolveCellIds(notebook.cells, cell_ids)
        : indices;
      const resolvedIndices = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });

      for (const i of resolvedIndices.indices) {
        const cell = notebook.cells[i];
        if (!cell.metadata) cell.metadata = {};

        for (const [key, value] of Object.entries(metadata)) {
          if (value === null) {
            delete cell.metadata[key];
          } else {
            cell.metadata[key] = value;
          }
        }
      }

      await writeNotebook(resolved, notebook);
      return { content: [{ type: "text", text: `Updated metadata on ${resolvedIndices.description}` }] };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    const effectiveIndicesJup = cell_ids && cell_ids.length > 0
      ? resolveCellIds(cells, cell_ids)
      : indices;
    const resolved = resolveCellIndices(cells.length, { index, end_index, indices: effectiveIndicesJup });

    for (const i of resolved.indices) {
      const cell = cells.get(i) as Y.Map<any>;
      let cellMetadata = cell.get("metadata");

      if (!(cellMetadata instanceof Y.Map)) {
        cellMetadata = new Y.Map();
        cell.set("metadata", cellMetadata);
      }

      // Merge metadata
      for (const [key, value] of Object.entries(metadata)) {
        if (value === null) {
          cellMetadata.delete(key);
        } else if (Array.isArray(value)) {
          const arr = new Y.Array();
          arr.push(value);
          cellMetadata.set(key, arr);
        } else if (typeof value === "object") {
          const map = new Y.Map();
          for (const [k, v] of Object.entries(value)) {
            map.set(k, v);
          }
          cellMetadata.set(key, map);
        } else {
          cellMetadata.set(key, value);
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Updated metadata on ${resolved.description}`,
        },
      ],
    };
  },

  "add_cell_tags": async (args) => {
    const { path, index, end_index, indices, cell_ids, tags } = args as {
      path: string;
      index?: number;
      end_index?: number;
      indices?: number[];
      cell_ids?: string[];
      tags: string[];
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      const effectiveIndices = cell_ids && cell_ids.length > 0
        ? resolveCellIds(notebook.cells, cell_ids)
        : indices;
      const resolvedIndices = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });

      for (const i of resolvedIndices.indices) {
        const cell = notebook.cells[i];
        if (!cell.metadata) cell.metadata = {};
        if (!Array.isArray(cell.metadata.tags)) cell.metadata.tags = [];
        for (const tag of tags) {
          if (!cell.metadata.tags.includes(tag)) {
            cell.metadata.tags.push(tag);
          }
        }
      }

      await writeNotebook(resolved, notebook);
      return { content: [{ type: "text", text: `Added tags [${tags.join(", ")}] to ${resolvedIndices.description}` }] };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    const effectiveIndicesJup = cell_ids && cell_ids.length > 0
      ? resolveCellIds(cells, cell_ids)
      : indices;
    const resolved = resolveCellIndices(cells.length, { index, end_index, indices: effectiveIndicesJup });

    for (const i of resolved.indices) {
      const cell = cells.get(i) as Y.Map<any>;
      let cellMetadata = cell.get("metadata");

      if (!(cellMetadata instanceof Y.Map)) {
        cellMetadata = new Y.Map();
        cell.set("metadata", cellMetadata);
      }

      // Get or create tags array
      let existingTags = cellMetadata.get("tags");
      let tagsArray: string[];

      if (existingTags instanceof Y.Array) {
        tagsArray = existingTags.toJSON() as string[];
      } else if (Array.isArray(existingTags)) {
        tagsArray = existingTags;
      } else {
        tagsArray = [];
      }

      // Add new tags (avoid duplicates)
      for (const tag of tags) {
        if (!tagsArray.includes(tag)) {
          tagsArray.push(tag);
        }
      }

      // Set as Y.Array
      const newTagsArray = new Y.Array();
      newTagsArray.push(tagsArray);
      cellMetadata.set("tags", newTagsArray);
    }

    return {
      content: [
        {
          type: "text",
          text: `Added tags [${tags.join(", ")}] to ${resolved.description}`,
        },
      ],
    };
  },

  "remove_cell_tags": async (args) => {
    const { path, index, end_index, indices, cell_ids, tags } = args as {
      path: string;
      index?: number;
      end_index?: number;
      indices?: number[];
      cell_ids?: string[];
      tags: string[];
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      const effectiveIndices = cell_ids && cell_ids.length > 0
        ? resolveCellIds(notebook.cells, cell_ids)
        : indices;
      const resolvedIndices = resolveCellIndices(notebook.cells.length, { index, end_index, indices: effectiveIndices });

      for (const i of resolvedIndices.indices) {
        const cell = notebook.cells[i];
        if (!cell.metadata?.tags || !Array.isArray(cell.metadata.tags)) continue;
        cell.metadata.tags = cell.metadata.tags.filter((t: string) => !tags.includes(t));
      }

      await writeNotebook(resolved, notebook);
      return { content: [{ type: "text", text: `Removed tags [${tags.join(", ")}] from ${resolvedIndices.description}` }] };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    const effectiveIndicesJup = cell_ids && cell_ids.length > 0
      ? resolveCellIds(cells, cell_ids)
      : indices;
    const resolved = resolveCellIndices(cells.length, { index, end_index, indices: effectiveIndicesJup });

    for (const i of resolved.indices) {
      const cell = cells.get(i) as Y.Map<any>;
      const cellMetadata = cell.get("metadata");

      if (!(cellMetadata instanceof Y.Map)) continue;

      let existingTags = cellMetadata.get("tags");
      let tagsArray: string[];

      if (existingTags instanceof Y.Array) {
        tagsArray = existingTags.toJSON() as string[];
      } else if (Array.isArray(existingTags)) {
        tagsArray = existingTags;
      } else {
        continue; // No tags to remove
      }

      // Remove specified tags
      tagsArray = tagsArray.filter((t) => !tags.includes(t));

      // Set as Y.Array
      const newTagsArray = new Y.Array();
      newTagsArray.push(tagsArray);
      cellMetadata.set("tags", newTagsArray);
    }

    return {
      content: [
        {
          type: "text",
          text: `Removed tags [${tags.join(", ")}] from ${resolved.description}`,
        },
      ],
    };
  },

  "find_cells_by_tag": async (args) => {
    const { path, tags, match_all = false, include_preview = false } = args as {
      path: string;
      tags: string[];
      match_all?: boolean;
      include_preview?: boolean;
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      const matches: any[] = [];
      for (let i = 0; i < notebook.cells.length; i++) {
        const cell = notebook.cells[i];
        const type = getCellType(cell);
        const cellTags: string[] = Array.isArray(cell.metadata?.tags) ? cell.metadata.tags : [];
        if (cellTags.length === 0) continue;

        const hasMatch = match_all
          ? tags.every((t) => cellTags.includes(t))
          : tags.some((t) => cellTags.includes(t));

        if (hasMatch) {
          const result: any = { index: i, id: truncatedCellId(cell), type, tags: cellTags };
          if (include_preview) result.preview = getCodePreview(extractSource(cell));
          matches.push(result);
        }
      }

      return {
        content: [{ type: "text", text: `Found ${matches.length} cells with tag(s) [${tags.join(", ")}]${match_all ? " (match all)" : ""}:\n\n${JSON.stringify(matches, null, 2)}` }],
      };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const cells = doc.getArray("cells");

    const matches: any[] = [];

    for (let i = 0; i < cells.length; i++) {
      const cell = cells.get(i) as Y.Map<any>;
      const type = getCellType(cell);
      const cellMetadata = cell.get("metadata");

      let cellTags: string[] = [];
      if (cellMetadata instanceof Y.Map) {
        const tagsValue = cellMetadata.get("tags");
        if (tagsValue instanceof Y.Array) {
          cellTags = tagsValue.toJSON() as string[];
        } else if (Array.isArray(tagsValue)) {
          cellTags = tagsValue;
        }
      }

      if (cellTags.length === 0) continue;

      const hasMatch = match_all
        ? tags.every((t) => cellTags.includes(t))
        : tags.some((t) => cellTags.includes(t));

      if (hasMatch) {
        const result: any = {
          index: i,
          id: truncatedCellId(cell),
          type,
          tags: cellTags,
        };
        if (include_preview) {
          const source = extractSource(cell);
          result.preview = getCodePreview(source);
        }
        matches.push(result);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Found ${matches.length} cells with tag(s) [${tags.join(", ")}]${match_all ? " (match all)" : ""}:\n\n${JSON.stringify(matches, null, 2)}`,
        },
      ],
    };
  },

  "get_notebook_metadata": async (args) => {
    const { path } = args as { path: string };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);
      return {
        content: [{ type: "text", text: `Notebook metadata for ${path}:\n${JSON.stringify(notebook.metadata, null, 2)}` }],
      };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const meta = doc.getMap("meta");
    const metadata = meta.get("metadata");

    const metadataJson = metadata instanceof Y.Map ? metadata.toJSON() : (metadata || {});

    return {
      content: [
        {
          type: "text",
          text: `Notebook metadata for ${path}:\n${JSON.stringify(metadataJson, null, 2)}`,
        },
      ],
    };
  },

  "set_notebook_metadata": async (args) => {
    const { path, metadata } = args as {
      path: string;
      metadata: Record<string, any>;
    };

    if (!isJupyterConnected()) {
      const resolved = resolveNotebookPath(path);
      const notebook = await readNotebook(resolved);

      for (const [key, value] of Object.entries(metadata)) {
        if (value === null) {
          delete notebook.metadata[key];
        } else {
          notebook.metadata[key] = value;
        }
      }

      await writeNotebook(resolved, notebook);
      return { content: [{ type: "text", text: `Updated notebook metadata for ${path}` }] };
    }

    const sessions = await listNotebookSessions();
    const session = sessions.find((s) => s.path === path);

    const { doc } = await connectToNotebook(path, session?.kernelId);
    const meta = doc.getMap("meta");
    const existingMetadata = meta.get("metadata");

    let notebookMetadata: Y.Map<any>;
    if (existingMetadata instanceof Y.Map) {
      notebookMetadata = existingMetadata;
    } else {
      notebookMetadata = new Y.Map();
      meta.set("metadata", notebookMetadata);
    }

    // Merge metadata
    for (const [key, value] of Object.entries(metadata)) {
      if (value === null) {
        notebookMetadata.delete(key);
      } else if (typeof value === "object" && !Array.isArray(value)) {
        // For nested objects like kernelspec, create Y.Map
        const map = new Y.Map();
        for (const [k, v] of Object.entries(value)) {
          map.set(k, v);
        }
        notebookMetadata.set(key, map);
      } else {
        notebookMetadata.set(key, value);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Updated notebook metadata for ${path}`,
        },
      ],
    };
  },
};
