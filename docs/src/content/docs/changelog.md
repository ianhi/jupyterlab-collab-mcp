---
title: Changelog
description: Version history for jupyterlab-collab-mcp.
---

All notable changes to the jupyterlab-collab-mcp.

## [0.12.0] - 2026-07-06

### Added
- **`notebook_guide` tool** — on-demand best-practices guide (reading, editing, executing, collaborating, troubleshooting) delivered as tool output, with an optional `topic` parameter for a single section. The server now points agents to it on startup.

### Changed
- **`report_issue` now returns a structured GitHub-issue draft** for `ianhi/jupyterlab-collab-mcp` (title + sectioned body) alongside the local log, and notes that the project accepts fully agent-drafted issues. It doesn't prescribe how the issue gets filed.

## [0.11.0] - 2026-07-06

### Fixed
- **Kernel cold-start execution race** — the first `execute_request` could be sent before the kernel's ZMQ channels were subscribed and get silently dropped, hanging the run until timeout. The client now completes a `kernel_info` readiness handshake (re-probed until the kernel replies) before dispatching any run.
- **Outline misread `#` comments inside fenced code blocks** — `get_notebook_outline` treated `#` lines inside ` ``` ` / `~~~` code fences as markdown headers. Fenced blocks are now tracked and skipped.

### Changed
- **`batch_insert_cells` index semantics** *(breaking)* — each `index` is now the literal position in the notebook as it stands at that step, applied in list order. Passing increasing indices for a contiguous block previously interleaved the new cells with existing ones; now they land contiguously. For a block, pass increasing indices or anchor with `cell_id`.

## [0.10.1] - 2026-06-17

### Fixed
- **Accurate error when `jupyter-collaboration` is missing** — cell-indexed tools (`get_notebook_content`, `execute_cell`, `insert_cell`, …) require the `jupyter-collaboration` server extension. On servers without it they previously reported a misleading "Notebook not found"; now `connect_jupyter` warns up front and the cell tools fail with an actionable "install jupyter-collaboration" message that distinguishes a missing extension from a genuinely missing notebook. Kernel tools (`execute_code`) are unaffected.

## [Unreleased]

### Changed
- **Consolidated 55 tools down to 39** — reduced schema token overhead by merging related tools:
  - `insert_and_execute`/`update_and_execute` → `insert_cell(execute=true)`/`update_cell(execute=true)`
  - `delete_cells` → `delete_cell` (now accepts `indices`, `cell_ids`, `start_index`/`end_index`)
  - `move_cells` → `copy_cells(delete_source=true)`
  - `get/set_cell_metadata` → `cell_metadata`, `get/set_notebook_metadata` → `notebook_metadata`
  - `add/remove_cell_tags` → `cell_tags(action="add"/"remove")`
  - `find_cells_by_tag` → `cell_tags(action="find")`
  - `execute_range` → `execute_cell` (use `end_index` or `cell_ids` for range execution)
  - `lock/unlock/list_locks` → `cell_locks(action="acquire"/"release"/"list")`
  - 4 snapshot tools → `snapshot(action="save"/"restore"/"list"/"diff")`
  - 3 kernel tools → `kernel(action="status"/"interrupt"/"restart")`
  - `get_kernel_variables`/`inspect_variable` → `kernel_variables`

### Added
- `filter_output` tool — post-process cached execution results with grep, head, tail
- `show_diff` parameter on `update_cell`
- Execution result caching

### Fixed
- Batch delete now records change history for `recover_cell`
- Cross-notebook `copy_cells` clarifies destination cell IDs

## [0.8.0] - 2025-02-11

### Added
- Documentation site built with Starlight/Astro
- Concise README that links to full docs

## [0.7.0] - 2025-02-11

### Added
- Change tracking for `copy_cells` and `move_cells` operations
- `batch_insert_cells` tool for inserting multiple cells in one operation
- `client_name` parameter on `recover_cell` and `batch_update_cells`

### Changed
- Default lock TTL increased from 5 minutes to 10 minutes

### Fixed
- `recover_cell` now accepts `client_name` for proper attribution (previously hardcoded to "claude-code")

## [0.6.0] - 2025-02-11

### Changed
- **Refactored index.ts** into modular handler files under `src/handlers/` (7 files, 51 tool handlers)
- index.ts reduced from ~2000 lines to a 96-line dispatcher

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
- `cell_ids` parameter added to `execute_cell`, `copy_cells`, `move_cells` for stable addressing
- `dest_cell_id` parameter added to `copy_cells`, `move_cells` for position by cell ID

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
- **Human-focus protection** — write tools check awareness protocol before modifying cells
- **Image output control** — `max_images` and `include_images` parameters on execute tools
- **Non-contiguous cell operations** — `indices` array on metadata/tag tools
- **Context-efficient reading** — `cell_type`, `output_format`, `indices`, `cell_ids` filters
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
