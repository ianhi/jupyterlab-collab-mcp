---
title: Tool Overview
description: All 39 MCP tools organized by category.
---

The MCP server provides 39 tools for working with Jupyter notebooks. Tools are organized into categories below — click through for full parameter documentation and examples.

## Categories

### [Connection](./connection/)
Connect to JupyterLab, discover files and notebooks, open and create notebooks.

### [Reading](./reading/)
Read notebook content with filtering, get outlines, search/grep, fetch outputs.

### [Editing](./editing/)
Insert, update, delete, copy cells. Batch operations and search-replace.

### [Execution](./execution/)
Execute cells and code (single or range), filter output, clear outputs.

### [Collaboration](./collaboration/)
Cell IDs, human-focus protection, advisory locking, change tracking, snapshots.

### [Metadata & Tags](./metadata/)
Read and write cell/notebook metadata, manage and find tags.

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
| `insert_cell` | Editing | Insert a cell (optionally execute with `execute=true`) |
| `update_cell` | Editing | Update cell source (optionally execute with `execute=true`) |
| `batch_update_cells` | Editing | Update multiple cells atomically |
| `batch_insert_cells` | Editing | Insert multiple cells at once |
| `delete_cell` | Editing | Delete one or more cells (supports `indices`, `cell_ids`, ranges) |
| `change_cell_type` | Editing | Convert code ↔ markdown |
| `copy_cells` | Editing | Copy/move cells within/between notebooks (`delete_source=true` to move) |
| `replace_in_notebook` | Editing | Search and replace across cells |
| `execute_cell` | Execution | Run one or more cells (single, range via `end_index`, or `cell_ids`) |
| `execute_code` | Execution | Run code without modifying notebook |
| `filter_output` | Execution | Post-process cached execution output (grep, tail, head, max_lines) |
| `clear_outputs` | Execution | Clear cell outputs |
| `get_user_focus` | Collaboration | See user's current cell |
| `cell_locks` | Collaboration | Acquire, release, or list advisory cell locks |
| `get_cell_history` | Collaboration | View cell change log |
| `get_notebook_changes` | Collaboration | Poll for changes |
| `recover_cell` | Collaboration | Re-insert deleted cell |
| `snapshot` | Collaboration | Save, restore, list, or diff named checkpoints |
| `cell_metadata` | Metadata | Get or set cell metadata |
| `cell_tags` | Metadata | Add, remove, or find cell tags |
| `notebook_metadata` | Metadata | Get or set notebook metadata |
| `kernel` | Kernel | Check status, interrupt, or restart kernel |
| `kernel_variables` | Kernel | List or inspect kernel variables |
| `get_diagnostics` | Kernel | Get errors/warnings |
| `get_hover_info` | Kernel | Get docs/type info |
| `rename_symbol` | Kernel | Scope-aware rename |
| `rename_notebook` | Kernel | Rename notebook file |
| `diff_notebooks` | Kernel | Compare two notebooks |
| `report_issue` | Feedback | Submit a feedback report |
