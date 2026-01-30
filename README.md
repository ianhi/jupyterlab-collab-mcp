# JupyterLab + Claude Code Integration

An MCP server that connects Claude Code to JupyterLab notebooks in real-time. Changes sync bidirectionally with the browser.

> **Note**: See also [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server) - a similar project with more features. This project offers simpler setup, `search_notebook`, and cursor awareness. See [Related Projects](#related-projects) for details.

## Features

- **Real-time sync**: See changes appear instantly in JupyterLab
- **Kernel execution**: Run code and see outputs in the notebook
- **Code diagnostics**: Detect errors without execution (via `ruff`)
- **Context-efficient**: Filter by cell type, skip outputs, read ranges
- **No extension needed**: Uses JupyterLab's built-in collaboration system

## Quick Start with `jupyter-claude`

The easiest way to launch JupyterLab with all the right extensions:

```bash
# Add to your PATH (one-time setup)
export PATH="/path/to/jupyterlab-claude-code/bin:$PATH"

# Then from any directory:
jupyter-claude
```

This command auto-detects your environment:

| Directory Type | Behavior |
|----------------|----------|
| Has `pyproject.toml` | Installs local package + deps + Claude Code extras |
| Has `pixi.toml` | Uses `pixi run` (add extras to pixi.toml) |
| Neither | Standalone mode with all extras included |

**Extras added automatically** (without modifying your project):
- `jupyter-collaboration` - real-time sync for Claude Code
- `jupyter-lsp` + `python-lsp-server` - diagnostics and hover info
- `jupyterlab-vim` - vim keybindings

Requires [uv](https://docs.astral.sh/uv/) to be installed.

## Prerequisites

- JupyterLab 4.x with `jupyter-collaboration` installed
- Node.js 18+
- Claude Code
- [uv](https://docs.astral.sh/uv/) (optional, for `jupyter-claude` launcher and enhanced diagnostics)

```bash
# Install jupyter-collaboration if needed
pip install jupyter-collaboration
```

## Installation

```bash
git clone https://github.com/ianhi/jupyterlab-claude-code.git
cd jupyterlab-claude-code
npm install && npm run build
claude mcp add jupyter -- node $PWD/dist/index.js
```

No token in config - just paste your JupyterLab URL when connecting.

## Usage

1. Start JupyterLab: `jupyter lab`
2. Open a notebook
3. In Claude Code, say: "Connect to http://localhost:8888/lab?token=..."
4. Ask Claude to read, edit, or run cells

## MCP Tools

| Tool | Description |
|------|-------------|
| `connect_jupyter` | Connect to JupyterLab (call first with URL) |
| `list_files` | List files/notebooks in a directory |
| `list_notebooks` | List open notebooks with active kernels |
| `open_notebook` | Open a notebook and start its kernel |
| `create_notebook` | Create a new notebook file |
| `get_notebook_content` | Get cells with filtering options |
| `get_notebook_outline` | Get condensed structure (headers + first lines) |
| `search_notebook` | Search/grep through source code and outputs |
| `replace_in_notebook` | Search and replace across cells (refactoring) |
| `get_diagnostics` | Get errors/warnings without execution (via ruff) |
| `get_hover_info` | Get documentation/type info at a position |
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
| `execute_code` | Execute code (optionally as new cell) |
| `get_cell_metadata` | Get metadata/tags for cell(s) |
| `set_cell_metadata` | Set metadata for cell(s) |
| `add_cell_tags` | Add tags to cell(s) |
| `remove_cell_tags` | Remove tags from cell(s) |
| `get_notebook_metadata` | Get notebook-level metadata |
| `set_notebook_metadata` | Set notebook-level metadata |
| `rename_notebook` | Rename a notebook file |
| `diff_notebooks` | Compare two notebooks cell by cell |
| `get_kernel_status` | Check if kernel is idle/busy/dead |
| `get_kernel_variables` | List variables defined in the kernel |
| `interrupt_kernel` | Stop running execution |
| `restart_kernel` | Restart kernel (clears all state) |

### Non-Contiguous Cell Operations

Metadata and tag tools support both ranges and specific indices:
```
# Range (contiguous)
add_cell_tags(path, index=0, end_index=5, tags=["hide-input"])

# Specific cells (non-contiguous)
add_cell_tags(path, indices=[2,4,6,8], tags=["hide-input"])
```

### Context-Efficient Reading

`get_notebook_content` defaults to code cells only, no outputs:

```
cell_type: "code" (default), "markdown", or "all"
include_outputs: false (default) - set true only when needed
output_format: "text" (default) or "structured" - text combines outputs into a string
start_index / end_index: read specific cell ranges
```

## How It Works

This server connects to JupyterLab's existing real-time collaboration system (`jupyter-collaboration`) using `y-websocket` - the same protocol the JupyterLab frontend uses.

```
Claude Code  <--stdio-->  MCP Server  <--y-websocket-->  JupyterLab
```

## Development

```bash
# Test RTC connection without restarting Claude Code
JUPYTER_TOKEN=xxx npx tsx src/test.ts

# Build
npm run build

# Watch mode
npm run watch
```

## Related Projects

This project was developed independently before we discovered [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server), which solves the same problem.

**Why keep both?** This project offers:
- **Simpler setup**: One command install, just paste your JupyterLab URL
- **`search_notebook`**: Grep through source code and outputs with regex
- **`get_user_focus`**: See which cell the user is editing (cursor awareness)
- **TypeScript/npm**: If you prefer the Node.js ecosystem

**Consider jupyter-mcp-server if you need:**
- Streamable HTTP transport (multi-client, production deployments)
- File browsing, kernel management, streaming execution
- Python ecosystem

See [COMPARISON.md](COMPARISON.md) for detailed differences.

## License

MIT
