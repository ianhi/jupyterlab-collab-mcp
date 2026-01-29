# JupyterLab + Claude Code Integration

An MCP server that allows Claude Code to interact with JupyterLab notebooks in real-time.

## Features

- **Real-time collaboration**: See Claude's changes appear instantly in your notebook
- **Kernel execution**: Claude can execute code in your active kernel
- **Cell manipulation**: Insert, modify, and delete cells programmatically
- **No custom extension needed**: Uses JupyterLab's built-in RTC infrastructure

## How It Works

This project connects to JupyterLab's existing real-time collaboration system (`jupyter-collaboration`) using the same `y-websocket` library that the JupyterLab frontend uses. No custom JupyterLab extension is required.

```
┌─────────────────┐         stdio          ┌─────────────────────┐
│   Claude Code   │◄─────────────────────►│    MCP Server       │
│                 │      (JSON-RPC)        │    (TypeScript)     │
└─────────────────┘                        └──────────┬──────────┘
                                                      │
                                                      │ y-websocket
                                                      ▼
                                           ┌─────────────────────┐
                                           │  JupyterLab Server  │
                                           │  (jupyter-collab)   │
                                           └─────────────────────┘
```

## Prerequisites

- JupyterLab 4.x with `jupyter-collaboration` installed
- Node.js 18+
- Claude Code

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/jupyterlab-claude-code.git
cd jupyterlab-claude-code

# Install dependencies
npm install

# Build
npm run build
```

## Configuration

Add to your Claude Code MCP configuration (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "jupyterlab": {
      "command": "node",
      "args": ["/path/to/jupyterlab-claude-code/dist/index.js"],
      "env": {
        "JUPYTER_TOKEN": "your-jupyter-token",
        "JUPYTER_PORT": "8888"
      }
    }
  }
}
```

Get your Jupyter token:
```bash
jupyter server list
```

## Usage

1. Start JupyterLab: `jupyter lab`
2. Open a notebook in JupyterLab
3. In Claude Code, ask things like:
   - "What notebooks are open?"
   - "Show me the contents of the notebook"
   - "Add a cell that imports pandas"
   - "Run the first cell"

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_notebooks` | List all open notebooks |
| `get_notebook_content` | Get all cells and metadata |
| `get_cell` | Get a specific cell by index |
| `insert_cell` | Insert a new cell |
| `update_cell` | Update cell source |
| `delete_cell` | Delete a cell |
| `execute_code` | Execute code in kernel |

## Development

See [PROJECT-PROMPT.md](PROJECT-PROMPT.md) for detailed development instructions.

```bash
# Run tests without MCP (for rapid iteration)
JUPYTER_TOKEN=xxx npx tsx src/test.ts

# Build MCP server
npm run build
```

## License

MIT
