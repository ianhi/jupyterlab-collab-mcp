# Comparison: jupyterlab-collab-mcp vs datalayer/jupyter-mcp-server

This document compares our implementation with the existing [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server).

## Quick Summary

| Aspect | Ours (jupyterlab-collab-mcp) | Theirs (jupyter-mcp-server) |
|--------|-------------------------------|------------------------------|
| Language | TypeScript | Python |
| Install | `git clone` + `npm install` | `pip install` + config |
| Transport | stdio only | stdio + Streamable HTTP |
| Connection | Paste JupyterLab URL with token | Separate env vars for URL/token |
| Search | `search_notebook` with regex | Not implemented |
| Awareness | `get_user_focus` (cursor tracking) | Not implemented |
| Multi-notebook | Implicit (by path) | Explicit `use_notebook`/`unuse_notebook` |
| File browser | `list_files` | `list_files` |
| Open/create notebooks | `open_notebook`, `create_notebook` | Similar |
| Kernel management | No | `list_kernels`, `restart_notebook` |
| Output filtering | `output_format`, `cell_type` | `response_format` (brief/detailed) |
| Streaming execution | No | Yes (`stream` flag) |
| JupyterLab commands | No | `run-all-cells`, `get-selected-cell` |

## Our Advantages

### 1. Simpler Installation
```bash
# Ours - one command
claude mcp add jupyter -- npx jupyterlab-collab-mcp

# Theirs - multiple steps
pip install jupyter-mcp-server
# Then configure env vars or CLI args
# Then potentially run separate MCP server process
```

### 2. Simpler Connection
```
# Ours - just paste the URL
"Connect to http://localhost:8888/lab?token=abc123"

# Theirs - separate configuration
JUPYTER_URL=http://localhost:8888
JUPYTER_TOKEN=abc123
# Or pass as CLI args
```

### 3. Search Capability (`search_notebook`)
We have grep-like search through notebook content:
```
search_notebook(path, pattern="Error|Exception", search_in="outputs")
```
- Regex support
- Search source code, outputs, or both
- Case-insensitive by default
- Returns matching cells with context

**They don't have this.** Could be a valuable upstream contribution.

### 4. Cursor Awareness (`get_user_focus`)
We can see which cell the user is focused on:
```
get_user_focus(path) → { focusedCell: 3, cursorPosition: 42 }
```
Uses JupyterLab's Yjs awareness protocol.

**They don't have this.** Could be useful for context-aware assistance.

### 5. Better Output Filtering
We have granular control over output format:
```
get_notebook_content(
  path,
  cell_type="code",           # Skip markdown
  include_outputs=true,
  output_format="text"        # Just text/plain, no metadata
)
```

They have `response_format` (brief/detailed) but less granular control.

## Their Advantages

### 1. Streamable HTTP Transport
- Server runs independently
- Multiple clients can connect
- Better for team/production deployments
- Survives client disconnects

### 2. More Kernel Tools
- `list_kernels` - See available kernels
- `restart_notebook` - Restart kernel without reconnecting

### 3. Streaming Execution
```python
execute_cell(cell_index, stream=True, progress_interval=1.0)
```
Can stream output during long-running cells.

### 4. JupyterLab Integration Tools
- `notebook_run-all-cells` - Run entire notebook
- `notebook_get-selected-cell` - Get currently selected cell in UI

### 5. Jupyter Server Extension Mode
Can run as a Jupyter server extension for tighter integration.

### 6. More Mature/Production-Ready
- Docker support
- Better documentation
- Active development by Datalayer team

## Potential Upstream Contributions

### High Value
1. **`search_notebook` tool** - Grep through source/outputs with regex
2. **`get_user_focus` tool** - Cursor awareness via Yjs awareness protocol
3. **Simplified URL-based connection** - Parse token from URL automatically

### Medium Value
4. **Output format filtering** - `output_format: "text"` option for context efficiency
5. **Cell type filtering** - `cell_type: "code"` to skip markdown

### Implementation Notes for Upstream

If contributing to jupyter-mcp-server:

**Search tool** would go in `jupyter_mcp_server/tools/search_notebook_tool.py`:
- Accept `pattern`, `search_in`, `case_sensitive` params
- Use their `notebook_manager` to get cell content
- Return matching cells with context

**Awareness/focus** would require:
- Accessing the Yjs awareness from their `NbModelClient`
- May need changes to `jupyter_nbmodel_client` dependency
- Less straightforward than search

## When to Use Which

**Use ours (jupyterlab-collab-mcp) when:**
- You want the simplest possible setup
- You need search/grep through notebooks
- You want cursor awareness
- You're a single user with Claude Code
- You prefer TypeScript/npm ecosystem

**Use theirs (jupyter-mcp-server) when:**
- You need Streamable HTTP for multi-client access
- You need file browsing, kernel management
- You want streaming execution output
- You're deploying to production/team environment
- You want JupyterLab UI integration commands
- You prefer Python ecosystem

## Conclusion

Both projects solve the same core problem (MCP ↔ JupyterLab) but with different tradeoffs. Ours is simpler and has unique search/awareness features. Theirs is more comprehensive and production-ready.

The search and awareness features would be valuable contributions to the upstream project. The simplified URL-based connection could also improve their UX.
