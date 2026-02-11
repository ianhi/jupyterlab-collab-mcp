---
title: jupyter-claude Launcher
description: Launch JupyterLab with all the right extensions for Claude Code collaboration.
---

The `jupyter-claude` script is a convenience launcher that starts JupyterLab with all the extensions Claude Code needs, without modifying your project's dependencies.

## Usage

```bash
# Add to your PATH (one-time setup)
export PATH="/path/to/jupyterlab-claude-code/bin:$PATH"

# Launch from any directory
jupyter-claude

# Skip user extensions (core only, useful for debugging)
jupyter-claude --no-extras

# Pass arguments through to jupyter lab
jupyter-claude --no-browser --ip=0.0.0.0
```

## Core extensions

These are always injected and cannot be removed — they're required for Claude Code integration:

| Package | Purpose |
|---------|---------|
| `jupyter-collaboration` | Real-time sync for Claude Code |
| `jupyter-lsp` + `python-lsp-server` | Diagnostics and hover info |

## User extensions

On first run, `jupyter-claude` creates a config file at `~/.config/jupyter-claude/config.toml` with these defaults:

```toml
# jupyter-claude configuration
#
# Extra packages to include when launching JupyterLab.
# Core extensions (jupyter-collaboration, jupyter-lsp, python-lsp-server)
# are always included and don't need to be listed here.
#
# To skip these extras temporarily, run: jupyter-claude --no-extras

extensions = [
    "jupyterlab-vim",
    "jupyterlab-myst",
    "jupyterlab-git",
]
```

Edit this file to add or remove extensions. Changes take effect on the next launch — no rebuild needed.

The config location respects `$XDG_CONFIG_HOME` (falls back to `~/.config`).

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
JUPYTER_PORT=9999 jupyter-claude --no-browser --ip=0.0.0.0
```

The script handles Ctrl+C gracefully, force-killing JupyterLab if it hangs during shutdown.
