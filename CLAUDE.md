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
├── index.ts        # Thin MCP server entry point (dispatches to handlers)
├── handlers/       # All 54 tool handlers, organized by category
│   ├── connection.ts   # connect_jupyter, list_files, list_notebooks, list_kernels, open/create/rename_notebook
│   ├── cell-read.ts    # get_notebook_content, get_notebook_outline, search_notebook, replace_in_notebook
│   ├── cell-write.ts   # insert_cell, update_cell, delete_cell(s), change_cell_type, copy/move_cells, batch ops
│   ├── execute.ts      # execute_cell, execute_code, execute_range, insert/update_and_execute, clear_outputs, get_cell_outputs
│   ├── metadata.ts     # get/set_cell_metadata, add/remove_cell_tags, find_cells_by_tag, notebook metadata
│   ├── kernel-lsp.ts   # kernel status/variables/interrupt/restart, diagnostics, hover_info, rename_symbol, diff/rename_notebook
│   └── collab.ts       # get_user_focus, cell history, notebook changes, recover_cell, snapshots, locks
├── connection.ts   # JupyterLab connection state, config, session management, kernel execution
├── schemas.ts      # Tool schema definitions (all 53 tools)
├── tool-helpers.ts # Shared handler patterns (getNotebookCells, resolveIndexParam, etc.)
├── helpers.ts      # Shared utilities (cell extraction, diffing, output formatting)
├── notebook-fs.ts  # Filesystem backend (read/write .ipynb without JupyterLab)
├── rename.ts       # Scope-aware Python rename via jedi
├── cell-tracker.ts # In-memory per-notebook change tracking with version numbers
├── snapshots.ts    # Named notebook checkpoints (save/restore/diff)
├── cell-locks.ts   # Advisory cell locking with auto-expiry
└── test.ts         # Standalone test script
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `connect_jupyter` | Connect to JupyterLab with URL (needed for kernel ops) |
| `list_files` | List files/notebooks in a directory |
| `list_notebooks` | List open notebooks with active kernels |
| `open_notebook` | Open a notebook and start its kernel |
| `create_notebook` | Create a new notebook file (optionally with initial cells) |
| `list_kernels` | List available kernel types and running instances |
| `get_notebook_content` | Get cells with filtering (code only by default) |
| `get_notebook_outline` | Get condensed structure (headers + first lines) |
| `search_notebook` | Grep through source code and outputs |
| `replace_in_notebook` | Search and replace across cells |
| `insert_cell` | Insert a new cell at position |
| `insert_and_execute` | Insert a cell and run it in one operation |
| `update_cell` | Update cell source code |
| `batch_update_cells` | Update multiple cells atomically |
| `batch_insert_cells` | Insert multiple cells at once |
| `update_and_execute` | Update a cell and run it in one operation |
| `change_cell_type` | Change cell type (code ↔ markdown) |
| `delete_cell` | Delete a cell |
| `delete_cells` | Delete multiple cells at once |
| `copy_cells` | Copy cells within/between notebooks |
| `move_cells` | Move/reorder cells within/between notebooks |
| `clear_outputs` | Clear execution outputs |
| `get_cell_outputs` | Get outputs without re-fetching source |
| `get_user_focus` | See user's current cell via awareness |
| `execute_cell` | Execute a cell, show outputs in JupyterLab |
| `execute_range` | Execute multiple cells in sequence |
| `execute_code` | Execute code (optionally as new cell with outputs) |
| `get_cell_metadata` | Get metadata/tags for cell(s) |
| `set_cell_metadata` | Set metadata for cell(s) |
| `add_cell_tags` | Add tags to cell(s) |
| `remove_cell_tags` | Remove tags from cell(s) |
| `get_notebook_metadata` | Get notebook-level metadata |
| `find_cells_by_tag` | Find cells with specific tags |
| `set_notebook_metadata` | Set notebook-level metadata |
| `get_diagnostics` | Get code errors/warnings without executing |
| `get_hover_info` | Get docs/type info at a position |
| `rename_notebook` | Rename a notebook file |
| `diff_notebooks` | Compare two notebooks cell by cell |
| `rename_symbol` | Scope-aware Python rename across cells (via jedi) |
| `get_kernel_status` | Check if kernel is idle/busy/dead |
| `get_kernel_variables` | List variables in kernel with basic/schema/full detail levels |
| `inspect_variable` | Deep-inspect specific variables (columns, dtypes, keys, shapes) |
| `interrupt_kernel` | Stop running execution |
| `restart_kernel` | Restart kernel (clears all state) |
| `get_cell_history` | View change log for a specific cell |
| `get_notebook_changes` | Poll for changes since a version number |
| `recover_cell` | Re-insert a deleted cell from change history |
| `snapshot_notebook` | Save a named checkpoint |
| `restore_snapshot` | Restore notebook to a checkpoint |
| `list_snapshots` | List all checkpoints for a notebook |
| `diff_snapshot` | Compare checkpoint vs current state |
| `lock_cells` | Acquire advisory locks on cells |
| `unlock_cells` | Release advisory locks |
| `list_locks` | List active cell locks |

### Cell IDs (Stable Addressing)

Every cell has a UUID `id` field. Tools show truncated IDs (8 chars) alongside indices and accept `cell_id` as an alternative to `index`:

```
update_cell(path, cell_id="a3f8c2d1", source="new code")  # instead of index
get_notebook_content(path, cell_ids=["a3f8c2d1", "b7e4f9a2"])  # non-contiguous by ID
insert_cell(path, cell_id="a3f8c2d1", source="code")  # insert AFTER that cell
```

Cell IDs are prefix-matched — use enough characters to be unambiguous. IDs stay stable across insertions/deletions, unlike positional indices.

Tools with `cell_id`: `update_cell`, `delete_cell`, `execute_cell`, `change_cell_type`, `insert_cell` (after), `insert_and_execute` (after), `update_and_execute`, `clear_outputs`, `get_diagnostics`.

Tools with `cell_ids` array: `get_notebook_content`, `get_cell_outputs`, `get_cell_metadata`, `set_cell_metadata`, `add_cell_tags`, `remove_cell_tags`, `delete_cells`, `copy_cells`, `move_cells`, `execute_range`, `lock_cells`, `unlock_cells`.

### Human-Focus Protection

Write tools in Jupyter mode check the awareness protocol before modifying cells. If a human collaborator is editing the target cell, the operation is blocked:

```
Cannot modify cell 5 (a3f8c2d1) — user "Ian" is currently editing it. Use force=true to override.
```

Applied to: `update_cell`, `update_and_execute`, `delete_cell`, `change_cell_type`, `clear_outputs`. Use `force=true` to bypass.

### Cell Locking (Advisory)

Agents can claim cells to prevent accidental overwrites. Locks are advisory and auto-expire (default 10 minutes):

```
lock_cells(path, cell_ids=["a3f8c2d1", "b7e4f9a2"], owner="data-agent", ttl_minutes=10)
unlock_cells(path, cell_ids=["a3f8c2d1"], owner="data-agent")
list_locks(path)  # see all active locks
```

Write tools (`update_cell`, `delete_cell`) check locks and warn if another owner holds the lock. Use `force=true` to override. Locks are session-scoped (cleared on server restart).

### Change Tracking

All cell modifications are tracked in-memory with version numbers, timestamps, and client attribution:

```
get_cell_history(path, cell_id="a3f8c2d1", limit=10)  # changes to one cell
get_notebook_changes(path, since_version=5)             # poll for all changes since version 5
recover_cell(path, cell_id="a3f8c2d1")                  # re-insert a deleted cell from history
```

Agents can use `get_notebook_changes` for polling-based change detection: call once with `since_version=0` to get the current version, then poll with the last known version to get incremental updates.

### Snapshots (Checkpoints)

Save and restore named checkpoints:

```
snapshot_notebook(path, name="before-refactor", description="optional note")
list_snapshots(path)
diff_snapshot(path, name="before-refactor")   # see what changed since checkpoint
restore_snapshot(path, name="before-refactor") # auto-saves pre-restore backup
```

Works in both Jupyter and filesystem modes. Snapshots are in-memory (session-scoped).

### Image Output Control

Execute tools support `max_images` and `include_images` to prevent context blowout from plot-heavy cells:

```
execute_cell(path, index=5, max_images=2)       # show last 2 of N images
execute_cell(path, index=5, include_images=false) # text-only output
```

When images are limited, the response notes how many were omitted. Available on: `execute_cell`, `execute_code`, `insert_and_execute`, `update_and_execute`, `get_cell_outputs`.

### Non-Contiguous Cell Operations

Metadata/tag tools support `indices` array or `cell_ids` for non-contiguous cells:
```
add_cell_tags(path, indices=[2,4,6,8], tags=["hide-input"])
add_cell_tags(path, cell_ids=["a3f8c2d1", "b7e4f9a2"], tags=["hide-input"])
```

### Context-Efficient Reading

`get_notebook_content` has options to reduce context usage:

```
cell_type: "code" (default), "markdown", or "all"
include_outputs: false (default) - set true only when needed
output_format: "text" (default) or "structured"
start_index / end_index: read specific cell ranges
indices: [2, 5, 8] - non-contiguous cell selection
cell_ids: ["a3f8c2d1"] - select by cell ID
```

**Output formats**:
- `text` (default): Returns outputs as a single `output` string (just text/plain content)
- `structured`: Returns `outputs` array with metadata (output_type, has_image, has_html)

**Best practice**: The default `cell_type="code"` skips markdown cells, keeping context focused on executable code.

### Searching

`search_notebook` greps through notebook content:

```
pattern: regex or string to search for
search_in: "source", "outputs", or "all" (default)
case_sensitive: false (default)
```

Returns matching cells with their source and/or output text. Useful for finding errors, tracebacks, or specific values.

### Scope-Aware Rename

`rename_symbol` renames Python symbols across all cells using jedi for scope analysis:

```
path: notebook path
cell_index: which cell contains the symbol (0-indexed)
line: line within the cell (0-indexed)
character: column within the line (0-indexed)
new_name: the new name for the symbol
```

Unlike `replace_in_notebook`, this understands Python semantics — it won't rename occurrences in strings, comments, or unrelated scopes. Requires jedi (auto-installed via `uvx`, or install with `pip install jedi`).

### Variable Inspector

`get_kernel_variables` and `inspect_variable` provide fast, safe introspection of kernel state without writing code:

```
# Quick scan (basic mode)
get_kernel_variables(path, detail="basic")  # name, type, repr

# Agent-friendly summaries (schema mode - recommended)
get_kernel_variables(path, detail="schema")  # one-line summaries with metadata
# → "df: DataFrame (100×5) [date:datetime64[ns], price:float64, ...]"

# Full structured metadata (full mode)
get_kernel_variables(path, detail="full")  # complete dicts with all fields

# Deep inspection of specific variables
inspect_variable(path, names=["df", "results"])  # structured metadata
```

**Detail levels:**
- **basic**: Fast, compact — name, type, short repr
- **schema** (recommended for agents): One-line summaries with column/dtype info for DataFrames, shape for arrays, keys for dicts
- **full**: Complete structured metadata for programmatic use

**Supported libraries with specialized handlers:**
- pandas: DataFrame/Series with columns, dtypes, shape, memory, MultiIndex support
- polars: DataFrame/Series/LazyFrame (never triggers `.collect()`)
- numpy: ndarray with shape, dtype, ndim, nbytes
- xarray: Dataset/DataArray/DataTree with dims, data_vars (with dtypes), coords

**Generic fallback:** For unknown types, returns type + repr + shape/dtype/len if available.

**Safety guarantees:**
- Never triggers lazy computation (polars `.collect()`, dask `.compute()`)
- Never crashes on broken objects (all operations wrapped in try/except)
- Performance: all inspections complete in <5ms per variable
- Dict value previews show shapes for DataFrames/arrays instead of verbose repr

## Installation

```bash
# With npx (recommended)
claude mcp add -s user jupyter -- npx jupyterlab-collab-mcp

# With uvx (no Node.js required)
claude mcp add -s user jupyter -- uvx deno -A npm:jupyterlab-collab-mcp

# From source (development)
git clone https://github.com/ianhi/jupyterlab-collab-mcp.git
cd jupyterlab-collab-mcp
npm install && npm run build
claude mcp add -s user jupyter -- node $PWD/dist/index.js
```

No token in config — just paste your JupyterLab URL when connecting:
> "Connect to http://localhost:8888/lab?token=abc123"

To launch JupyterLab with the right extensions: `uv tool install jlabx && jlabx` (separate project: https://github.com/ianhi/jlabx)

## Key Technologies

- **TypeScript** with `tsx` for development
- **@modelcontextprotocol/sdk** for MCP server
- **y-websocket** for Yjs sync (same protocol as JupyterLab frontend)
- **yjs** for CRDT data structures
- **jedi** (Python, via subprocess) for scope-aware rename

## Development

```bash
# Install dependencies
npm install

# Test RTC connection (rapid iteration, no Claude Code restart needed)
JUPYTER_TOKEN=xxx npx tsx src/test.ts

# Build MCP server
npm run build

# Watch mode
npm run watch
```

**Python**: Always use `uv` for Python operations (running tests, installing packages, managing environments). Example: `cd python && uv run pytest tests/ -v`

**IMPORTANT: After `npm run build`, you must restart Claude Code** (or remove and re-add the MCP server) for tool schema changes to take effect. The MCP server process caches tool definitions at startup — rebuilding `dist/index.js` alone does NOT update the running server. If new tool parameters (e.g., `max_images`) aren't showing up, this is why.

## JupyterLab API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sessions` | GET | List open notebooks |
| `/api/collaboration/session/{path}` | PUT | Request document session |
| `/api/collaboration/room/{room_id}` | WS | Yjs sync WebSocket |
| `/api/kernels/{id}/channels` | WS | Kernel execution |

## Connection Flow

1. `GET /api/sessions` → Find notebook path
2. `PUT /api/collaboration/session/{path}` → Get `fileId` and `sessionId`
3. Connect WebSocket to `/api/collaboration/room/json:notebook:{fileId}?sessionId=...`
4. Wait for y-websocket `sync` event
5. Access `doc.getArray("cells")` for notebook content

## Awareness / Collaboration

Claude appears as "Claude Code" in JupyterLab's collaborators panel with:
- Username: `claude-code`
- Display name: `Claude Code`
- Initials: `CC`
- Color: `#ff6b6b` (coral red)

The `get_user_focus` tool uses JupyterLab's awareness protocol to see which cell the user is currently editing.

## Agent Team Testing Strategy

When testing multi-agent collaboration on notebooks, use a team of 4+ agents working simultaneously. The test should exercise:

1. **Cell ID stability**: Agents use `cell_id` (not indices) for all operations. One agent inserting cells mid-notebook must not break another agent's references.
2. **Cross-notebook operations**: Agents work across multiple notebooks using `copy_cells` and `move_cells`. E.g., one agent builds a data pipeline notebook while another builds a visualization notebook, and they share cells between them.
3. **Execute range**: Agents use `execute_range` to run multi-cell sections, not just single cells.
4. **Multi-plot cells**: Include cells that produce multiple matplotlib figures (subplots, figure galleries) to stress-test `max_images`/`include_images` context management. Agents should use `max_images=2` or `include_images=false` for plot-heavy cells to conserve context.
5. **Concurrent inserts**: Multiple agents inserting cells in the same notebook simultaneously — cell IDs prevent index collisions.
6. **Human-in-the-loop**: Human edits cells while agents work — agents should see focus-blocked errors and retry on different cells.

### Team Lead Role

The team lead acts as a **scientist/observer**, not a manager:
- **Setup**: Design the task, scaffold the notebook, create the team and tasks, launch all agents simultaneously
- **Observe**: Monitor the change log and notebook state for high-level issues
- **Don't micromanage**: Let agents coordinate organically through messaging and kernel variable polling. Don't direct traffic, assign work to idle agents, or prevent conflicts — conflicts are valuable for stress testing
- **Intervene only for systemic issues**: e.g., a shared kernel crash, a tool bug blocking all agents, or a fundamental misunderstanding of the task
- **Avoid rigid dependency graphs**: Use `blockedBy` sparingly or not at all. Let agents discover data availability themselves via `get_kernel_variables` and communicate through messages. Organic coordination surfaces real collaboration pain points that artificial sequencing hides.

Test phases:
- Phase 1: Build & smoke test (`npm run build`, basic cell_id round-trip)
- Phase 2: Multi-agent collaboration (4+ agents, cell_id-based, parallel work)
- Phase 3: Collect agent feedback on the experience and suggestions for harder tasks

## Important Notes

- Always request a session before connecting to the room
- The `sessionId` must be passed as a query parameter
- Room ID format: `{format}:{type}:{fileId}` (e.g., `json:notebook:abc-123`)
- Don't URL-encode the room ID (colons must remain as-is)
- Cells are in `doc.getArray("cells")` as Y.Map objects with Y.Text for source
- Outputs from execution appear immediately in the browser
