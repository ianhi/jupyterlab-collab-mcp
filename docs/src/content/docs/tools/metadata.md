---
title: Metadata & Tags
description: Read and write cell/notebook metadata and manage cell tags.
---

Tools for managing cell and notebook metadata. All cell-level tools support ranges (`index`/`end_index`), non-contiguous selection (`indices`), and cell ID selection (`cell_ids`).

## cell_metadata

Get or set cell metadata. Omit `metadata` to read; provide `metadata` to write (merges with existing).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `metadata` | object | No | — | Metadata to set/merge. Omit to read. Use `null` values to delete keys |
| `index` | number | No | — | Cell index (start of range if `end_index` set) |
| `end_index` | number | No | — | Last cell index (inclusive) |
| `indices` | number[] | No | — | Specific cell indices |
| `cell_ids` | string[] | No | — | Cell IDs (alternative to indices) |

**Examples:**
```
# Read metadata from specific cells
cell_metadata(path="nb.ipynb", indices=[0, 5, 10])

# Set metadata on specific cells
cell_metadata(path="nb.ipynb", indices=[2, 4], metadata={"editable": false})

# Delete a metadata key
cell_metadata(path="nb.ipynb", index=0, metadata={"old_key": null})
```

**Notes:**
- When reading, returns `{index, metadata, tags}` with tags extracted to top level

---

## cell_tags

Add, remove, or find tags on cells.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `"add"` \| `"remove"` \| `"find"` | Yes | — | Tag operation |
| `path` | string | Yes | — | Notebook path |
| `tags` | string[] | Yes | — | Tags to add, remove, or search for |
| `index` | number | No | — | Cell index |
| `end_index` | number | No | — | Last cell index (inclusive) |
| `indices` | number[] | No | — | Specific cell indices |
| `cell_ids` | string[] | No | — | Cell IDs |
| `match_all` | boolean | No | `false` | Require ALL tags when `action="find"` (default: match any) |
| `include_preview` | boolean | No | `false` | Include first line of source when `action="find"` |

**Common tags:** `hide-input`, `hide-output`, `remove-input`, `remove-output`, `remove-cell`, `skip-execution`, `parameters` (papermill).

**Examples:**
```
# Add tags to multiple non-contiguous cells
cell_tags(action="add", path="nb.ipynb", indices=[2, 4, 6, 8], tags=["hide-input"])

# Remove tags
cell_tags(action="remove", path="nb.ipynb", cell_ids=["a3f8c2d1"], tags=["hide-input"])

# Find cells with specific tags
cell_tags(action="find", path="nb.ipynb", tags=["parameters"], include_preview=true)

# Find cells that have ALL specified tags
cell_tags(action="find", path="nb.ipynb", tags=["parameters", "hide-input"], match_all=true)
```

---

## notebook_metadata

Get or set notebook-level metadata (kernelspec, language_info, custom fields). Omit `metadata` to read; provide `metadata` to write (merges with existing).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |
| `metadata` | object | No | Metadata to set/merge. Omit to read |

**Examples:**
```
# Read notebook metadata
notebook_metadata(path="nb.ipynb")

# Set notebook metadata
notebook_metadata(path="nb.ipynb", metadata={"custom_field": "value"})
```
