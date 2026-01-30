# JupyterLab + Claude Code Integration

## Project Overview

A TypeScript MCP server that connects to JupyterLab's real-time collaboration system, allowing Claude Code to read, edit, and execute notebooks in real-time. Changes sync bidirectionally with the JupyterLab browser interface.

## Architecture

**Key insight**: No custom JupyterLab extension is needed. We use `y-websocket` to connect directly to the existing `jupyter-collaboration` endpoints.

```
src/
├── index.ts    # MCP server (stdio transport)
└── test.ts     # Standalone test script
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `connect_jupyter` | Connect to JupyterLab with URL (call first!) |
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

### Context-Efficient Reading

`get_notebook_content` has options to reduce context usage:

```
cell_type: "code" (default), "markdown", or "all"
include_outputs: false (default) - set true only when needed
output_format: "text" (default) or "structured"
start_index / end_index: read specific cell ranges
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

## Installation

```bash
git clone https://github.com/ianhi/jupyterlab-claude-code.git
cd jupyterlab-claude-code
npm install && npm run build
claude mcp add jupyter -- node $PWD/dist/index.js
```

No token in config - just paste your JupyterLab URL when connecting:
> "Connect to http://localhost:8888/lab?token=abc123"

## Key Technologies

- **TypeScript** with `tsx` for development
- **@modelcontextprotocol/sdk** for MCP server
- **y-websocket** for Yjs sync (same protocol as JupyterLab frontend)
- **yjs** for CRDT data structures

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

## Important Notes

- Always request a session before connecting to the room
- The `sessionId` must be passed as a query parameter
- Room ID format: `{format}:{type}:{fileId}` (e.g., `json:notebook:abc-123`)
- Don't URL-encode the room ID (colons must remain as-is)
- Cells are in `doc.getArray("cells")` as Y.Map objects with Y.Text for source
- Outputs from execution appear immediately in the browser
