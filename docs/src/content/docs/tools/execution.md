---
title: Execution Tools
description: Execute cells and code, run ranges, and manage outputs.
---

Tools for executing code in the notebook's kernel. All execution tools require a JupyterLab connection.

## execute_cell

Execute a cell in the notebook's kernel. Outputs appear in JupyterLab and are returned here.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `index` | number | No | — | Cell index to execute |
| `cell_id` | string | No | — | Cell ID (alternative to index) |
| `timeout` | number | No | `30000` | Timeout in milliseconds (max 300000) |
| `max_images` | number | No | all | Maximum images to return (shows last N) |
| `include_images` | boolean | No | `true` | Include images in response |
**Examples:**
```
# Run cell 3
execute_cell(path="nb.ipynb", index=3)

# Run by cell ID, limit images
execute_cell(path="nb.ipynb", cell_id="a3f8c2d1", max_images=2)

# Text-only output (skip all images)
execute_cell(path="nb.ipynb", index=5, include_images=false)
```

**Notes:**
- When `max_images` is set, the response notes how many images were omitted
- Use `include_images=false` for plot-heavy cells to conserve context

---

## execute_code

Execute code in the notebook's kernel without modifying the notebook. Works with any kernel (Python, R, Julia, etc.).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path (identifies which kernel) |
| `code` | string | Yes | — | Code to execute |
| `timeout` | number | No | `30000` | Timeout in milliseconds (max 300000) |
| `max_images` | number | No | all | Maximum images to return |
| `include_images` | boolean | No | `true` | Include images in response |

**Examples:**
```
# Quick check without adding a cell
execute_code(path="nb.ipynb", code="df.shape")

# Execute and insert as a cell — use insert_cell instead:
insert_cell(path="nb.ipynb", source="df.describe()", execute=true)
```

---

## execute_range

Execute multiple cells in sequence. Continues on error (doesn't stop). Automatically skips markdown and empty cells.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `start_index` | number | No | `0` | First cell index |
| `end_index` | number | No | last cell | Last cell index (inclusive) |
| `cell_ids` | string[] | No | — | Cell IDs to execute in order |
| `timeout` | number | No | `30000` | Timeout per cell in milliseconds |

**Examples:**
```
# Run entire notebook
execute_range(path="nb.ipynb")

# Run cells 0-5
execute_range(path="nb.ipynb", start_index=0, end_index=5)

# Run specific cells by ID
execute_range(path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2", "c1d2e3f4"])
```

---

## filter_output

Post-process cached execution output. Use after `execute_cell`, `execute_code`, or `execute_range` to filter or paginate large outputs without re-executing.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `index` | number | No | — | Cell index whose output to filter |
| `cell_id` | string | No | — | Cell ID (alternative to index) |
| `grep` | string | No | — | Regex filter — only include matching output lines |
| `head` | number | No | — | Show only first N lines |
| `tail` | number | No | — | Show only last N lines |
| `max_lines` | number | No | — | Max output lines (head/tail split) |

**Examples:**
```
# Filter to error lines only
filter_output(path="nb.ipynb", index=5, grep="Error|Traceback")

# Show last 20 lines of output
filter_output(path="nb.ipynb", index=5, tail=20)

# Limit to 100 lines with head/tail split
filter_output(path="nb.ipynb", cell_id="a3f8c2d1", max_lines=100)
```

**Notes:**
- Works on the cached output from the most recent execution — does not re-execute
- Filters can be combined: `grep` filters first, then `head`/`tail`/`max_lines` applies

---

## clear_outputs

Clear execution outputs from cells. Useful before committing notebooks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `index` | number | No | all cells | Cell index to clear |
| `cell_id` | string | No | — | Cell ID (alternative to index) |
| `force` | boolean | No | `false` | Force clear even if human is editing |

**Examples:**
```
# Clear all outputs
clear_outputs(path="nb.ipynb")

# Clear one cell
clear_outputs(path="nb.ipynb", index=5)
```

---

**Next:** [Collaboration features →](../collaboration/)
