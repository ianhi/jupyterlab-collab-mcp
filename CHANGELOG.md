# Changelog

All notable changes to the jupyterlab-collab-mcp.

## [Unreleased]

## [0.13.0] - 2026-07-07

### Added
- **Durable handed-off run outputs** — a run handed off via `handoff_after_ms` returned a `run_id` whose output lived only in an in-memory buffer that could be evicted (by a 5-min idle sweep, a 30-min TTL, a 100-run cap, or a dropped socket) before `get_cell_run_output` fetched it, causing silent "No run found" losses. Output is now durable across three layers: a hardened in-memory buffer, a bounded host-side disk cache (`run-store.ts`), and an in-kernel-memory capture harness (`kernel-capture.ts`) that survives a mid-run disconnect/host sleep and is recovered via a fresh execute after reconnect. (#15)
- **`list_runs` tool** — enumerate recent kernel runs and their states (queued/running/handed_off/completed/failed) so callers can discover a `run_id` or tell "still running" from "evicted" instead of blindly holding an id. (#15)

### Changed
- **In-flight runs are never idle-evicted** — the idle sweep now skips any kernel with a queued/running/handed-off run, so a live computation is no longer closed and marked failed. (#15)
- **Higher, configurable run retention** — defaults raised (100→500 runs, 30→120 min) and made overridable via env (`JUPYTER_MCP_MAX_RETAINED_RUNS`, `JUPYTER_MCP_RUN_TTL_MS`, `JUPYTER_MCP_IDLE_EVICTION_MS`, plus `JUPYTER_MCP_RUN_STORE_*` and `JUPYTER_MCP_KERNEL_CAPTURE_*`; kernel-side capture can be disabled with `JUPYTER_MCP_DISABLE_KERNEL_CAPTURE`). (#15)
- **Clearer run messages** — the handoff response states the real retention window, and `get_cell_run_output` distinguishes "still running" from "evicted/gone" instead of a blanket "No run found". (#15)
- **Guidance steers toward cells** — `notebook_guide` and the `execute_code`/`insert_cell` tool descriptions now make `insert_cell(execute=true)` the default (one call; code and output saved in the notebook) and reserve `execute_code` for throwaway probes. (#15)

## [0.12.0] - 2026-07-06

### Added
- **`notebook_guide` tool** — on-demand best-practices guide for working with notebooks through this server (reading, editing, executing, collaborating, troubleshooting). MCP servers can't register Claude Code skills over the protocol, so this delivers the same guidance as a tool whose output lands in the agent's context. Optional `topic` parameter returns just one section. The server `instructions` field now points agents to it.

### Changed
- **`report_issue` now returns a structured GitHub-issue draft** — in addition to logging locally, it builds a ready-to-adapt issue (title + sectioned body for repro / expected / actual / context) for `ianhi/jupyterlab-collab-mcp` and states that the project accepts fully agent-drafted issues. It does not prescribe how or whether the issue is filed. Added a `bugs` URL to `package.json`.

## [0.11.0] - 2026-07-06

### Fixed
- **Kernel cold-start execution race** — `KernelClient` sent the first `execute_request` as soon as its WebSocket opened, before the kernel's ZMQ channels were subscribed, so on a cold start the request could be silently dropped and the run hung until its timeout (needing a manual kernel restart to recover). The client now completes a `kernel_info` readiness handshake — re-probed every 500ms until the kernel replies — before dispatching any run, so nothing is sent into the dead window. (#13)
- **Outline misread `#` comments inside fenced code blocks** — `get_notebook_outline` treated `#` lines inside ` ``` ` / `~~~` code fences (e.g. a `# path/to/file.py:217` comment) as markdown headers. Fenced blocks are now tracked — including the CommonMark rule that a closing fence must be at least as long as the opener — and their contents skipped. (#13)

### Changed
- **`batch_insert_cells` index semantics** *(breaking)* — each `index` is now the literal position in the notebook as it stands at that step, with inserts applied in list order (the same coordinate system `cell_id` and append already used). Previously an internal offset was added on top, so passing increasing indices for a contiguous block (e.g. `20, 21, 22`) interleaved the new cells with the existing ones. To insert a contiguous block, pass increasing indices or anchor with `cell_id`. (#14)

## [0.10.1] - 2026-06-17

### Fixed
- **Accurate error when `jupyter-collaboration` is missing** — cell-indexed tools (`get_notebook_content`, `execute_cell`, `insert_cell`, `batch_insert_cells`, …) resolve notebooks through the real-time-collaboration endpoint, which is only present when the `jupyter-collaboration` server extension is installed. On servers without it, that endpoint returns 404 for every path, which was reported as a misleading `Notebook '<path>' not found` even though the notebook existed and kernel tools worked on it. Now `connect_jupyter` probes for the extension and warns up front, and the cell tools fail with an actionable "install jupyter-collaboration" message that distinguishes a missing extension from a genuinely missing notebook. Kernel tools (`execute_code`, `kernel`) are unaffected.

## [0.10.0] - 2026-06-11

### Added
- **Long-lived kernel client** — persistent WebSocket per kernel (`KernelClient` pool) replaces per-call connections, cutting latency on repeated execution
- **Execution handoff** — `handoff_after_ms` on `execute_cell`/`execute_code`/`insert_cell`/`update_cell` returns a `run_id` when a cell runs past the threshold; retrieve results later with the new `get_cell_run_output` tool, with a channel notification pushed when a handed-off run terminates
- **Proxied JupyterLab support** — `connect_jupyter` handles `https`→`wss` and path-prefixed deployments (Coiled, JupyterHub), with cookie-jar + `X-XSRFToken` auth for state-changing requests and a `token` sent via `Authorization` header
- Warning when no browser peers are present to see our edits
- `filter_output` tool — post-process cached execution results with grep, head, tail, max_lines
- `show_diff` parameter on `update_cell` for inline diff display
- Execution result caching for `filter_output` access to full unfiltered output

### Changed
- **Consolidated 55 tools down to 39** — reduced schema token overhead by merging related tools:
  - `insert_and_execute`/`update_and_execute` → `insert_cell(execute=true)`/`update_cell(execute=true)`
  - `delete_cells` → `delete_cell` (now accepts `indices`, `cell_ids`, `start_index`/`end_index`)
  - `move_cells` → `copy_cells(delete_source=true)`
  - `get_cell_metadata`/`set_cell_metadata` → `cell_metadata` (omit `metadata` to GET, provide to SET)
  - `get_notebook_metadata`/`set_notebook_metadata` → `notebook_metadata` (same pattern)
  - `add_cell_tags`/`remove_cell_tags` → `cell_tags(action="add"/"remove")`
  - `find_cells_by_tag` → `cell_tags(action="find")`
  - `execute_range` → `execute_cell` (use `end_index` or `cell_ids` for range execution)
  - `lock_cells`/`unlock_cells`/`list_locks` → `cell_locks(action="acquire"/"release"/"list")`
  - `snapshot_notebook`/`restore_snapshot`/`list_snapshots`/`diff_snapshot` → `snapshot(action="save"/"restore"/"list"/"diff")`
  - `get_kernel_status`/`interrupt_kernel`/`restart_kernel` → `kernel(action="status"/"interrupt"/"restart")`
  - `get_kernel_variables`/`inspect_variable` → `kernel_variables` (provide `names` to inspect)
- Removed `insertCell` parameter from `execute_code` — use `insert_cell(execute=true)` instead
- Removed `max_output_lines`, `output_tail`, `output_grep` from execute tools — use `filter_output` instead

### Fixed
- Batch delete (`delete_cell` with indices/range) now records change history for `recover_cell`
- Cross-notebook `copy_cells` response clarifies that returned IDs are new destination cell IDs

## [0.8.0] - 2025-02-11

### Added
- **Multi-instance shared state via Yjs** — cell locks, change tracking, and snapshots now sync across MCP server instances connected to the same notebook
  - When connected to JupyterLab, shared state is stored in Yjs maps on the notebook document (`mcp_locks`, `mcp_changes`, `mcp_snapshots`)
  - When using filesystem mode, existing in-memory backends are used (no behavior change)
  - Instance identity: each MCP server gets a UUID, visible in JupyterLab's awareness/collaborators panel
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
