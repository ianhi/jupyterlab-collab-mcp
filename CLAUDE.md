# JupyterLab + Claude Code Integration

## Project Overview

A TypeScript MCP server that connects to JupyterLab's real-time collaboration system, allowing Claude Code to read and edit notebooks in real-time.

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
| `list_notebooks` | List open notebooks with active kernels |
| `get_notebook_content` | Get all cells (index, type, source) |
| `insert_cell` | Insert a new cell at position |
| `update_cell` | Update cell source code |
| `delete_cell` | Delete a cell |
| `execute_cell` | Execute a cell, show outputs in JupyterLab |
| `execute_code` | Execute code (optionally as new cell with outputs) |

## Claude Code Configuration

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "jupyter": {
      "command": "npx",
      "args": ["tsx", "/path/to/jupyterlab-claude-code/src/index.ts"]
    }
  }
}
```

No token needed in config! Just paste your JupyterLab URL to Claude:
> "Connect to http://localhost:8888/lab?token=abc123"

## Key Technologies

- **TypeScript** with `tsx` for development
- **@modelcontextprotocol/sdk** for MCP server
- **y-websocket** for Yjs sync (same as JupyterLab frontend)
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

## Environment Variables

- `JUPYTER_HOST` - Hostname (default: localhost)
- `JUPYTER_PORT` - Port (default: 8888)
- `JUPYTER_TOKEN` - Auth token (required)

## Important Notes

- Always request a session before connecting to the room
- The `sessionId` must be passed as a query parameter
- Room ID format: `{format}:{type}:{fileId}` (e.g., `json:notebook:abc-123`)
- Cells are in `doc.getArray("cells")` as Y.Map objects
