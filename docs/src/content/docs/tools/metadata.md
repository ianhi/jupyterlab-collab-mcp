---
title: Metadata & Tags
description: Read and write cell/notebook metadata and manage cell tags.
---

Tools for managing cell and notebook metadata. All cell-level tools support ranges (`index`/`end_index`), non-contiguous selection (`indices`), and cell ID selection (`cell_ids`).

## get_cell_metadata

Get metadata from one or more cells. Returns `{index, metadata, tags}` with tags extracted to top level.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `index` | number | No | — | Cell index (start of range if `end_index` set) |
| `end_index` | number | No | — | Last cell index (inclusive) |
| `indices` | number[] | No | — | Specific cell indices |
| `cell_ids` | string[] | No | — | Cell IDs (alternative to indices) |

**Example:**
```
get_cell_metadata(path="nb.ipynb", indices=[0, 5, 10])
```

---

## set_cell_metadata

Set metadata on one or more cells. Merges with existing metadata (use `null` values to delete keys).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `metadata` | object | Yes | — | Metadata to set/merge |
| `index` | number | No | — | Cell index |
| `end_index` | number | No | — | Last cell index (inclusive) |
| `indices` | number[] | No | — | Specific cell indices |
| `cell_ids` | string[] | No | — | Cell IDs |

**Example:**
```
# Set metadata on specific cells
set_cell_metadata(path="nb.ipynb", indices=[2, 4], metadata={"editable": false})

# Delete a metadata key
set_cell_metadata(path="nb.ipynb", index=0, metadata={"old_key": null})
```

---

## add_cell_tags

Add tags to one or more cells.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `tags` | string[] | Yes | — | Tags to add |
| `index` | number | No | — | Cell index |
| `end_index` | number | No | — | Last cell index (inclusive) |
| `indices` | number[] | No | — | Specific cell indices |
| `cell_ids` | string[] | No | — | Cell IDs |

**Common tags:** `hide-input`, `hide-output`, `remove-input`, `remove-output`, `remove-cell`, `skip-execution`, `parameters` (papermill).

**Example:**
```
# Hide input on multiple non-contiguous cells
add_cell_tags(path="nb.ipynb", indices=[2, 4, 6, 8], tags=["hide-input"])
```

---

## remove_cell_tags

Remove tags from one or more cells.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `tags` | string[] | Yes | — | Tags to remove |
| `index` | number | No | — | Cell index |
| `end_index` | number | No | — | Last cell index (inclusive) |
| `indices` | number[] | No | — | Specific cell indices |
| `cell_ids` | string[] | No | — | Cell IDs |

---

## find_cells_by_tag

Find cells that have specific tags.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `tags` | string[] | Yes | — | Tags to search for |
| `match_all` | boolean | No | `false` | Require ALL tags (default: match any) |
| `include_preview` | boolean | No | `false` | Include first line of source |

**Example:**
```
find_cells_by_tag(path="nb.ipynb", tags=["parameters"], include_preview=true)
```

---

## get_notebook_metadata

Get notebook-level metadata (kernelspec, language_info, custom fields).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |

---

## set_notebook_metadata

Set notebook-level metadata. Merges with existing metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |
| `metadata` | object | Yes | Metadata to set/merge |
