---
title: Editing Tools
description: Insert, update, delete, copy cells, and search-replace.
---

Tools for modifying notebook cells. All editing tools support [cell ID addressing](../collaboration/#cell-id-addressing) and sync changes in real-time to the JupyterLab browser.

## insert_cell

Insert a new cell into the notebook.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `source` | string | Yes | — | Cell source code |
| `index` | number | No | end | Position to insert (0 = beginning, -1 = end) |
| `cell_id` | string | No | — | Insert after this cell ID (alternative to index) |
| `cell_type` | `"code"` \| `"markdown"` | No | `"code"` | Cell type |
| `execute` | boolean | No | `false` | Execute the cell immediately after inserting |
| `timeout` | number | No | `30000` | Execution timeout (only when `execute=true`) |
| `max_images` | number | No | all | Maximum images to return (only when `execute=true`) |
| `include_images` | boolean | No | `true` | Include images (only when `execute=true`) |
| `client_name` | string | No | `"claude-code"` | Agent name for change attribution |

**Examples:**
```
# Insert a cell
insert_cell(path="nb.ipynb", source="import pandas as pd", index=0)

# Insert and execute in one operation
insert_cell(path="nb.ipynb", source="print('hello')", index=0, execute=true)
```

**Notes:**
- Response is a compact confirmation message (no diff shown)

---

## update_cell

Update the source code of an existing cell. Preserves outputs and metadata.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `source` | string | Yes | — | New source code |
| `index` | number | No | — | Cell index to update |
| `cell_id` | string | No | — | Cell ID to update (alternative to index) |
| `force` | boolean | No | `false` | Force update even if a human is editing |
| `execute` | boolean | No | `false` | Execute the cell immediately after updating |
| `show_diff` | boolean | No | `false` | Include a diff of the source change in the response |
| `timeout` | number | No | `30000` | Execution timeout (only when `execute=true`) |
| `max_images` | number | No | all | Maximum images to return (only when `execute=true`) |
| `include_images` | boolean | No | `true` | Include images (only when `execute=true`) |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution and lock matching |

**Examples:**
```
# Update a cell
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="print('updated')")

# Update and execute in one operation
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="print('updated')", execute=true)

# Update with diff shown
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="print('updated')", show_diff=true)
```

**Notes:**
- Only modifies source, not metadata/tags (use `cell_tags`/`cell_metadata` for those)
- Use `clear_outputs` to remove outputs
- Checks [human-focus protection](../collaboration/#human-focus-protection) and [cell locks](../collaboration/#cell-locking)

---

## batch_update_cells

Update multiple cells at once. More efficient than calling `update_cell` repeatedly.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `updates` | array | Yes | — | Array of `{index, source}` updates |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution |

**Example:**
```
batch_update_cells(path="nb.ipynb", updates=[
  {index: 0, source: "import numpy as np"},
  {index: 2, source: "x = np.array([1,2,3])"}
])
```

---

## batch_insert_cells

Insert multiple cells at once. Inserts are applied in order, accounting for prior insertions.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `inserts` | array | Yes | — | Array of cells to insert |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution |

Each insert object:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | string | Yes | — | Cell source code |
| `cell_type` | `"code"` \| `"markdown"` | No | `"code"` | Cell type |
| `index` | number | No | end | Position to insert |
| `cell_id` | string | No | — | Insert after this cell ID |

**Example:**
```
batch_insert_cells(path="nb.ipynb", inserts=[
  {source: "# Setup", cell_type: "markdown", index: 0},
  {source: "import pandas as pd", index: 1},
  {source: "import numpy as np", index: 2}
])
```

**Notes:**
- Response lists inserted cells compactly: `[index] id (type)` per line (no diffs)

---

## delete_cell

Delete one or more cells from the notebook. Supports single cell, multiple cells by index/ID, or ranges.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `index` | number | No | — | Cell index to delete |
| `cell_id` | string | No | — | Cell ID to delete (alternative to index) |
| `indices` | number[] | No | — | Multiple cell indices to delete |
| `cell_ids` | string[] | No | — | Multiple cell IDs to delete |
| `start_index` | number | No | — | First cell index of range (inclusive) |
| `end_index` | number | No | — | Last cell index of range (inclusive) |
| `force` | boolean | No | `false` | Force delete even if human is editing |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution |

**Examples:**
```
# Delete a single cell
delete_cell(path="nb.ipynb", cell_id="a3f8c2d1")

# Delete multiple cells by index
delete_cell(path="nb.ipynb", indices=[2, 5, 8])

# Delete a range
delete_cell(path="nb.ipynb", start_index=3, end_index=7)

# Delete multiple cells by ID
delete_cell(path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"])
```

**Notes:**
- Deleted cells can be recovered with [`recover_cell`](../collaboration/#recover_cell)

---

## change_cell_type

Change a cell's type (code ↔ markdown) in place, preserving content.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `new_type` | `"code"` \| `"markdown"` | Yes | — | New cell type |
| `index` | number | No | — | Cell index |
| `cell_id` | string | No | — | Cell ID (alternative to index) |
| `force` | boolean | No | `false` | Force change even if human is editing |

---

## copy_cells

Copy or move cells within a notebook or between notebooks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source_path` | string | Yes | — | Source notebook path |
| `dest_path` | string | Yes | — | Destination notebook path (can be same as source) |
| `start_index` | number | No | — | First cell index to copy (inclusive) |
| `end_index` | number | No | — | Last cell index to copy (inclusive) |
| `cell_ids` | string[] | No | — | Cell IDs to copy (more robust in concurrent editing) |
| `dest_index` | number | No | end | Position in destination |
| `dest_cell_id` | string | No | — | Insert after this cell ID in destination |
| `delete_source` | boolean | No | `false` | Delete source cells after copying (move operation) |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution |

**Examples:**
```
# Copy cells 0-2 from data.ipynb to viz.ipynb
copy_cells(source_path="data.ipynb", dest_path="viz.ipynb", start_index=0, end_index=2)

# Move cells (copy + delete source)
copy_cells(source_path="data.ipynb", dest_path="viz.ipynb", cell_ids=["a3f8c2d1"], delete_source=true)

# Reorder cells within the same notebook
copy_cells(source_path="nb.ipynb", dest_path="nb.ipynb", cell_ids=["a3f8c2d1"], dest_index=0, delete_source=true)
```

**Notes:**
- Returns new cell IDs for destination cells
- For single cell, use same value for `start_index` and `end_index`
- Use `delete_source=true` instead of the old `move_cells` tool

---

## replace_in_notebook

Search and replace text across notebook cells. Useful for refactoring.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `search` | string | Yes | — | Text or pattern to search for |
| `replace` | string | Yes | — | Replacement text |
| `cell_type` | `"code"` \| `"markdown"` \| `"all"` | No | `"code"` | Cell types to search |
| `case_sensitive` | boolean | No | `false` | Case-sensitive search |
| `regex` | boolean | No | `false` | Treat search as regex |
| `indices` | number[] | No | all | Only replace in these cell indices |
| `dry_run` | boolean | No | `false` | Preview without making changes |

**Example:**
```
# Preview a rename
replace_in_notebook(path="nb.ipynb", search="old_name", replace="new_name", dry_run=true)
```

**Notes:**
- For scope-aware Python renames, use [`rename_symbol`](../kernel/#rename_symbol) instead

---

**Next:** [Executing code →](../execution/)
