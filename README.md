# JupyterLab Collab MCP

Give AI assistants full access to your Jupyter notebooks — read, edit, execute, and collaborate in real-time.

```
Claude Code  ←—stdio—→  MCP Server  ←—y-websocket—→  JupyterLab
```

## Why?

Claude Code can already edit files, but notebooks are special — they have cells, kernels, outputs, and a live browser UI. This MCP server bridges the gap:

- **Real-time sync** — edits appear instantly in JupyterLab via y-websocket
- **41 tools** — read, edit, execute, search, diff, tag, lock, snapshot, and more
- **Cell ID addressing** — stable references that survive insertions and deletions
- **Multi-agent ready** — cell locking, change tracking, and per-agent attribution
- **Context-efficient** — filter by cell type, skip outputs, limit images
- **No extension needed** — uses JupyterLab's built-in `jupyter-collaboration`

## Install

### With npx (recommended)

Requires [Node.js 18+](https://nodejs.org/). No cloning or building needed:

```bash
claude mcp add -s user jupyter -- npx jupyterlab-collab-mcp
```

That's it. `npx` downloads and caches the package automatically.

### With uvx (no Node.js required)

If you don't have Node.js installed, the [`deno`](https://pypi.org/project/deno/) PyPI package bundles Deno — a JavaScript runtime with built-in npm compatibility:

```bash
claude mcp add -s user jupyter -- uvx deno -A npm:jupyterlab-collab-mcp
```

### From source (development)

```bash
git clone https://github.com/ianhi/jupyterlab-collab-mcp.git
cd jupyterlab-collab-mcp
npm install && npm run build
claude mcp add -s user jupyter -- node $PWD/dist/index.js
```

## Usage

1. Start JupyterLab with [`jlabx`](https://github.com/ianhi/jlabx) (or `jupyter lab` if you already have `jupyter-collaboration` installed)
2. In Claude Code: _"Connect to http://localhost:8888/lab?token=..."_
3. Ask Claude to read, edit, or run cells

Most tools also work **without** a JupyterLab connection by reading/writing `.ipynb` files directly (no kernel operations in this mode).

## jlabx launcher

[`jlabx`](https://github.com/ianhi/jlabx) launches JupyterLab with all the right extensions (collaboration, LSP, vim, MyST, git) without modifying your project dependencies.

```bash
uv tool install jlabx
jlabx
```

## Documentation

**Full docs: https://ianhi.github.io/jupyterlab-collab-mcp/**

The docs site has detailed tool reference pages, parameter tables, examples, and guides for multi-agent collaboration.

## Related Projects

See also [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server) — a Python-based alternative with Streamable HTTP transport and streaming execution. See the [comparison page](https://ianhi.github.io/jupyterlab-collab-mcp/comparison/) for detailed differences.

## Development

### Setup

```bash
git clone https://github.com/ianhi/jupyterlab-collab-mcp.git
cd jupyterlab-collab-mcp
npm install
```

### Dev workflow

Point the MCP server at your local build and run the TypeScript compiler in watch mode:

```bash
claude mcp add -s user jupyter -- node $PWD/dist/index.js
npm run build    # initial build
npm run watch    # recompile on file changes (run in a separate terminal)
```

After each recompile, run `/mcp` in Claude Code to reconnect to the updated server. No need to remove and re-add the MCP config.

> **Why not `tsx --watch`?** MCP servers are long-running stdio processes. `tsx --watch` detects the server as "completed" and kills it, breaking the connection.

### Build + test

```bash
npm run build          # compile TypeScript to dist/
npm run watch          # same, but recompile on changes
npm test               # run unit tests (vitest)
npm run test:watch     # run tests in watch mode
```

### Integration testing

Requires a running JupyterLab with `jupyter-collaboration`:

```bash
jlabx                                    # start JupyterLab (or jupyter lab)
JUPYTER_TOKEN=<token> npm run test:integration   # run src/test.ts against it
```

### After changing tool schemas

If you add/remove tools or change their parameters, run `/mcp` in Claude Code to reconnect. The server caches tool definitions at startup, so a reconnect is needed for schema changes to take effect.

## License

BSD-3-Clause
