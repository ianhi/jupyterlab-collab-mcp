# JupyterLab Collab MCP

## Project Overview

A TypeScript MCP server that connects to JupyterLab's real-time collaboration system, allowing Claude Code to read, edit, and execute notebooks in real-time. Changes sync bidirectionally with the JupyterLab browser interface.

**Dual mode**: Most tools work in two modes automatically:
- **Jupyter mode**: Connect via `connect_jupyter` for real-time sync and kernel operations
- **Filesystem mode**: Read/write `.ipynb` files directly without JupyterLab (no kernel needed)

## Architecture

**Key insight**: No custom JupyterLab extension is needed. We use `y-websocket` to connect directly to the existing `jupyter-collaboration` endpoints.

```
src/
├── index.ts        # MCP server entry point
├── handlers/       # 39 tool handlers by category
│   ├── connection.ts   # connect, list_files/notebooks/kernels, open/create/rename
│   ├── cell-read.ts    # get_content/outline, search, replace, diff
│   ├── cell-write.ts   # insert/update/delete/copy cells, batch ops
│   ├── execute.ts      # execute_cell/code, filter_output, outputs
│   ├── metadata.ts     # cell_metadata, notebook_metadata, cell_tags (incl. find)
│   ├── kernel-lsp.ts   # kernel (status/interrupt/restart), kernel_variables, diagnostics, hover, rename
│   └── collab.ts       # focus, history, changes, recover, snapshot, cell_locks
├── connection.ts   # Jupyter connection state, session management, kernel execution
├── schemas.ts      # All 39 tool schema definitions
├── helpers.ts      # Utilities (cell extraction, diffing, output formatting, ANSI stripping)
├── notebook-fs.ts  # Filesystem backend (read/write .ipynb)
├── rename.ts       # Scope-aware Python rename via jedi
├── cell-tracker.ts # Per-notebook change tracking
├── snapshots.ts    # Named notebook checkpoints
└── cell-locks.ts   # Advisory cell locking
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Build MCP server
npm run watch        # Watch mode
npx vitest run       # Run tests
JUPYTER_TOKEN=xxx npx tsx src/test.ts  # Test RTC connection
```

**Python**: Always use `uv` for Python operations. Example: `cd python && uv run pytest tests/ -v`

**IMPORTANT: After `npm run build`, you must restart Claude Code** for tool schema changes to take effect. The MCP server process caches tool definitions at startup.

**Backwards compatibility**: This is a tool, not a library. Breaking changes to tool schemas are acceptable. Do not maintain backwards compatibility for deprecated parameters.
