# JupyterLab + Claude Code Integration

## Project Overview

A TypeScript MCP server that connects to JupyterLab's real-time collaboration system, allowing Claude Code to read, edit, and execute notebooks in real-time. Changes sync bidirectionally with the JupyterLab browser interface.

**Dual mode**: Most tools work in two modes automatically:
- **Jupyter mode**: Connect via `connect_jupyter` for real-time sync and kernel operations
- **Filesystem mode**: Read/write `.ipynb` files directly without JupyterLab (no kernel needed)

## Architecture

**Key insight**: No custom JupyterLab extension is needed. We use `y-websocket` to connect directly to the existing `jupyter-collaboration` endpoints.

```
src/
├── index.ts        # MCP server entry point + tool handlers
├── connection.ts   # JupyterLab connection state, config, session management, kernel execution
├── schemas.ts      # Tool schema definitions (all 44+ tools)
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
| `create_notebook` | Create a new notebook file |
| `get_notebook_content` | Get cells with filtering (code only by default) |
| `get_notebook_outline` | Get condensed structure (headers + first lines) |
| `search_notebook` | Grep through source code and outputs |
| `insert_cell` | Insert a new cell at position |
| `insert_and_execute` | Insert a cell and run it in one operation |
| `update_cell` | Update cell source code |
| `update_and_execute` | Update a cell and run it in one operation |
| `change_cell_type` | Change cell type (code ↔ markdown) |
| `delete_cell` | Delete a cell |
| `delete_cells` | Delete multiple cells at once |
| `copy_cells` | Copy cells within/between notebooks |
| `move_cells` | Move/reorder cells within/between notebooks |
| `clear_outputs` | Clear execution outputs |
| `get_user_focus` | See user's current cell via awareness |
| `execute_cell` | Execute a cell, show outputs in JupyterLab |
| `execute_range` | Execute multiple cells in sequence |
| `execute_code` | Execute code (optionally as new cell with outputs) |
| `get_cell_metadata` | Get metadata/tags for cell(s) |
| `set_cell_metadata` | Set metadata for cell(s) |
| `add_cell_tags` | Add tags to cell(s) |
| `remove_cell_tags` | Remove tags from cell(s) |
| `get_notebook_metadata` | Get notebook-level metadata |
| `set_notebook_metadata` | Set notebook-level metadata |
| `rename_notebook` | Rename a notebook file |
| `diff_notebooks` | Compare two notebooks cell by cell |
| `rename_symbol` | Scope-aware Python rename across cells (via jedi) |
| `get_kernel_status` | Check if kernel is idle/busy/dead |
| `get_kernel_variables` | List variables in kernel (names, types, values) |
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

Agents can claim cells to prevent accidental overwrites. Locks are advisory and auto-expire (default 5 minutes):

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

## Installation

```bash
git clone https://github.com/ianhi/jupyterlab-claude-code.git
cd jupyterlab-claude-code
npm install && npm run build
claude mcp add -s user jupyter -- node $PWD/dist/index.js
```

No token in config - just paste your JupyterLab URL when connecting:
> "Connect to http://localhost:8888/lab?token=abc123"

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

Test phases:
- Phase 1: Build & smoke test (`npm run build`, basic cell_id round-trip)
- Phase 2: Multi-agent collaboration (4 agents, cell_id-based, parallel work)
- Phase 3: Collect agent feedback on the experience and suggestions for harder tasks

## Important Notes

- Always request a session before connecting to the room
- The `sessionId` must be passed as a query parameter
- Room ID format: `{format}:{type}:{fileId}` (e.g., `json:notebook:abc-123`)
- Don't URL-encode the room ID (colons must remain as-is)
- Cells are in `doc.getArray("cells")` as Y.Map objects with Y.Text for source
- Outputs from execution appear immediately in the browser
