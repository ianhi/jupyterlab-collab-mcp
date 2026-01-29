# Project: JupyterLab + Claude Code Integration

## Goal

Build an MCP server that allows Claude Code to interact with JupyterLab notebooks in real-time using the existing jupyter-collaboration RTC infrastructure.

## Key Insight

**We don't need a custom JupyterLab extension.** The `jupyter-collaboration` package already provides:
- WebSocket endpoint at `/api/collaboration/room/{room_id}`
- Yjs-based real-time sync
- Document session API at `/api/collaboration/session/{path}`

We just need an MCP server that connects to these existing endpoints using the same `y-websocket` library that JupyterLab's frontend uses.

## Architecture

```
┌─────────────────┐         stdio          ┌─────────────────────┐
│   Claude Code   │◄─────────────────────►│    MCP Server       │
│                 │      (JSON-RPC)        │    (TypeScript)     │
└─────────────────┘                        └──────────┬──────────┘
                                                      │
                                                      │ y-websocket
                                                      │ (Yjs sync)
                                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    JupyterLab Server                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           jupyter-collaboration (built-in)              │   │
│  │  - /api/collaboration/room/{room_id}  (WebSocket)       │   │
│  │  - /api/collaboration/session/{path}  (REST)            │   │
│  │  - /api/sessions (REST - list notebooks)                │   │
│  │  - /api/kernels/{id}/channels (WebSocket - execution)   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Connection Flow

1. **List notebooks**: `GET /api/sessions` - find open notebooks
2. **Request session**: `PUT /api/collaboration/session/{path}` with `{format: "json", type: "notebook"}`
   - Returns: `{fileId, sessionId, format, type}`
3. **Connect to room**: WebSocket to `/api/collaboration/room/{format}:{type}:{fileId}?sessionId={sessionId}&token={token}`
4. **Sync via y-websocket**: Library handles Yjs sync protocol automatically
5. **Read/write cells**: Access `doc.getArray("cells")` once synced

## Why TypeScript?

The Python Yjs implementation had a **race condition**: the server sends sync messages before loading notebook content. The y-websocket library handles this correctly by:
- Waiting for the `sync` event before returning
- Proper retry/reconnection logic
- Same code paths as JupyterLab frontend

## Implementation Steps

### Step 1: Standalone RTC Client (for testing)

Create a standalone module to test the connection without MCP overhead:

```typescript
// packages/rtc-client/src/index.ts
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

async function connect(path: string, token: string) {
  // 1. Request session
  const session = await fetch(`/api/collaboration/session/${path}`, {
    method: "PUT",
    body: JSON.stringify({ format: "json", type: "notebook" })
  }).then(r => r.json());

  // 2. Create Y.Doc and provider
  const doc = new Y.Doc();
  const roomId = `${session.format}:${session.type}:${session.fileId}`;
  const provider = new WebsocketProvider(wsUrl, roomId, doc, {
    params: { sessionId: session.sessionId, token }
  });

  // 3. Wait for sync
  await new Promise(resolve => {
    provider.on("sync", (synced) => synced && resolve());
  });

  // 4. Access cells
  const cells = doc.getArray("cells");
  console.log(`Synced: ${cells.length} cells`);
}
```

Test with: `npx tsx src/test.ts`

### Step 2: MCP Server Wrapper

Once the RTC client works, wrap it as an MCP server:

```typescript
// packages/mcp-server/src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JupyterRTCClient } from "@jupyterlab-claude-code/rtc-client";

const client = new JupyterRTCClient();

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "get_notebook_content":
      const doc = await client.connect(path);
      return { cells: client.getCells(doc) };
    // ...
  }
});
```

## MCP Tools to Implement

### Notebook Discovery
- `list_notebooks` - List open notebooks via `/api/sessions`
- `get_notebook_content` - Get all cells from synced Y.Doc

### Cell Operations
- `get_cell(index)` - Get single cell
- `insert_cell(index, source, type)` - Insert via `cells.insert()`
- `update_cell(index, source)` - Update via Y.Map or delete/insert
- `delete_cell(index)` - Delete via `cells.delete()`

### Kernel Execution
- `execute_code(code, notebook_path)` - Execute via `/api/kernels/{id}/channels` WebSocket

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "y-websocket": "^2.0.0",
    "yjs": "^13.6.0",
    "zod": "^3.25.0"
  }
}
```

## Development Workflow

1. **Develop RTC client standalone** - Test with `npx tsx`, iterate quickly
2. **Add MCP wrapper** - Once client works, add MCP server layer
3. **Configure Claude Code** - Add MCP server to `~/.claude/mcp.json`

## Testing Without Restarting Claude Code

During development, test the RTC client directly:

```bash
cd packages/rtc-client
npm install
JUPYTER_TOKEN=xxx npx tsx src/test.ts
```

This allows rapid iteration without restarting Claude Code for each change.

## Environment Variables

- `JUPYTER_HOST` - JupyterLab hostname (default: localhost)
- `JUPYTER_PORT` - JupyterLab port (default: 8888)
- `JUPYTER_TOKEN` - Authentication token (required)

## Success Criteria

1. ✅ Connect to notebook room and sync
2. ✅ Read cells (source, type, outputs)
3. ✅ Insert/update/delete cells (changes appear in browser immediately)
4. ✅ Execute code in kernel
5. ✅ Package as MCP server for Claude Code
