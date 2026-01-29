# JupyterLab + Claude Code Integration

An MCP server that connects Claude Code to JupyterLab notebooks in real-time. Changes sync bidirectionally with the browser.

## Features

- **Real-time sync**: See changes appear instantly in JupyterLab
- **Kernel execution**: Run code and see outputs in the notebook
- **Context-efficient**: Filter by cell type, skip outputs, read ranges
- **No extension needed**: Uses JupyterLab's built-in collaboration system

## Prerequisites

- JupyterLab 4.x with `jupyter-collaboration` installed
- Node.js 18+
- Claude Code

```bash
# Install jupyter-collaboration if needed
pip install jupyter-collaboration
```

## Installation

```bash
git clone https://github.com/yourusername/jupyterlab-claude-code.git
cd jupyterlab-claude-code
npm install
npm run build
```

## Configuration

Add to your Claude Code MCP config (`.mcp.json` in project root or `~/.claude.json`):

```json
{
  "mcpServers": {
    "jupyter": {
      "command": "node",
      "args": ["/path/to/jupyterlab-claude-code/dist/index.js"]
    }
  }
}
```

No token in config needed! Just paste your JupyterLab URL when connecting.

## Usage

1. Start JupyterLab: `jupyter lab`
2. Open a notebook
3. In Claude Code, say: "Connect to http://localhost:8888/lab?token=..."
4. Ask Claude to read, edit, or run cells

## MCP Tools

| Tool | Description |
|------|-------------|
| `connect_jupyter` | Connect to JupyterLab (call first with URL) |
| `list_notebooks` | List open notebooks with active kernels |
| `get_notebook_content` | Get cells with filtering options |
| `search_notebook` | Search/grep through source code and outputs |
| `insert_cell` | Insert a new cell at position |
| `update_cell` | Update cell source code |
| `delete_cell` | Delete a cell |
| `get_user_focus` | See user's current cell via awareness |
| `execute_cell` | Execute a cell, show outputs in JupyterLab |
| `execute_code` | Execute code (optionally as new cell) |

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

## License

MIT
