---
title: Comparison with jupyter-mcp-server
description: How this project compares to datalayer/jupyter-mcp-server.
---

This project was developed independently before we discovered [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server), which solves the same core problem. Both connect Claude (or other LLM tools) to JupyterLab via MCP.

## Quick comparison

| Aspect | jupyterlab-collab-mcp | jupyter-mcp-server |
|--------|----------------------|-------------------|
| Language | TypeScript | Python |
| Install | `git clone` + `npm install` | `pip install` + config |
| Transport | stdio | stdio + Streamable HTTP |
| Connection | Paste JupyterLab URL | Separate env vars |
| Search | `search_notebook` with regex | Not available |
| Cursor awareness | `get_user_focus` | Not available |
| Cell locking | Advisory locks with TTL | Not available |
| Change tracking | Per-cell version history | Not available |
| Snapshots | Named checkpoints | Not available |
| Multi-agent | Cell IDs, locks, attribution | Not designed for this |
| Streaming execution | No | Yes |
| JupyterLab commands | No | `run-all-cells`, `get-selected-cell` |
| Kernel listing | No | `list_kernels` |

## Our advantages

### Simpler setup

```bash
# One command to register
claude mcp add -s user jupyter -- node $PWD/dist/index.js

# Connect by pasting the URL
"Connect to http://localhost:8888/lab?token=abc123"
```

### Search and grep

Search through source code and outputs with regex:

```
search_notebook(path, pattern="Error|Exception", search_in="outputs")
```

### Cursor awareness

See which cell the user is focused on via the Yjs awareness protocol:

```
get_user_focus(path) → { focusedCell: 3, cursorPosition: 42 }
```

### Multi-agent collaboration

Cell locking, change tracking, named snapshots, and per-agent attribution make it safe to run multiple agents on the same notebook. See the [Multi-Agent Guide](/guides/multi-agent/).

### 51 tools

Comprehensive coverage: batch operations, cross-notebook copy/move, cell ID addressing, metadata/tags, diagnostics, symbol rename, and more.

## Their advantages

- **Streamable HTTP transport** — multiple clients, survives disconnects
- **Streaming execution** — output during long-running cells
- **JupyterLab UI commands** — run-all-cells, get-selected-cell
- **Kernel listing** — see available kernels
- **Python ecosystem** — `pip install` if you prefer Python
- **Docker support** — containerized deployment

## When to use which

**Use jupyterlab-collab-mcp when:**
- You want the simplest setup
- You need search, cell locking, or change tracking
- You're running multi-agent workflows
- You're a single user with Claude Code

**Use jupyter-mcp-server when:**
- You need Streamable HTTP for multi-client access
- You want streaming execution output
- You're deploying to production/team environments
- You prefer the Python ecosystem
