export const toolSchemas = [
  {
    name: "connect_jupyter",
    description:
      "Connect to JupyterLab for real-time sync and kernel execution. Without connecting, tools still work by reading .ipynb files directly.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "JupyterLab URL with token (e.g., http://localhost:8888/lab?token=abc123)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories. Use to discover notebooks.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path. Default: root",
        },
      },
    },
  },
  {
    name: "list_notebooks",
    description:
      "List notebooks with running kernels. Use list_files for all .ipynb files regardless of kernel state.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_kernels",
    description:
      "List available kernel types (e.g., python3, ir) and running instances.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "open_notebook",
    description:
      "Open a notebook and start a kernel. Safe to call if already open. Required before executing cells.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        kernel_name: {
          type: "string",
          description: "Kernel to use. Default: notebook's default",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create_notebook",
    description:
      "Create a new notebook. Optionally open it with a kernel.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path for new notebook" },
        kernel_name: {
          type: "string",
          description: "Kernel to use. Default: python3",
        },
        open: {
          type: "boolean",
          description: "Open after creation. Default: true",
        },
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", description: "Cell source" },
              cell_type: {
                type: "string",
                enum: ["code", "markdown"],
                description: "Default: code",
              },
            },
            required: ["source"],
          },
          description: "Initial cells",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_notebook_content",
    description:
      "Read cells from a notebook. Returns source only (no outputs) by default. Set include_outputs=true to see results.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        cell_type: {
          type: "string",
          enum: ["all", "code", "markdown"],
          description: "Default: 'code' (skips markdown)",
        },
        include_outputs: {
          type: "boolean",
          description: "Include outputs. Default: false",
        },
        output_format: {
          type: "string",
          enum: ["text", "structured"],
          description: "'text' (default): text/plain only. 'structured': full output metadata",
        },
        start_index: { type: "number", description: "Start cell index. Default: 0" },
        end_index: { type: "number", description: "End cell index (inclusive). Default: last" },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Non-contiguous cell indices. Overrides start/end_index.",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Select by cell ID (prefix match). Overrides indices.",
        },
        max_output_chars: {
          type: "number",
          description: "Truncate output per cell. Default: 500. Set 0 for unlimited.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_notebook_outline",
    description:
      "Condensed notebook structure: markdown headers by level + code cell previews. Use to find cell indices.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_notebook",
    description:
      "Grep through notebook cells (regex). Returns matching cells with context.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        pattern: { type: "string", description: "Search pattern (regex)" },
        search_in: {
          type: "string",
          enum: ["source", "outputs", "all"],
          description: "Default: 'all'",
        },
        case_sensitive: { type: "boolean", description: "Default: false" },
        max_results: { type: "number", description: "Max matching cells" },
        context_lines: {
          type: "number",
          description: "Lines around each match. Default: 1",
        },
      },
      required: ["path", "pattern"],
    },
  },
  {
    name: "replace_in_notebook",
    description:
      "Search and replace across cells. Returns replacement count per cell.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        search: { type: "string", description: "Text or regex to find" },
        replace: { type: "string", description: "Replacement text" },
        cell_type: {
          type: "string",
          enum: ["code", "markdown", "all"],
          description: "Default: 'code'",
        },
        case_sensitive: { type: "boolean", description: "Default: false" },
        regex: { type: "boolean", description: "Treat search as regex. Default: false" },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Limit to these cells. Default: all",
        },
        dry_run: { type: "boolean", description: "Preview only. Default: false" },
      },
      required: ["path", "search", "replace"],
    },
  },
  {
    name: "rename_symbol",
    description:
      "Scope-aware Python rename across all cells. Won't rename in strings/comments.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        cell_index: { type: "number", description: "Cell containing the symbol" },
        line: { type: "number", description: "Line (0-indexed)" },
        character: { type: "number", description: "Column (0-indexed)" },
        new_name: { type: "string", description: "New symbol name" },
      },
      required: ["path", "cell_index", "line", "character", "new_name"],
    },
  },
  {
    name: "get_diagnostics",
    description:
      "Static code diagnostics (errors, warnings) without executing. Uses LSP or Python syntax checking.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        cell_index: { type: "number", description: "Single cell. Default: all code cells" },
        cell_id: { type: "string", description: "Cell ID (alternative to cell_index)" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_hover_info",
    description:
      "Documentation/type info for code at a position. Uses LSP or kernel introspection.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        cell_index: { type: "number", description: "Cell index" },
        line: { type: "number", description: "Line (0-indexed)" },
        character: { type: "number", description: "Column (0-indexed)" },
      },
      required: ["path", "cell_index", "line", "character"],
    },
  },
  {
    name: "get_user_focus",
    description:
      "Which cell the user is editing (cursor position via awareness protocol). Returns null if no active user.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
      },
      required: ["path"],
    },
  },
  {
    name: "insert_cell",
    description:
      "Insert a cell. Set execute=true to run it immediately.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        index: { type: "number", description: "Position (0=start, omit=end)" },
        cell_id: { type: "string", description: "Insert after this cell ID" },
        source: { type: "string", description: "Cell source code" },
        cell_type: { type: "string", enum: ["code", "markdown"], description: "Default: code" },
        execute: { type: "boolean", description: "Execute after insert. Default: false" },
        timeout: { type: "number", description: "Execution timeout ms. Default: 30000" },
        max_images: { type: "number", description: "Max images to return" },
        include_images: { type: "boolean", description: "Return images. Default: true" },
        client_name: { type: "string", description: "Agent name for attribution. Default: 'claude-code'" },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "update_cell",
    description: "Update a cell's source. Set execute=true to run it after updating.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        index: { type: "number", description: "Cell index" },
        cell_id: { type: "string", description: "Cell ID (alternative to index)" },
        source: { type: "string", description: "New source code" },
        force: { type: "boolean", description: "Override human-focus protection. Default: false" },
        execute: { type: "boolean", description: "Execute after update. Default: false" },
        timeout: { type: "number", description: "Execution timeout ms. Default: 30000" },
        max_images: { type: "number", description: "Max images to return" },
        include_images: { type: "boolean", description: "Return images. Default: true" },
        show_diff: { type: "boolean", description: "Include source diff. Default: false" },
        client_name: { type: "string", description: "Agent name for attribution. Default: 'claude-code'" },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "batch_update_cells",
    description:
      "Update multiple cells atomically. More efficient than repeated update_cell.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number", description: "Cell index" },
              source: { type: "string", description: "New source" },
            },
            required: ["index", "source"],
          },
          description: "Array of {index, source} updates",
        },
        client_name: { type: "string", description: "Agent name for attribution. Default: 'claude-code'" },
      },
      required: ["path", "updates"],
    },
  },
  {
    name: "batch_insert_cells",
    description:
      "Insert multiple cells at once. Indices auto-adjust for prior insertions.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        inserts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", description: "Cell source" },
              cell_type: { type: "string", enum: ["code", "markdown"], description: "Default: code" },
              cell_id: { type: "string", description: "Insert after this cell ID" },
              index: { type: "number", description: "Position (0=start, omit=end)" },
            },
            required: ["source"],
          },
          description: "Cells to insert in order",
        },
        client_name: { type: "string", description: "Agent name for attribution. Default: 'claude-code'" },
      },
      required: ["path", "inserts"],
    },
  },
  {
    name: "delete_cell",
    description: "Delete cells. Single: index or cell_id. Batch: indices[], cell_ids[], or start_index+end_index.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        index: { type: "number", description: "Cell index" },
        cell_id: { type: "string", description: "Cell ID (alternative to index)" },
        indices: { type: "array", items: { type: "number" }, description: "Multiple indices" },
        cell_ids: { type: "array", items: { type: "string" }, description: "Multiple cell IDs" },
        start_index: { type: "number", description: "Range start (inclusive)" },
        end_index: { type: "number", description: "Range end (inclusive)" },
        force: { type: "boolean", description: "Override human-focus/lock protection. Default: false" },
        client_name: { type: "string", description: "Agent name for attribution. Default: 'claude-code'" },
      },
      required: ["path"],
    },
  },
  {
    name: "change_cell_type",
    description:
      "Convert cell type (code <-> markdown) in place.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        index: { type: "number", description: "Cell index" },
        cell_id: { type: "string", description: "Cell ID (alternative to index)" },
        new_type: { type: "string", enum: ["code", "markdown"], description: "Target type" },
        force: { type: "boolean", description: "Override human-focus protection. Default: false" },
      },
      required: ["path", "new_type"],
    },
  },
  {
    name: "copy_cells",
    description:
      "Copy or move cells between notebooks. Set delete_source=true to move.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: { type: "string", description: "Source notebook" },
        dest_path: { type: "string", description: "Destination notebook" },
        start_index: { type: "number", description: "First cell (inclusive)" },
        end_index: { type: "number", description: "Last cell (inclusive)" },
        cell_ids: { type: "array", items: { type: "string" }, description: "Cell IDs to copy (alternative to range)" },
        dest_index: { type: "number", description: "Insert position. Default: end" },
        dest_cell_id: { type: "string", description: "Insert after this cell ID in destination" },
        delete_source: { type: "boolean", description: "Move instead of copy. Default: false" },
        client_name: { type: "string", description: "Agent name for attribution. Default: 'claude-code'" },
      },
      required: ["source_path", "dest_path"],
    },
  },
  {
    name: "execute_cell",
    description:
      "Execute notebook cells. Single cell: use index/cell_id. Range: add end_index. By IDs: use cell_ids[]. Skips non-code cells in range mode.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        index: { type: "number", description: "Cell index (or range start)" },
        cell_id: { type: "string", description: "Cell ID (single cell mode)" },
        end_index: { type: "number", description: "Last cell (inclusive) for range execution" },
        cell_ids: { type: "array", items: { type: "string" }, description: "Execute these cells in order" },
        timeout: { type: "number", description: "Timeout ms (per cell in range). Default: 30000" },
        max_images: { type: "number", description: "Max images to return" },
        include_images: { type: "boolean", description: "Return images. Default: true" },
      },
      required: ["path"],
    },
  },
  {
    name: "execute_code",
    description:
      "Run code in kernel without modifying the notebook. Use insert_cell(execute=true) to also add it as a cell.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path (identifies kernel)" },
        code: { type: "string", description: "Code to execute" },
        timeout: { type: "number", description: "Timeout ms. Default: 30000" },
        max_images: { type: "number", description: "Max images to return" },
        include_images: { type: "boolean", description: "Return images. Default: true" },
      },
      required: ["path", "code"],
    },
  },
  {
    name: "clear_outputs",
    description:
      "Clear execution outputs. Omit index to clear all cells.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        index: { type: "number", description: "Cell index. Default: all cells" },
        cell_id: { type: "string", description: "Cell ID (alternative to index)" },
        force: { type: "boolean", description: "Override human-focus protection. Default: false" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_cell_outputs",
    description:
      "Read cell outputs without source code. Supports single cell, range, or non-contiguous selection.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        index: { type: "number", description: "Cell index (or range start)" },
        end_index: { type: "number", description: "Range end (inclusive)" },
        indices: { type: "array", items: { type: "number" }, description: "Non-contiguous indices" },
        cell_ids: { type: "array", items: { type: "string" }, description: "Cell IDs (alternative)" },
        max_images: { type: "number", description: "Max images to return" },
        include_images: { type: "boolean", description: "Return images. Default: true" },
      },
      required: ["path"],
    },
  },
  {
    name: "filter_output",
    description:
      "Filter cached execution output with grep/head/tail. Use after execute_cell or execute_code — avoids re-executing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        execution_id: { type: "string", description: "Specific execution ID. Default: most recent" },
        grep: { type: "string", description: "Regex line filter" },
        tail: { type: "number", description: "Last N lines" },
        head: { type: "number", description: "First N lines" },
        max_lines: { type: "number", description: "Head/tail split truncation. 0=unlimited" },
        max_images: { type: "number", description: "Max images" },
        include_images: { type: "boolean", description: "Return images. Default: true" },
      },
      required: ["path"],
    },
  },
  {
    name: "cell_metadata",
    description: "Get or set cell metadata. Omit 'metadata' to GET, provide to SET (merges, null deletes keys).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        index: { type: "number", description: "Cell index (or range start)" },
        end_index: { type: "number", description: "Range end (inclusive)" },
        indices: { type: "array", items: { type: "number" }, description: "Specific indices" },
        cell_ids: { type: "array", items: { type: "string" }, description: "Cell IDs (prefix match)" },
        metadata: { type: "object", description: "Metadata to set. Omit to GET." },
      },
      required: ["path"],
    },
  },
  {
    name: "cell_tags",
    description: "Add, remove, or find tags on cells. Common: 'hide-input', 'hide-output', 'parameters'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        action: { type: "string", enum: ["add", "remove", "find"], description: "Tag operation" },
        index: { type: "number", description: "Cell index (or range start)" },
        end_index: { type: "number", description: "Range end (inclusive)" },
        indices: { type: "array", items: { type: "number" }, description: "Specific indices" },
        cell_ids: { type: "array", items: { type: "string" }, description: "Cell IDs (prefix match)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to add/remove/find" },
        match_all: { type: "boolean", description: "find: require ALL tags. Default: any" },
        include_preview: { type: "boolean", description: "find: show first line. Default: false" },
      },
      required: ["path", "action", "tags"],
    },
  },
  {
    name: "notebook_metadata",
    description: "Get or set notebook-level metadata. Omit 'metadata' to GET, provide to SET.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        metadata: { type: "object", description: "Metadata to set. Omit to GET." },
      },
      required: ["path"],
    },
  },
  {
    name: "kernel",
    description: "Kernel control: status, interrupt, or restart.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        action: { type: "string", enum: ["status", "interrupt", "restart"], description: "Operation" },
      },
      required: ["path", "action"],
    },
  },
  {
    name: "kernel_variables",
    description: "List or inspect kernel variables. Without 'names': lists all. With 'names': deep inspect (columns, dtypes, shapes).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Variables to inspect in detail (max 20). Omit to list all.",
        },
        detail: {
          type: "string",
          enum: ["basic", "schema", "full"],
          description: "List detail: 'basic' (default), 'schema' (one-line summaries), 'full' (dicts)",
        },
        filter: { type: "string", description: "Name substring filter" },
        include_private: { type: "boolean", description: "Include _vars. Default: false" },
        max_variables: { type: "number", description: "Max vars. Default: 50" },
        max_items: { type: "number", description: "Max columns/keys per var. Default: 20" },
        max_name_length: { type: ["number", "null"], description: "Max name chars. Default: 60. null=unlimited" },
      },
      required: ["path"],
    },
  },
  {
    name: "rename_notebook",
    description: "Rename a notebook file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Current path" },
        new_path: { type: "string", description: "New path (.ipynb)" },
      },
      required: ["path", "new_path"],
    },
  },
  {
    name: "diff_notebooks",
    description:
      "Compare two notebooks cell by cell. Returns unified diff.",
    inputSchema: {
      type: "object",
      properties: {
        path1: { type: "string", description: "First notebook" },
        path2: { type: "string", description: "Second notebook" },
        include_outputs: { type: "boolean", description: "Diff outputs too. Default: false" },
        summary_only: { type: "boolean", description: "Counts only. Default: false" },
        max_diffs: { type: "number", description: "Max cell diffs to show" },
      },
      required: ["path1", "path2"],
    },
  },
  {
    name: "get_cell_history",
    description:
      "Change history for a cell: who, when, old/new content. Session-scoped.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        cell_id: { type: "string", description: "Cell ID (prefix match)" },
        limit: { type: "number", description: "Max entries. Default: 20" },
      },
      required: ["path", "cell_id"],
    },
  },
  {
    name: "get_notebook_changes",
    description:
      "Changes since a version number (polling pattern). Use since_version=0 for all.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        since_version: { type: "number", description: "Version to poll from. 0=all" },
        limit: { type: "number", description: "Max changes. Default: 50" },
      },
      required: ["path"],
    },
  },
  {
    name: "recover_cell",
    description:
      "Re-insert a deleted cell from change history. Session-scoped.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        cell_id: { type: "string", description: "Deleted cell ID (prefix match)" },
        index: { type: "number", description: "Insert position. Default: end" },
        client_name: { type: "string", description: "Agent name for attribution. Default: 'claude-code'" },
      },
      required: ["path", "cell_id"],
    },
  },
  {
    name: "snapshot",
    description: "Notebook snapshots: save, restore, list, or diff against current.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        action: { type: "string", enum: ["save", "restore", "list", "diff"], description: "Operation" },
        name: { type: "string", description: "Snapshot name (required for save/restore/diff)" },
        description: { type: "string", description: "What this captures (save only)" },
      },
      required: ["path", "action"],
    },
  },
  {
    name: "cell_locks",
    description: "Advisory cell locks: acquire, release, or list.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Notebook path" },
        action: { type: "string", enum: ["acquire", "release", "list"], description: "Operation" },
        cell_ids: { type: "array", items: { type: "string" }, description: "Cell IDs (required for acquire/release)" },
        owner: { type: "string", description: "Lock owner. Default: 'claude-code'" },
        ttl_minutes: { type: "number", description: "Lock duration (acquire). Default: 10" },
        force: { type: "boolean", description: "Force release any owner. Default: false" },
      },
      required: ["path", "action"],
    },
  },
  {
    name: "report_issue",
    description:
      "Report a tool bug, hang, or suggestion. Persisted to JSONL for review.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["tool_bug", "hang", "missing_feature", "observation", "user_feedback"],
        },
        summary: { type: "string", description: "One-line description" },
        tool_name: { type: "string", description: "Which tool" },
        path: { type: "string", description: "Notebook path" },
        details: { type: "string", description: "Error messages or repro steps" },
      },
      required: ["category", "summary"],
    },
  },
];
