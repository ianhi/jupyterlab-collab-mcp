---
title: Context Efficiency
description: How the MCP server minimizes token usage, and how to control output verbosity.
---

The MCP server is designed to be **stingy by default** — responses are compact, outputs are truncated, and verbose diffs are omitted. This page documents the full token cost picture and all context-related controls.

## Schema cost: ~8.6k tokens for 41 tools

Every MCP tool has a JSON schema (name, description, parameters) that the LLM must see to know what tools are available. Here's the breakdown:

| Category | Tools | Schema tokens |
|----------|-------|--------------|
| Connection | 7 | ~830 |
| Reading | 5 | ~1,260 |
| Editing | 7 | ~2,070 |
| Execution | 6 | ~1,500 |
| Metadata & Tags | 4 | ~740 |
| Kernel & Analysis | 5 | ~1,040 |
| Collaboration | 7 | ~1,180 |
| **Total** | **41** | **~8,620** |

For comparison, a typical Claude conversation has a 200k token context window. The full 41-tool schema is ~4.3% of that.

### Claude Code lazy-loads MCP tools

Claude Code uses **deferred tool loading** — MCP tool schemas are not injected into every conversation turn. Instead, tools are loaded on demand when the agent discovers it needs them via a lightweight search. This means:

- **Zero schema cost** in conversations that don't use notebook tools
- **Partial cost** when only a few tools are needed (e.g., just `execute_cell` and `get_notebook_content`)
- **Full ~8.6k cost** only when the agent loads all 41 tools in a single session

This is why we consolidated from 55 to 41 tools — fewer schemas means less overhead when tools are loaded, and the consolidation preserved all functionality.

### Most expensive tool schemas

The largest individual schemas (these have the most parameters):

| Tool | Tokens | Why |
|------|--------|-----|
| `get_notebook_content` | ~420 | Many filtering options (cell_type, indices, cell_ids, output controls) |
| `kernel_variables` | ~390 | Merged list + inspect modes with detail/filter options |
| `update_cell` | ~380 | Supports execute, show_diff, cell selection, lock override |
| `insert_cell` | ~360 | Supports execute, cell positioning, metadata |
| `delete_cell` | ~350 | Single + batch modes (indices, cell_ids, range) |

The cheapest tools are under 100 tokens each: `list_files` (~70), `list_kernels` (~73), `rename_notebook` (~93).

## Response token efficiency

Beyond schema costs, the server minimizes tokens in tool responses:

### Default truncation
- **Execution output**: Capped at 50 lines by default (head/tail split). Full output cached for `filter_output` access.
- **Cell outputs**: `get_notebook_content` defaults to `include_outputs=false` and caps output text at 500 chars per cell.
- **Diffs**: `update_cell` omits diffs by default. Set `show_diff=true` when needed.
- **File listings**: One line per item (`[dir]`/`[notebook]`/`[file]` tags) — ~60% smaller than JSON.

### Output filtering

Use the `filter_output` tool to post-process cached execution output from `execute_cell`, `execute_code`, `execute_range`, or `get_cell_outputs`. This avoids re-executing code just to see filtered output.

| Parameter | Description |
|-----------|-------------|
| `grep` | Regex filter — only include lines matching this pattern. Useful for `"Error\|Warning"`. |
| `tail` | Show only last N lines. Useful for training logs. |
| `head` | Show only first N lines. |
| `max_lines` | Head/tail split truncation. Shows first 60% + last 40% of lines with omission note. |

These can be combined: `grep` filters first, then `tail`/`head`/`max_lines` applies to the filtered result.

**Examples:**
```
# Execute a cell, then filter its output
execute_cell(path="nb.ipynb", index=5)

# See only last 10 lines
filter_output(path="nb.ipynb", index=5, tail=10)

# Filter to error lines only
filter_output(path="nb.ipynb", index=5, grep="Error|Traceback")

# Limit to 100 lines with head/tail split
filter_output(path="nb.ipynb", index=5, max_lines=100)
```

### Image controls

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_images` | all | Maximum images to return. Shows last N when exceeded. |
| `include_images` | `true` | Set `false` for text-only output. |

Available on: `execute_cell`, `execute_code`, `get_cell_outputs`. Also on `insert_cell` and `update_cell` when `execute=true`.

**Tip**: A single base64-encoded matplotlib figure can be 50k–200k tokens. Use `include_images=false` or `max_images=1` for plot-heavy notebooks.

### Reading controls

#### get_notebook_content
- `cell_type="code"` (default) skips markdown cells
- `include_outputs=false` (default) omits outputs entirely
- `max_output_chars=500` (default) truncates output text per cell. Set `0` for unlimited
- Use `cell_ids` or `indices` to read specific cells

#### get_notebook_outline
Returns a condensed view: headers by level + first line of code cells. Use this before reading full cells.

#### search_notebook
Returns only matching lines with context (not full cell source). `context_lines=1` (default) shows 1 line above and below each match.

### Compact responses

These tools produce compact output by default:

- **`list_files`** — one line per item with `[dir]`/`[notebook]`/`[file]` tags (~60% smaller than JSON)
- **`insert_cell`** — confirmation message only (no diff)
- **`batch_insert_cells`** — compact list: `[index] id (type)` per line (no per-cell diffs)
- **`update_cell`** — omits diff by default. Set `show_diff=true` to include it.

### ANSI stripping

All output text has ANSI escape codes stripped automatically. Python tracebacks, colorized logging, and terminal formatting are cleaned before being returned, saving tokens on invisible characters.

## Summary of context-related parameters

| Parameter | Tools | Default | Purpose |
|-----------|-------|---------|---------|
| `grep` | filter_output | — | Filter output lines |
| `tail` | filter_output | — | Show last N lines |
| `head` | filter_output | — | Show first N lines |
| `max_lines` | filter_output | — | Truncate long output |
| `max_images` | execute_*, get_cell_outputs | all | Limit images |
| `include_images` | execute_*, get_cell_outputs | `true` | Disable images |
| `max_output_chars` | get_notebook_content | `500` | Truncate output text |
| `cell_type` | get_notebook_content | `"code"` | Skip markdown |
| `include_outputs` | get_notebook_content | `false` | Omit outputs |
| `context_lines` | search_notebook | `1` | Context around matches |
| `show_diff` | update_cell | `false` | Include source diff |
