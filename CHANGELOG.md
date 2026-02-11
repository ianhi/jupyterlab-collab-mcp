# Changelog

All notable changes to the JupyterLab Claude Code MCP server.

## [Unreleased]

### Added
- **Refactored index.ts** into modular handler files under `src/handlers/` for maintainability

## [0.5.0] - 2025-02-11

### Added
- `client_name` parameter on write tools (`insert_cell`, `update_cell`, `delete_cell`, `insert_and_execute`, `update_and_execute`) for per-agent attribution in change tracking and lock owner matching
- Lock override audit trail — force-overriding a lock now records the override in change tracking
- Inline content diffs in `diff_snapshot` — modified cells show line count changes and first 6 diff lines
- `copy_cells` response now includes new cell IDs for destination cells
- Missing `recordChange` call added to `insert_and_execute`
- Missing `recordChange` and lock check added to `update_and_execute`

### Changed
- `checkLock` now uses `client_name` for owner matching — lock owners can modify their own locked cells without `force=true`

## [0.4.0] - 2025-02-10

### Added
- **Cell locking** — advisory locks with auto-expiry (default 5 minutes)
  - `lock_cells` — acquire locks on cells with owner name and TTL
  - `unlock_cells` — release locks (owner must match)
  - `list_locks` — list active locks with expiry countdown
  - Lock checks wired into `update_cell` and `delete_cell` (respects `force=true`)
- **Named snapshots** — save and restore notebook checkpoints
  - `snapshot_notebook` — save a named checkpoint
  - `restore_snapshot` — restore to a checkpoint (auto-saves pre-restore backup)
  - `list_snapshots` — list all checkpoints for a notebook
  - `diff_snapshot` — compare checkpoint vs current state
- **Change tracking** — per-notebook modification history with version numbers
  - `get_cell_history` — view change log for a specific cell
  - `get_notebook_changes` — poll for changes since a version number
  - `recover_cell` — re-insert a deleted cell from change history
- `cell_ids` parameter added to `execute_range`, `copy_cells`, `move_cells` for stable addressing
- `dest_cell_id` parameter added to `copy_cells`, `move_cells` for position by cell ID
- Client attribution on all change tracking calls

## [0.3.0] - 2025-02-09

### Added
- **Scope-aware rename** via `rename_symbol` using jedi
- **Notebook diffing** via `diff_notebooks` — compare two notebooks cell by cell
- **LSP integration** — `get_diagnostics` and `get_hover_info` via jupyterlab-lsp
- **Search & replace** via `replace_in_notebook` with regex support and dry-run mode
- **Batch operations** — `batch_update_cells` for atomic multi-cell updates
- `find_cells_by_tag` for locating tagged cells
- `get_notebook_outline` for condensed notebook structure

## [0.2.0] - 2025-02-08

### Added
- **Cell ID addressing** — stable 8-char truncated UUIDs for all cell operations
  - `cell_id` parameter on single-cell tools (update, delete, execute, etc.)
  - `cell_ids` array on multi-cell tools (get_notebook_content, metadata, tags, etc.)
  - Prefix matching for convenience
- **Human-focus protection** — write tools check awareness protocol before modifying cells
- **Image output control** — `max_images` and `include_images` parameters on execute tools
- **Non-contiguous cell operations** — `indices` array on metadata/tag tools
- **Context-efficient reading** — `cell_type`, `output_format`, `indices`, `cell_ids` filters on `get_notebook_content`
- `insert_and_execute` and `update_and_execute` combo tools
- `execute_range` for running multiple cells in sequence
- `get_cell_outputs` for reading outputs without source
- `get_kernel_variables` for inspecting kernel state
- `copy_cells` and `move_cells` for cross-notebook operations

## [0.1.0] - 2025-02-07

### Added
- Initial MCP server with JupyterLab real-time collaboration via y-websocket
- Dual mode: Jupyter (real-time sync) and filesystem (direct .ipynb read/write)
- Core notebook tools: `connect_jupyter`, `list_notebooks`, `list_files`, `open_notebook`, `create_notebook`
- Cell operations: `insert_cell`, `update_cell`, `delete_cell`, `change_cell_type`
- Execution: `execute_cell`, `execute_code`
- Metadata: `get_cell_metadata`, `set_cell_metadata`, `add_cell_tags`, `remove_cell_tags`
- Kernel management: `get_kernel_status`, `interrupt_kernel`, `restart_kernel`
- Collaboration: `get_user_focus` awareness protocol
- Notebook management: `rename_notebook`, `clear_outputs`
