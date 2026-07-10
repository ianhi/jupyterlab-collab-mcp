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
├── handlers/       # 44 tool handlers by category
│   ├── connection.ts   # connect, list_files/notebooks/kernels, open/create/rename, save_notebook
│   ├── cell-read.ts    # get_content/outline, search, replace, diff
│   ├── cell-write.ts   # insert/update/delete/copy cells, batch ops
│   ├── execute.ts      # execute_cell/code, filter_output, outputs, list_runs, get_cell_run_output
│   ├── metadata.ts     # cell_metadata, notebook_metadata, cell_tags (incl. find)
│   ├── kernel-lsp.ts   # kernel (status/interrupt/restart), kernel_variables, diagnostics, hover, rename
│   ├── collab.ts       # focus, history, changes, recover, snapshot, cell_locks, report_issue, troubleshoot
│   └── guide.ts        # notebook_guide (on-demand best-practices doc)
├── connection.ts   # Jupyter connection state, session management, kernel execution, forced save
├── schemas.ts      # All 44 tool schema definitions
├── helpers.ts      # Utilities (cell extraction, diffing, output formatting, ANSI stripping)
├── notebook-fs.ts  # Filesystem backend (read/write .ipynb)
├── kernel-client.ts # Long-lived per-kernel WS; run state machine + retention
├── run-store.ts    # Bounded disk cache of handed-off run outputs (host-side)
├── kernel-capture.ts # In-kernel-memory output capture (sleep-proof recovery)
├── rename.ts       # Scope-aware Python rename via jedi
├── cell-tracker.ts # Per-notebook change tracking
├── snapshots.ts    # Named notebook checkpoints
└── cell-locks.ts   # Advisory cell locking
```

## Handed-off run durability (execute_code / *_cell with handoff_after_ms)

Slow runs hand back a `run_id`; the output must survive until fetched. Three layers:
1. **In-memory** run buffer per kernel (`kernel-client.ts`) — retained
   ~500 runs / ~120 min; in-flight runs are never idle-evicted.
2. **Disk cache** (`run-store.ts`) — host-side, bounded (count/bytes/TTL); survives
   MCP restart, eviction, dropped sockets. `get_cell_run_output` falls back to it.
3. **Kernel-side capture** (`kernel-capture.ts`) — IPython harness keeps slow-run
   output in the *kernel's* RAM (no FS writes); recovered via a fresh execute after
   a disconnect (the only layer surviving host sleep). `state==="failed"` on a run
   means a socket loss (not a Python error) and triggers this recovery.

Tunable via env (all optional): `JUPYTER_MCP_IDLE_EVICTION_MS`,
`JUPYTER_MCP_MAX_RETAINED_RUNS`, `JUPYTER_MCP_RUN_TTL_MS`,
`JUPYTER_MCP_RUN_STORE_{DIR,MAX_FILES,MAX_BYTES,TTL_MS,MAX_TEXT,MAX_IMAGES}`,
`JUPYTER_MCP_KERNEL_CAPTURE_{MIN_MS,MAX_RUNS,MAX_CHARS}`,
`JUPYTER_MCP_DISABLE_KERNEL_CAPTURE`.

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
