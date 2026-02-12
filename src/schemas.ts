export const toolSchemas = [
  {
    name: "connect_jupyter",
    description:
      "Connect to a JupyterLab server. Required for kernel operations (execute, restart, etc.) and real-time sync. Many tools (reading, editing, search) work without connecting by reading .ipynb files directly. Provide the full URL with token (e.g., http://localhost:8888/lab?token=abc123).",
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
      "List files and directories in the Jupyter file system. Use to discover available notebooks.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list. Default: '' (root)",
        },
      },
    },
  },
  {
    name: "list_notebooks",
    description:
      "List notebooks with active kernel sessions. Requires JupyterLab connection. Only shows notebooks where a kernel is running (not just open in browser). Use open_notebook to start a kernel, or list_files to see all .ipynb files regardless of kernel state. Returns paths and kernel IDs.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_kernels",
    description:
      "List available kernel types and running kernel instances. Requires JupyterLab connection. Returns kernel specs (e.g., python3, ir, julia) and active kernel sessions with their status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "open_notebook",
    description:
      "Open a notebook and start a kernel session. Requires JupyterLab connection. Safe to call if already open (will reuse existing kernel). Required before executing cells in a notebook not yet listed by list_notebooks.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path (e.g., 'analysis.ipynb' or 'projects/notebook.ipynb')",
        },
        kernel_name: {
          type: "string",
          description: "Kernel to use (e.g., 'python3'). Default: notebook's default kernel",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create_notebook",
    description:
      "Create a new notebook file. Optionally open it immediately with a kernel.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path for new notebook (e.g., 'new_analysis.ipynb')",
        },
        kernel_name: {
          type: "string",
          description: "Kernel to use (e.g., 'python3'). Default: 'python3'",
        },
        open: {
          type: "boolean",
          description: "Open the notebook after creation. Default: true",
        },
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", description: "Cell source code" },
              cell_type: {
                type: "string",
                enum: ["code", "markdown"],
                description: "Cell type (default: code)",
              },
            },
            required: ["source"],
          },
          description:
            "Optional initial cells to populate the notebook with",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_notebook_content",
    description:
      "Get cells from a notebook. By default returns only source code (no outputs) to save context. Use include_outputs=true only when you need to see execution results. Use cell_type='code' to skip markdown cells.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path (e.g., 'notebook1.ipynb')",
        },
        cell_type: {
          type: "string",
          enum: ["all", "code", "markdown"],
          description: "Filter by cell type: 'code' (default) for just code, 'markdown' for prose only, 'all' for everything",
        },
        include_outputs: {
          type: "boolean",
          description: "Include cell outputs. Default: false",
        },
        output_format: {
          type: "string",
          enum: ["text", "structured"],
          description: "Output format: 'text' (default) returns just text/plain as a string, 'structured' returns full output metadata",
        },
        start_index: {
          type: "number",
          description: "Start from this cell index. Default: 0",
        },
        end_index: {
          type: "number",
          description: "End at this cell index (inclusive). Default: last cell",
        },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Specific cell indices for non-contiguous selection (e.g., [2,5,8]). Takes precedence over start_index/end_index.",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Select cells by ID (prefix match). Takes precedence over indices and start_index/end_index.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_notebook_outline",
    description:
      "Get a condensed outline of the notebook structure. Returns cell indices with markdown headers (by level) and first line preview of code cells. Useful for navigating and finding cell indices before using update_cell or add_cell_tags.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_notebook",
    description:
      "Search/grep through notebook cells for a pattern (regex supported). Returns matching cell indices and content. Use to find cell indices before update_cell or add_cell_tags.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        pattern: {
          type: "string",
          description: "Search pattern (regex supported)",
        },
        search_in: {
          type: "string",
          enum: ["source", "outputs", "all"],
          description: "Where to search: 'source' (code), 'outputs', or 'all' (default)",
        },
        case_sensitive: {
          type: "boolean",
          description: "Case-sensitive search. Default: false",
        },
        max_results: {
          type: "number",
          description: "Maximum number of matching cells to return. Default: unlimited",
        },
        max_source_length: {
          type: "number",
          description: "Truncate source/output to this length (adds ... if truncated). Default: 500",
        },
      },
      required: ["path", "pattern"],
    },
  },
  {
    name: "replace_in_notebook",
    description:
      "Search and replace text across notebook cells. Useful for refactoring (renaming variables, functions, etc.). Returns count of replacements made per cell.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        search: {
          type: "string",
          description: "Text or pattern to search for (regex supported)",
        },
        replace: {
          type: "string",
          description: "Replacement text",
        },
        cell_type: {
          type: "string",
          enum: ["code", "markdown", "all"],
          description: "Cell types to search: 'code' (default), 'markdown', or 'all'",
        },
        case_sensitive: {
          type: "boolean",
          description: "Case-sensitive search. Default: false",
        },
        regex: {
          type: "boolean",
          description: "Treat search as regex pattern. Default: false (literal string match)",
        },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Only replace in these cell indices. If omitted, replaces in all matching cells.",
        },
        dry_run: {
          type: "boolean",
          description: "If true, only show what would be replaced without making changes. Default: false",
        },
      },
      required: ["path", "search", "replace"],
    },
  },
  {
    name: "rename_symbol",
    description:
      "Rename a Python symbol (variable, function, import) across all cells. Uses scope-aware analysis — won't rename occurrences in strings or comments. Requires jedi (auto-installed via uvx).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        cell_index: {
          type: "number",
          description: "Which cell contains the symbol to rename (0-indexed)",
        },
        line: {
          type: "number",
          description: "Line within the cell (0-indexed)",
        },
        character: {
          type: "number",
          description: "Column within the line (0-indexed)",
        },
        new_name: {
          type: "string",
          description: "The new name for the symbol",
        },
      },
      required: ["path", "cell_index", "line", "character", "new_name"],
    },
  },
  {
    name: "get_diagnostics",
    description:
      "Get code diagnostics (errors, warnings) for a notebook without executing it. Uses LSP if available for rich static analysis, otherwise falls back to Python syntax checking. Useful for validating code changes before execution.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        cell_index: {
          type: "number",
          description: "Check only this cell. If omitted, checks all code cells.",
        },
        cell_id: {
          type: "string",
          description: "Check only this cell by ID (alternative to cell_index). Use the ID shown in get_notebook_content output.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_hover_info",
    description:
      "Get documentation/type info for code at a specific position. Requires JupyterLab connection. Uses LSP if available, otherwise falls back to kernel introspection. Useful for understanding unfamiliar code.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        cell_index: {
          type: "number",
          description: "Cell index containing the code",
        },
        line: {
          type: "number",
          description: "Line number within the cell (0-indexed)",
        },
        character: {
          type: "number",
          description: "Character position within the line (0-indexed)",
        },
      },
      required: ["path", "cell_index", "line", "character"],
    },
  },
  {
    name: "get_user_focus",
    description:
      "Get the cell the user is currently focused on via JupyterLab's awareness protocol. Requires JupyterLab connection. Returns active cell index and cursor position. Returns null/empty if no user is actively editing the notebook.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "insert_cell",
    description:
      "Insert a new cell into the notebook. Changes sync in real-time to JupyterLab browser. Returns a diff showing what was inserted.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description:
            "Position to insert (0 = beginning, -1 or omit = end)",
        },
        cell_id: {
          type: "string",
          description: "Insert after the cell with this ID (alternative to index). Use the ID shown in get_notebook_content output.",
        },
        source: {
          type: "string",
          description: "Cell source code",
        },
        cell_type: {
          type: "string",
          enum: ["code", "markdown"],
          description: "Cell type (default: code)",
        },
        client_name: {
          type: "string",
          description: "Optional agent/client name for change attribution and lock owner matching (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "update_cell",
    description: "Update the source code of an existing cell. Only modifies source, not metadata/tags (use add_cell_tags/set_cell_metadata for those). Preserves cell outputs; use clear_outputs to remove them. Changes sync in real-time to JupyterLab.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index to update",
        },
        cell_id: {
          type: "string",
          description: "Cell ID to update (alternative to index). Use the ID shown in get_notebook_content output.",
        },
        source: {
          type: "string",
          description: "New source code",
        },
        force: {
          type: "boolean",
          description: "Force update even if a human is editing this cell. Default: false",
        },
        client_name: {
          type: "string",
          description: "Optional agent/client name for change attribution and lock owner matching (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "batch_update_cells",
    description:
      "Update multiple cells at once. More efficient than calling update_cell repeatedly. Each update specifies index and new source. All changes are applied atomically.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number", description: "Cell index to update" },
              source: { type: "string", description: "New source code" },
            },
            required: ["index", "source"],
          },
          description: "Array of {index, source} updates to apply",
        },
        client_name: {
          type: "string",
          description: "Optional agent/client name for change attribution (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["path", "updates"],
    },
  },
  {
    name: "batch_insert_cells",
    description:
      "Insert multiple cells at once. More efficient than calling insert_cell repeatedly. Inserts are applied in order; each subsequent insert accounts for prior insertions. Returns diffs for each inserted cell.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        inserts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string", description: "Cell source code" },
              cell_type: {
                type: "string",
                enum: ["code", "markdown"],
                description: "Cell type (default: code)",
              },
              cell_id: {
                type: "string",
                description: "Insert after the cell with this ID (alternative to index).",
              },
              index: {
                type: "number",
                description: "Position to insert (0 = beginning, -1 or omit = end)",
              },
            },
            required: ["source"],
          },
          description: "Array of cells to insert in order",
        },
        client_name: {
          type: "string",
          description: "Optional agent/client name for change attribution (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["path", "inserts"],
    },
  },
  {
    name: "delete_cell",
    description: "Delete a cell from the notebook. Changes sync in real-time to JupyterLab browser. Returns a diff showing what was deleted.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index to delete",
        },
        cell_id: {
          type: "string",
          description: "Cell ID to delete (alternative to index). Use the ID shown in get_notebook_content output.",
        },
        force: {
          type: "boolean",
          description: "Force delete even if a human is editing this cell. Default: false",
        },
        client_name: {
          type: "string",
          description: "Optional agent/client name for change attribution and lock owner matching (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_cells",
    description:
      "Delete multiple cells at once. More efficient than calling delete_cell repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        start_index: {
          type: "number",
          description: "First cell index to delete (inclusive)",
        },
        end_index: {
          type: "number",
          description: "Last cell index to delete (inclusive)",
        },
        indices: {
          type: "array",
          items: { type: "number" },
          description:
            "Specific cell indices to delete (e.g., [2,5,8]). Takes precedence over start_index/end_index.",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cell IDs to delete (alternative to indices). Use IDs shown in get_notebook_content output.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "change_cell_type",
    description:
      "Change a cell's type (code <-> markdown) in place, preserving content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index to change",
        },
        cell_id: {
          type: "string",
          description: "Cell ID to change (alternative to index). Use the ID shown in get_notebook_content output.",
        },
        new_type: {
          type: "string",
          enum: ["code", "markdown"],
          description: "New cell type",
        },
        force: {
          type: "boolean",
          description: "Force change even if a human is editing this cell. Default: false",
        },
      },
      required: ["path", "new_type"],
    },
  },
  {
    name: "copy_cells",
    description:
      "Copy one or more cells from one notebook to another (or within the same notebook). For single cell, use same value for start_index and end_index.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description: "Source notebook path",
        },
        dest_path: {
          type: "string",
          description: "Destination notebook path",
        },
        start_index: {
          type: "number",
          description: "First cell index to copy (inclusive)",
        },
        end_index: {
          type: "number",
          description: "Last cell index to copy (inclusive)",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Cell IDs to copy (alternative to start_index/end_index). More robust in concurrent editing.",
        },
        dest_index: {
          type: "number",
          description: "Position in destination to insert cells. Default: end",
        },
        dest_cell_id: {
          type: "string",
          description:
            "Insert after this cell ID in destination (alternative to dest_index).",
        },
        client_name: {
          type: "string",
          description:
            "Optional agent/client name for change attribution (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["source_path", "dest_path"],
    },
  },
  {
    name: "move_cells",
    description:
      "Move one or more cells within a notebook (reorder) or between notebooks (removes from source). For single cell, use same value for start_index and end_index.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description: "Source notebook path",
        },
        dest_path: {
          type: "string",
          description: "Destination notebook path (can be same as source for reordering)",
        },
        start_index: {
          type: "number",
          description: "First cell index to move (inclusive)",
        },
        end_index: {
          type: "number",
          description: "Last cell index to move (inclusive)",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Cell IDs to move (alternative to start_index/end_index). More robust in concurrent editing.",
        },
        dest_index: {
          type: "number",
          description: "Position in destination to insert cells",
        },
        dest_cell_id: {
          type: "string",
          description:
            "Insert after this cell ID in destination (alternative to dest_index).",
        },
        client_name: {
          type: "string",
          description:
            "Optional agent/client name for change attribution (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["source_path", "dest_path"],
    },
  },
  {
    name: "execute_cell",
    description:
      "Execute a cell in the notebook's kernel. Requires JupyterLab connection. Outputs appear in JupyterLab and are returned here. Supports text output and images.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index to execute",
        },
        cell_id: {
          type: "string",
          description: "Cell ID to execute (alternative to index). Use the ID shown in get_notebook_content output.",
        },
        timeout: {
          type: "number",
          description: "Execution timeout in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
        },
        max_images: {
          type: "number",
          description: "Maximum number of images to return. When exceeded, shows last N images. Default: all images.",
        },
        include_images: {
          type: "boolean",
          description: "Whether to include images in the response. Set to false for text-only output. Default: true",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "execute_code",
    description:
      "Execute code in the notebook's kernel without modifying the notebook. Requires JupyterLab connection. Works with any kernel (Python, R, Julia, etc.). Set insertCell=true to also add the code as a new cell with visible outputs.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path (to identify which kernel to use)",
        },
        code: {
          type: "string",
          description: "Code to execute (language depends on notebook's kernel)",
        },
        insertCell: {
          type: "boolean",
          description:
            "If true, insert code as a new cell and show outputs in JupyterLab (default: false)",
        },
        timeout: {
          type: "number",
          description: "Execution timeout in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
        },
        max_images: {
          type: "number",
          description: "Maximum number of images to return. When exceeded, shows last N images. Default: all images.",
        },
        include_images: {
          type: "boolean",
          description: "Whether to include images in the response. Set to false for text-only output. Default: true",
        },
      },
      required: ["path", "code"],
    },
  },
  {
    name: "execute_range",
    description:
      "Execute multiple cells in sequence. Requires JupyterLab connection. Continues on error (doesn't stop). Automatically skips markdown and empty cells. Returns status per cell. Useful for running a section or the entire notebook.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        start_index: {
          type: "number",
          description: "First cell index to execute. Default: 0",
        },
        end_index: {
          type: "number",
          description: "Last cell index to execute (inclusive). Default: last cell",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Cell IDs to execute in order (alternative to start_index/end_index). More robust in concurrent editing.",
        },
        timeout: {
          type: "number",
          description: "Timeout per cell in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "insert_and_execute",
    description:
      "Insert a new code cell and immediately execute it. Requires JupyterLab connection. Combines insert_cell + execute_cell in one operation. Returns the execution output.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Position to insert (0 = beginning, -1 or omit = end)",
        },
        cell_id: {
          type: "string",
          description: "Insert after the cell with this ID (alternative to index). Use the ID shown in get_notebook_content output.",
        },
        source: {
          type: "string",
          description: "Code to insert and execute",
        },
        timeout: {
          type: "number",
          description: "Execution timeout in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
        },
        max_images: {
          type: "number",
          description: "Maximum number of images to return. When exceeded, shows last N images. Default: all images.",
        },
        include_images: {
          type: "boolean",
          description: "Whether to include images in the response. Set to false for text-only output. Default: true",
        },
        client_name: {
          type: "string",
          description: "Optional agent/client name for change attribution (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "update_and_execute",
    description:
      "Update a cell's source code and immediately execute it. Requires JupyterLab connection. Combines update_cell + execute_cell in one operation. Returns the execution output.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index to update and execute",
        },
        cell_id: {
          type: "string",
          description: "Cell ID to update and execute (alternative to index). Use the ID shown in get_notebook_content output.",
        },
        source: {
          type: "string",
          description: "New source code for the cell",
        },
        force: {
          type: "boolean",
          description: "Force update even if a human is editing this cell. Default: false",
        },
        timeout: {
          type: "number",
          description: "Execution timeout in milliseconds. Default: 30000 (30s). Max: 300000 (5min).",
        },
        max_images: {
          type: "number",
          description: "Maximum number of images to return. When exceeded, shows last N images. Default: all images.",
        },
        include_images: {
          type: "boolean",
          description: "Whether to include images in the response. Set to false for text-only output. Default: true",
        },
        client_name: {
          type: "string",
          description: "Optional agent/client name for change attribution and lock owner matching (e.g., 'model-agent'). Default: 'claude-code'",
        },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "clear_outputs",
    description:
      "Clear execution outputs from cells. Useful before committing notebooks.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index to clear. If omitted, clears all cells.",
        },
        cell_id: {
          type: "string",
          description: "Cell ID to clear (alternative to index). Use the ID shown in get_notebook_content output.",
        },
        force: {
          type: "boolean",
          description: "Force clear even if a human is editing this cell. Default: false",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_cell_outputs",
    description:
      "Get execution outputs from specific cells without fetching source code. Useful for checking results without re-fetching everything. Returns text and image outputs.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
        },
        end_index: {
          type: "number",
          description: "Last cell index (inclusive). Omit for single cell.",
        },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cell IDs to get outputs for (alternative to indices). Use IDs shown in get_notebook_content output.",
        },
        max_images: {
          type: "number",
          description: "Maximum number of images to return. When exceeded, shows last N images. Default: all images.",
        },
        include_images: {
          type: "boolean",
          description: "Whether to include images in the response. Set to false for text-only output. Default: true",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_cell_metadata",
    description:
      "Get metadata from one or more cells. Returns {index, metadata, tags} - tags extracted to top level for convenience. Use indices:[2,5,8] for non-contiguous cells.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
        },
        end_index: {
          type: "number",
          description: "Last cell index (inclusive). Omit for single cell.",
        },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cell IDs to get metadata for (alternative to indices). Use IDs shown in get_notebook_content output.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "set_cell_metadata",
    description:
      "Set metadata on one or more cells. Merges with existing metadata (use null values to delete keys). Supports ranges or specific non-contiguous indices.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
        },
        end_index: {
          type: "number",
          description: "Last cell index (inclusive). Omit for single cell.",
        },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cell IDs to set metadata on (alternative to indices). Use IDs shown in get_notebook_content output.",
        },
        metadata: {
          type: "object",
          description: "Metadata to set/merge. Use null values to delete keys.",
        },
      },
      required: ["path", "metadata"],
    },
  },
  {
    name: "add_cell_tags",
    description:
      "Add tags to one or more cells. Common tags: 'hide-input', 'hide-output', 'remove-input', 'remove-output', 'remove-cell', 'skip-execution', 'parameters' (papermill). Use indices:[2,5,8] for non-contiguous cells.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
        },
        end_index: {
          type: "number",
          description: "Last cell index (inclusive). Omit for single cell.",
        },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cell IDs to add tags to (alternative to indices). Use IDs shown in get_notebook_content output.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to add",
        },
      },
      required: ["path", "tags"],
    },
  },
  {
    name: "remove_cell_tags",
    description:
      "Remove tags from one or more cells. Supports ranges or specific non-contiguous indices.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        index: {
          type: "number",
          description: "Cell index. If end_index provided, start of range. Ignored if indices is set.",
        },
        end_index: {
          type: "number",
          description: "Last cell index (inclusive). Omit for single cell.",
        },
        indices: {
          type: "array",
          items: { type: "number" },
          description: "Specific cell indices (e.g., [2,4,6,8]). Takes precedence over index/end_index.",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cell IDs to remove tags from (alternative to indices). Use IDs shown in get_notebook_content output.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to remove",
        },
      },
      required: ["path", "tags"],
    },
  },
  {
    name: "find_cells_by_tag",
    description:
      "Find cells that have specific tag(s). Returns cell indices, tags, and optionally source preview. Useful for locating cells marked with 'hide-input', 'parameters', etc.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to search for (cells matching ANY of these tags are returned)",
        },
        match_all: {
          type: "boolean",
          description: "If true, only return cells that have ALL specified tags. Default: false (match any)",
        },
        include_preview: {
          type: "boolean",
          description: "Include first line of source for context. Default: false",
        },
      },
      required: ["path", "tags"],
    },
  },
  {
    name: "get_notebook_metadata",
    description:
      "Get notebook-level metadata (kernelspec, language_info, custom fields).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "set_notebook_metadata",
    description:
      "Set notebook-level metadata. Merges with existing metadata.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        metadata: {
          type: "object",
          description: "Metadata to set/merge",
        },
      },
      required: ["path", "metadata"],
    },
  },
  {
    name: "get_kernel_status",
    description:
      "Get the status of a notebook's kernel (idle, busy, starting, dead). Requires JupyterLab connection. Use to check if execution is complete or if kernel needs restart.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_kernel_variables",
    description:
      "List variables defined in the notebook's kernel. Requires JupyterLab connection. Returns variable names, types, and short representations. Useful for inspecting kernel state without writing code.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        detail: {
          type: "string",
          enum: ["basic", "schema", "full"],
          description:
            "Detail level. 'basic' (default): name, type, repr. 'schema': one-line summaries with column/dtype info. 'full': structured inspection dicts.",
        },
        filter: {
          type: "string",
          description: "Filter variables by name pattern (case-insensitive substring match). Default: show all",
        },
        include_private: {
          type: "boolean",
          description: "Include variables starting with underscore. Default: false",
        },
        max_variables: {
          type: "number",
          description:
            "Maximum number of variables to return. Default: 50",
        },
        max_items: {
          type: "number",
          description:
            "Maximum number of columns/keys/elements to enumerate per variable. Default: 20",
        },
        max_name_length: {
          type: ["number", "null"],
          description:
            "Maximum characters for column/key/variable names. Default: 60. Use null for unlimited (may use more context).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "inspect_variable",
    description:
      "Inspect specific variables in the notebook's kernel with full structural metadata. Returns columns, dtypes, shapes, keys, and nested structure for DataFrames, arrays, dicts, and other types. Use get_kernel_variables first to discover variable names, then inspect_variable for details.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description:
            "Variable names to inspect (max 20). Must be valid Python identifiers.",
        },
        max_items: {
          type: "number",
          description:
            "Maximum number of columns/keys/elements to enumerate per variable. Default: 20",
        },
        max_name_length: {
          type: ["number", "null"],
          description:
            "Maximum characters for column/key/variable names. Default: 60. Use null for unlimited (may use more context).",
        },
      },
      required: ["path", "names"],
    },
  },
  {
    name: "interrupt_kernel",
    description:
      "Interrupt (stop) a running execution. Requires JupyterLab connection. Use when code is taking too long or stuck in an infinite loop. Does not restart the kernel or clear state.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "restart_kernel",
    description:
      "Restart the kernel, clearing all variables and state. Requires JupyterLab connection. Use when kernel is unresponsive, memory is full, or you need a clean slate. All variables will be lost.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "rename_notebook",
    description:
      "Rename a notebook file. Disconnects any active collaboration session first.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Current notebook path",
        },
        new_path: {
          type: "string",
          description: "New notebook path (must end in .ipynb)",
        },
      },
      required: ["path", "new_path"],
    },
  },
  {
    name: "diff_notebooks",
    description:
      "Compare two .ipynb notebooks cell by cell. Returns unified diff showing additions (+), deletions (-), and modifications per cell. Use summary_only=true for counts only.",
    inputSchema: {
      type: "object",
      properties: {
        path1: {
          type: "string",
          description: "First notebook path",
        },
        path2: {
          type: "string",
          description: "Second notebook path",
        },
        include_outputs: {
          type: "boolean",
          description: "Include output differences (default: false)",
        },
        summary_only: {
          type: "boolean",
          description: "Only show counts, not full diffs (default: false)",
        },
        max_diffs: {
          type: "number",
          description: "Max number of cell diffs to show (default: all)",
        },
      },
      required: ["path1", "path2"],
    },
  },
  // ========================================================================
  // Change tracking tools
  // ========================================================================
  {
    name: "get_cell_history",
    description:
      "Get the change history for a specific cell. Shows who changed it, when, what the old/new content was, and allows recovery of deleted cells. Requires that changes were tracked during this session.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        cell_id: {
          type: "string",
          description: "Cell ID to get history for (prefix match)",
        },
        limit: {
          type: "number",
          description: "Maximum number of history entries to return. Default: 20",
        },
      },
      required: ["path", "cell_id"],
    },
  },
  {
    name: "get_notebook_changes",
    description:
      "Get all changes to a notebook since a given version number. Use version 0 to get all tracked changes. Returns the current version number for use in subsequent calls (polling pattern: call with last known version to get only new changes).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        since_version: {
          type: "number",
          description: "Return changes after this version number. Use 0 for all changes.",
        },
        limit: {
          type: "number",
          description: "Maximum number of changes to return. Default: 50",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "recover_cell",
    description:
      "Recover a deleted cell by finding its last known content in the change history and re-inserting it. Only works for cells deleted during this session.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        cell_id: {
          type: "string",
          description: "Cell ID of the deleted cell to recover (prefix match)",
        },
        index: {
          type: "number",
          description: "Position to re-insert the cell. Default: end of notebook",
        },
        client_name: {
          type: "string",
          description: "Optional agent/client name for change attribution and lock owner matching (e.g., 'etl-agent'). Default: 'claude-code'",
        },
      },
      required: ["path", "cell_id"],
    },
  },
  // ========================================================================
  // Snapshot tools
  // ========================================================================
  {
    name: "snapshot_notebook",
    description:
      "Save a named snapshot of the notebook's current state. Captures all cell content, types, and metadata. Use before risky operations or to create a known-good checkpoint for recovery.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        name: {
          type: "string",
          description: "Name for this snapshot (e.g., 'before-refactor', 'v1-working')",
        },
        description: {
          type: "string",
          description: "Optional description of what state this captures",
        },
      },
      required: ["path", "name"],
    },
  },
  {
    name: "restore_snapshot",
    description:
      "Restore a notebook to a previously saved snapshot. WARNING: This replaces ALL cells in the notebook with the snapshot's cells. Outputs are cleared. Creates an automatic 'pre-restore' snapshot first for safety.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        name: {
          type: "string",
          description: "Name of the snapshot to restore",
        },
      },
      required: ["path", "name"],
    },
  },
  {
    name: "list_snapshots",
    description:
      "List all saved snapshots for a notebook. Shows name, creation time, cell count, and description.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "diff_snapshot",
    description:
      "Compare a saved snapshot against the notebook's current state. Shows which cells were added, deleted, modified, or unchanged since the snapshot was taken.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        name: {
          type: "string",
          description: "Name of the snapshot to compare against",
        },
      },
      required: ["path", "name"],
    },
  },
  // ================================================================
  // Cell locking tools
  // ================================================================
  {
    name: "lock_cells",
    description:
      "Acquire advisory locks on cells to prevent accidental overwrites by other agents. Locks auto-expire after 10 minutes (configurable). Calling again with the same owner renews the lock TTL. Other agents see a warning when trying to modify locked cells.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cell IDs to lock (prefix match supported)",
        },
        owner: {
          type: "string",
          description: "Who is claiming these cells (e.g. agent name). Default: 'claude-code'",
        },
        ttl_minutes: {
          type: "number",
          description: "Lock duration in minutes. Default: 10",
        },
      },
      required: ["path", "cell_ids"],
    },
  },
  {
    name: "unlock_cells",
    description:
      "Release advisory locks on cells. Only the lock owner can release (use force=true to override).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
        cell_ids: {
          type: "array",
          items: { type: "string" },
          description: "Cell IDs to unlock",
        },
        owner: {
          type: "string",
          description: "Who is releasing (must match lock owner). Default: 'claude-code'",
        },
        force: {
          type: "boolean",
          description: "Force unlock regardless of owner. Default: false",
        },
      },
      required: ["path", "cell_ids"],
    },
  },
  {
    name: "list_locks",
    description: "List all active cell locks for a notebook. Shows who holds each lock and when it expires.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Notebook path",
        },
      },
      required: ["path"],
    },
  },
];
