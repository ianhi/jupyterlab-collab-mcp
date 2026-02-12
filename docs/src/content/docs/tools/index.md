---
title: Tool Overview
description: All 54 MCP tools organized by category.
---

The MCP server provides 54 tools for working with Jupyter notebooks. Tools are organized into categories below — click through for full parameter documentation and examples.

## Categories

### [Connection](./connection/)
Connect to JupyterLab, discover files and notebooks, open and create notebooks.

### [Reading](./reading/)
Read notebook content with filtering, get outlines, search/grep, fetch outputs.

### [Editing](./editing/)
Insert, update, delete, copy, move cells. Batch operations and search-replace.

### [Execution](./execution/)
Execute cells and code, run ranges, combo insert+execute and update+execute, clear outputs.

### [Collaboration](./collaboration/)
Cell IDs, human-focus protection, advisory locking, change tracking, snapshots.

### [Metadata & Tags](./metadata/)
Read and write cell/notebook metadata, manage tags, find cells by tag.

### [Kernel & Analysis](./kernel/)
Kernel status, variables, interrupt/restart, diagnostics, hover info, symbol rename, diff, notebook rename.

## Quick reference

| Tool | Category | Description |
|------|----------|-------------|
| `connect_jupyter` | Connection | Connect to JupyterLab server |
| `list_files` | Connection | List files in a directory |
| `list_notebooks` | Connection | List notebooks with active kernels |
| `open_notebook` | Connection | Open notebook and start kernel |
| `create_notebook` | Connection | Create a new notebook |
| `list_kernels` | Connection | List kernel types and running instances |
| `get_notebook_content` | Reading | Get cells with filtering |
| `get_notebook_outline` | Reading | Condensed structure view |
| `search_notebook` | Reading | Grep through cells |
| `get_cell_outputs` | Reading | Get outputs without source |
| `insert_cell` | Editing | Insert a cell |
| `update_cell` | Editing | Update cell source |
| `batch_update_cells` | Editing | Update multiple cells atomically |
| `batch_insert_cells` | Editing | Insert multiple cells at once |
| `delete_cell` | Editing | Delete a cell |
| `delete_cells` | Editing | Delete multiple cells |
| `change_cell_type` | Editing | Convert code ↔ markdown |
| `copy_cells` | Editing | Copy cells within/between notebooks |
| `move_cells` | Editing | Move/reorder cells |
| `replace_in_notebook` | Editing | Search and replace across cells |
| `execute_cell` | Execution | Run a cell |
| `execute_code` | Execution | Run code without modifying notebook |
| `execute_range` | Execution | Run multiple cells in sequence |
| `insert_and_execute` | Execution | Insert + run in one operation |
| `update_and_execute` | Execution | Update + run in one operation |
| `clear_outputs` | Execution | Clear cell outputs |
| `get_user_focus` | Collaboration | See user's current cell |
| `lock_cells` | Collaboration | Acquire advisory locks |
| `unlock_cells` | Collaboration | Release locks |
| `list_locks` | Collaboration | List active locks |
| `get_cell_history` | Collaboration | View cell change log |
| `get_notebook_changes` | Collaboration | Poll for changes |
| `recover_cell` | Collaboration | Re-insert deleted cell |
| `snapshot_notebook` | Collaboration | Save named checkpoint |
| `restore_snapshot` | Collaboration | Restore to checkpoint |
| `list_snapshots` | Collaboration | List checkpoints |
| `diff_snapshot` | Collaboration | Compare checkpoint vs current |
| `get_cell_metadata` | Metadata | Get cell metadata/tags |
| `set_cell_metadata` | Metadata | Set cell metadata |
| `add_cell_tags` | Metadata | Add tags to cells |
| `remove_cell_tags` | Metadata | Remove tags from cells |
| `find_cells_by_tag` | Metadata | Find cells by tag |
| `get_notebook_metadata` | Metadata | Get notebook metadata |
| `set_notebook_metadata` | Metadata | Set notebook metadata |
| `get_kernel_status` | Kernel | Check kernel status |
| `get_kernel_variables` | Kernel | List kernel variables with detail levels |
| `inspect_variable` | Kernel | Deep-inspect variables (columns, dtypes, shapes) |
| `interrupt_kernel` | Kernel | Stop running execution |
| `restart_kernel` | Kernel | Restart kernel |
| `get_diagnostics` | Kernel | Get errors/warnings |
| `get_hover_info` | Kernel | Get docs/type info |
| `rename_symbol` | Kernel | Scope-aware rename |
| `rename_notebook` | Kernel | Rename notebook file |
| `diff_notebooks` | Kernel | Compare two notebooks |
