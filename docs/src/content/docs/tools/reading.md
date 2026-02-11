---
title: Reading Tools
description: Read notebook content, get outlines, search, and fetch outputs.
---

Tools for reading notebook content efficiently.

## get_notebook_content

Get cells from a notebook. By default returns only source code (no outputs) to save context.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `cell_type` | `"all"` \| `"code"` \| `"markdown"` | No | `"code"` | Filter by cell type |
| `include_outputs` | boolean | No | `false` | Include cell outputs |
| `output_format` | `"text"` \| `"structured"` | No | `"text"` | Output format when outputs included |
| `start_index` | number | No | `0` | Start from this cell index |
| `end_index` | number | No | last cell | End at this cell index (inclusive) |
| `indices` | number[] | No | — | Specific cell indices (e.g., `[2,5,8]`). Overrides start/end |
| `cell_ids` | string[] | No | — | Select by cell ID (prefix match). Overrides indices |

**Examples:**
```
# Just code cells, no outputs (default)
get_notebook_content(path="analysis.ipynb")

# Everything including outputs
get_notebook_content(path="analysis.ipynb", cell_type="all", include_outputs=true)

# Specific cells by ID
get_notebook_content(path="analysis.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"])

# Range of cells
get_notebook_content(path="analysis.ipynb", start_index=5, end_index=10)
```

**Output formats:**
- `"text"` (default) — returns outputs as a single `output` string (just text/plain content)
- `"structured"` — returns `outputs` array with metadata (output_type, has_image, has_html)

---

## get_notebook_outline

Get a condensed outline of the notebook structure. Returns cell indices with markdown headers and first-line previews of code cells.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |

**Example:**
```
get_notebook_outline(path="analysis.ipynb")
```

**Notes:**
- Useful for navigating large notebooks before using `update_cell` or `add_cell_tags`
- Shows markdown headers by level (H1, H2, etc.) and first line of code cells

---

## search_notebook

Search/grep through notebook cells for a pattern (regex supported).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `pattern` | string | Yes | — | Search pattern (regex supported) |
| `search_in` | `"source"` \| `"outputs"` \| `"all"` | No | `"all"` | Where to search |
| `case_sensitive` | boolean | No | `false` | Case-sensitive search |
| `max_results` | number | No | unlimited | Maximum matching cells to return |
| `max_source_length` | number | No | `500` | Truncate source/output to this length |

**Examples:**
```
# Find errors in outputs
search_notebook(path="analysis.ipynb", pattern="Error|Exception", search_in="outputs")

# Find function definitions
search_notebook(path="analysis.ipynb", pattern="def \\w+", search_in="source")
```

---

## get_cell_outputs

Get execution outputs from specific cells without fetching source code.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `index` | number | No | — | Cell index (start of range if `end_index` set) |
| `end_index` | number | No | — | Last cell index (inclusive) |
| `indices` | number[] | No | — | Specific cell indices |
| `cell_ids` | string[] | No | — | Cell IDs (alternative to indices) |
| `max_images` | number | No | all | Maximum images to return (shows last N) |
| `include_images` | boolean | No | `true` | Include images in response |

**Example:**
```
# Check output of a specific cell, text only
get_cell_outputs(path="analysis.ipynb", index=5, include_images=false)
```

---

**Next:** [Editing cells →](../editing/)
