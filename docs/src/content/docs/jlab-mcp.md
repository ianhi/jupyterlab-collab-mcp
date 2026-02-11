---
title: jlab-mcp Launcher
description: Launch JupyterLab with all the right extensions for MCP collaboration.
---

The `jlab-mcp` launcher starts JupyterLab with all the extensions needed for MCP collaboration, without modifying your project's dependencies. Also available as `jupyter-collab`.

## Install

```bash
# Recommended — installs the jlab-mcp command globally
uv tool install jlab-mcp

# Or via pipx
pipx install jlab-mcp
```

No Node.js required. The launcher is a standalone Python package.

## Usage

```bash
# Launch JupyterLab
jlab-mcp

# Skip user extensions (core only, useful for debugging)
jlab-mcp --no-extras

# Pass arguments through to jupyter lab
jlab-mcp --no-browser --ip=0.0.0.0
```

## Core extensions

These are always injected and cannot be removed — they're required for MCP collaboration:

| Package | Purpose |
|---------|---------|
| `jupyter-collaboration` | Real-time sync via y-websocket |
| `jupyter-lsp` + `python-lsp-server` | Diagnostics and hover info |

## Managing extensions

Use subcommands to manage user extensions without editing the config file:

```bash
# List all configured extensions
jlab-mcp list

# Add extensions
jlab-mcp add jupyterlab-drawio jupyterlab-execute-time

# Remove extensions
jlab-mcp remove jupyterlab-vim
```

Duplicates are detected automatically. Changes take effect on the next launch.

## Config file

On first run, `jlab-mcp` creates `~/.config/jlab-mcp/config.toml` with defaults:

```toml
extensions = [
    "jupyterlab-vim",
    "jupyterlab-myst",
    "jupyterlab-git",
]
```

You can also edit this file directly. The config location respects `$XDG_CONFIG_HOME` (falls back to `~/.config`).

## Environment detection

The launcher auto-detects your environment:

| Directory type | Behavior |
|---------------|----------|
| Has `pyproject.toml` | `uv run` with local package + deps + extras |
| Has `pixi.toml` | `pixi run` (add extras to pixi.toml manually) |
| Neither | Standalone mode via `uvx` with all extras |

## Requirements

- [uv](https://docs.astral.sh/uv/) is preferred (fast, native binary)
- If `uv` is not installed but `npx` is available, the script falls back to [`@manzt/uv`](https://github.com/manzt/uv-npm) (npx will prompt before installing)
- If neither is found, the script prints install instructions and exits

## Options

| Flag / Variable | Description |
|----------------|-------------|
| `--no-extras` | Skip user extensions from config, only inject core extensions |
| `JUPYTER_PORT=9999` | Custom port (default: 8888) |

All other arguments are passed through to `jupyter lab`:

```bash
JUPYTER_PORT=9999 jlab-mcp --no-browser --ip=0.0.0.0
```

The script handles Ctrl+C gracefully, force-killing JupyterLab if it hangs during shutdown.
