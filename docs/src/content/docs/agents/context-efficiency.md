---
title: Context Efficiency
description: How the MCP server minimizes token usage, and how to control output verbosity.
---

The MCP server is designed to be **stingy by default** — responses are compact, outputs are truncated, and verbose diffs are omitted. This page documents all context-related controls.

## Output filtering

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

## Image controls

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_images` | all | Maximum images to return. Shows last N when exceeded. |
| `include_images` | `true` | Set `false` for text-only output. |

Available on: `execute_cell`, `execute_code`, `get_cell_outputs`. Also on `insert_cell` and `update_cell` when `execute=true`.

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
- **`update_cell`** — omits diff by default. Set `show_diff=true` to include it.

## ANSI stripping

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
