---
title: Context Efficiency
description: How the MCP server minimizes token usage, and how to control output verbosity.
---

The MCP server is designed to be **stingy by default** — responses are compact, outputs are truncated, and verbose diffs are omitted. This page documents all context-related controls.

## Output filtering (execution tools)

Execute tools (`execute_cell`, `execute_code`, `execute_range`, `insert_and_execute`, `update_and_execute`) and `get_cell_outputs` support three output filtering parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_output_lines` | `50` | Head/tail split truncation. Shows first 60% + last 40% of lines with omission note. Set `0` for unlimited. |
| `output_tail` | — | Show only last N lines. Overrides `max_output_lines`. Useful for training logs. |
| `output_grep` | — | Regex filter — only include lines matching this pattern. Useful for `"Error\|Warning"`. |

These can be combined: `output_grep` filters first, then `output_tail` or `max_output_lines` applies to the filtered result.

**Examples:**
```
# Default: auto-truncates at 50 lines
execute_cell(path="nb.ipynb", index=5)

# See only last 10 lines
execute_cell(path="nb.ipynb", index=5, output_tail=10)

# Filter to error lines only
execute_cell(path="nb.ipynb", index=5, output_grep="Error|Traceback")

# Unlimited output
execute_cell(path="nb.ipynb", index=5, max_output_lines=0)
```

## Image controls

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_images` | all | Maximum images to return. Shows last N when exceeded. |
| `include_images` | `true` | Set `false` for text-only output. |

Available on: `execute_cell`, `execute_code`, `insert_and_execute`, `update_and_execute`, `get_cell_outputs`.

## Reading controls

### get_notebook_content
- `cell_type="code"` (default) skips markdown cells
- `include_outputs=false` (default) omits outputs entirely
- `max_output_chars=500` (default) truncates output text per cell. Set `0` for unlimited
- Use `cell_ids` or `indices` to read specific cells

### get_notebook_outline
Returns a condensed view: headers by level + first line of code cells. Use this before reading full cells.

### search_notebook
Returns only matching lines with context (not full cell source). `context_lines=1` (default) shows 1 line above and below each match.

## Compact responses

These tools produce compact output by default:

- **`list_files`** — one line per item with `[dir]`/`[notebook]`/`[file]` tags (~60% smaller than JSON)
- **`insert_cell`** — confirmation message only (no diff)
- **`batch_insert_cells`** — compact list: `[index] id (type)` per line (no per-cell diffs)
- **`update_and_execute`** — omits diff by default. Set `show_diff=true` to include it.

## ANSI stripping

All output text has ANSI escape codes stripped automatically. Python tracebacks, colorized logging, and terminal formatting are cleaned before being returned, saving tokens on invisible characters.

## Summary of context-related parameters

| Parameter | Tools | Default | Purpose |
|-----------|-------|---------|---------|
| `max_output_lines` | execute_*, get_cell_outputs | `50` | Truncate long output |
| `output_tail` | execute_*, get_cell_outputs | — | Show last N lines |
| `output_grep` | execute_*, get_cell_outputs | — | Filter output lines |
| `max_images` | execute_*, get_cell_outputs | all | Limit images |
| `include_images` | execute_*, get_cell_outputs | `true` | Disable images |
| `max_output_chars` | get_notebook_content | `500` | Truncate output text |
| `cell_type` | get_notebook_content | `"code"` | Skip markdown |
| `include_outputs` | get_notebook_content | `false` | Omit outputs |
| `context_lines` | search_notebook | `1` | Context around matches |
| `show_diff` | update_and_execute | `false` | Include source diff |
