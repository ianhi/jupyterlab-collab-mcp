---
title: Editing Tools
description: Insert, update, delete, copy, move cells, and search-replace.
---

Tools for modifying notebook cells. All editing tools support [cell ID addressing](/tools/collaboration/#cell-id-addressing) and sync changes in real-time to the JupyterLab browser.

## insert_cell

Insert a new cell into the notebook.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `source` | string | Yes | — | Cell source code |
| `index` | number | No | end | Position to insert (0 = beginning, -1 = end) |
| `cell_id` | string | No | — | Insert after this cell ID (alternative to index) |
| `cell_type` | `"code"` \| `"markdown"` | No | `"code"` | Cell type |
| `client_name` | string | No | `"claude-code"` | Agent name for change attribution |

**Example:**
```
insert_cell(path="nb.ipynb", source="import pandas as pd", index=0)
```

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
| `client_name` | string | No | `"claude-code"` | Agent name for attribution and lock matching |

**Example:**
```
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="print('updated')")
```

**Notes:**
- Only modifies source, not metadata/tags (use `add_cell_tags`/`set_cell_metadata` for those)
- Use `clear_outputs` to remove outputs
- Checks [human-focus protection](/tools/collaboration/#human-focus-protection) and [cell locks](/tools/collaboration/#cell-locking)

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

---

## delete_cell

Delete a cell from the notebook.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `index` | number | No | — | Cell index to delete |
| `cell_id` | string | No | — | Cell ID to delete (alternative to index) |
| `force` | boolean | No | `false` | Force delete even if human is editing |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution |

**Notes:**
- Deleted cells can be recovered with [`recover_cell`](/tools/collaboration/#recover_cell)

---

## delete_cells

Delete multiple cells at once.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `start_index` | number | No | — | First cell index (inclusive) |
| `end_index` | number | No | — | Last cell index (inclusive) |
| `indices` | number[] | No | — | Specific indices (overrides start/end) |
| `cell_ids` | string[] | No | — | Cell IDs to delete (alternative to indices) |

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

Copy cells from one notebook to another (or within the same notebook).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source_path` | string | Yes | — | Source notebook path |
| `dest_path` | string | Yes | — | Destination notebook path |
| `start_index` | number | No | — | First cell index to copy (inclusive) |
| `end_index` | number | No | — | Last cell index to copy (inclusive) |
| `cell_ids` | string[] | No | — | Cell IDs to copy (more robust in concurrent editing) |
| `dest_index` | number | No | end | Position in destination |
| `dest_cell_id` | string | No | — | Insert after this cell ID in destination |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution |

**Example:**
```
# Copy cells 0-2 from data.ipynb to viz.ipynb
copy_cells(source_path="data.ipynb", dest_path="viz.ipynb", start_index=0, end_index=2)
```

**Notes:**
- Returns new cell IDs for destination cells
- For single cell, use same value for `start_index` and `end_index`

---

## move_cells

Move cells within a notebook (reorder) or between notebooks (removes from source).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source_path` | string | Yes | — | Source notebook path |
| `dest_path` | string | Yes | — | Destination (can be same as source) |
| `start_index` | number | No | — | First cell index to move |
| `end_index` | number | No | — | Last cell index to move |
| `cell_ids` | string[] | No | — | Cell IDs to move |
| `dest_index` | number | No | — | Position in destination |
| `dest_cell_id` | string | No | — | Insert after this cell ID |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution |

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
- For scope-aware Python renames, use [`rename_symbol`](/tools/kernel/#rename_symbol) instead

---

**Next:** [Executing code →](/tools/execution/)
