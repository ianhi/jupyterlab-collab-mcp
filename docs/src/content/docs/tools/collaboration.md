---
title: Collaboration Tools
description: Cell IDs, human-focus protection, locking, change tracking, and snapshots.
---

Tools and features for safe collaboration between humans and AI agents on the same notebook.

## Cell ID addressing

Every cell has a stable UUID. Tools show truncated 8-character IDs alongside positional indices. You can use `cell_id` instead of `index` on most tools:

```
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="new code")
```

Cell IDs are **prefix-matched** — use enough characters to be unambiguous. IDs stay stable across insertions and deletions, unlike positional indices.

**Tools with `cell_id`:** `update_cell`, `delete_cell`, `execute_cell`, `change_cell_type`, `insert_cell` (after), `clear_outputs`, `filter_output`, `get_diagnostics`.

**Tools with `cell_ids` array:** `get_notebook_content`, `get_cell_outputs`, `cell_metadata`, `cell_tags`, `delete_cell`, `copy_cells`, `execute_cell`, `cell_locks`.

## Human-focus protection

Write tools check the JupyterLab awareness protocol before modifying cells. If a human is editing the target cell, the operation is blocked:

```
Cannot modify cell 5 (a3f8c2d1) — user "Ian" is currently editing it.
Use force=true to override.
```

Applied to: `update_cell`, `delete_cell`, `change_cell_type`, `clear_outputs`.

---

## Cell locking

### cell_locks

Manage advisory cell locks. Use `action` to acquire, release, or list locks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `"acquire"` \| `"release"` \| `"list"` | Yes | — | Lock operation |
| `path` | string | Yes | — | Notebook path |
| `cell_ids` | string[] | No | — | Cell IDs to lock/unlock (required for acquire/release) |
| `owner` | string | No | `"claude-code"` | Who is claiming (e.g., agent name) |
| `ttl_minutes` | number | No | `10` | Lock duration in minutes (acquire only) |
| `force` | boolean | No | `false` | Force unlock regardless of owner (release only) |

**Examples:**
```
# Acquire locks
cell_locks(action="acquire", path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"], owner="data-agent", ttl_minutes=15)

# Release locks
cell_locks(action="release", path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"], owner="data-agent")

# List all locks
cell_locks(action="list", path="nb.ipynb")
```

**Notes:**
- Calling acquire again with the same owner renews the TTL
- Other agents see a warning when trying to modify locked cells
- The lock owner can modify their own locked cells without `force=true`
- List returns who holds each lock and when it expires

---

## Change tracking

All cell modifications are tracked in-memory with version numbers, timestamps, and client attribution.

### get_cell_history

Get the change history for a specific cell.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `cell_id` | string | Yes | — | Cell ID (prefix match) |
| `limit` | number | No | `20` | Maximum entries to return |

**Example:**
```
get_cell_history(path="nb.ipynb", cell_id="a3f8c2d1")
```

Shows who changed it, when, and what the old/new content was.

### get_notebook_changes

Get all changes since a given version number. Use for polling-based change detection.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `since_version` | number | No | — | Return changes after this version (use 0 for all) |
| `limit` | number | No | `50` | Maximum changes to return |

**Polling pattern:**
```
# Initial call — get current version
get_notebook_changes(path="nb.ipynb", since_version=0)
# → returns current_version: 15

# Subsequent calls — only new changes
get_notebook_changes(path="nb.ipynb", since_version=15)
```

### recover_cell

Re-insert a deleted cell from change history.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `cell_id` | string | Yes | — | Cell ID of the deleted cell (prefix match) |
| `index` | number | No | end | Position to re-insert |
| `client_name` | string | No | `"claude-code"` | Agent name for attribution |

**Notes:**
- Only works for cells deleted during the current session
- Change tracking is in-memory (cleared on server restart)

---

## Snapshots

Named checkpoints for save/restore workflows. Work in both Jupyter and filesystem modes.

### snapshot

Manage named snapshots. Use `action` to save, restore, list, or diff.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `action` | `"save"` \| `"restore"` \| `"list"` \| `"diff"` | Yes | — | Snapshot operation |
| `path` | string | Yes | — | Notebook path |
| `name` | string | No | — | Snapshot name (required for save/restore/diff) |
| `description` | string | No | — | Optional description (save only) |

**Examples:**
```
# Save a snapshot
snapshot(action="save", path="nb.ipynb", name="before-refactor", description="Pre-refactor state")

# List all snapshots
snapshot(action="list", path="nb.ipynb")

# Compare snapshot against current state
snapshot(action="diff", path="nb.ipynb", name="before-refactor")

# Restore to a snapshot
snapshot(action="restore", path="nb.ipynb", name="before-refactor")
```

**Notes:**
- **restore** replaces ALL cells with the snapshot's cells. Outputs are cleared. Automatically saves a `pre-restore` snapshot first for safety.
- **diff** shows which cells were added, deleted, modified, or unchanged. Modified cells include inline content diffs.
- Snapshots are in-memory (session-scoped, cleared on server restart)

---

## Issue reporting

### report_issue

Submit a feedback report about a tool bug, hang, missing feature, or general observation. Reports are persisted to a JSONL file (`~/.jupyter-mcp-reports.jsonl`) for developer review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `category` | string | Yes | One of: `tool_bug`, `hang`, `missing_feature`, `observation`, `user_feedback` |
| `summary` | string | Yes | One-line description |
| `tool_name` | string | No | Which MCP tool was involved |
| `path` | string | No | Notebook path |
| `details` | string | No | Error messages or reproduction steps |

**Notes:**
- All inputs are defensively coerced to strings and truncated (summary: 500 chars, details: 2000 chars) to keep writes atomic
- The reports file is automatically rotated when it exceeds 1MB
- Safe for concurrent writes from multiple agents (uses `O_APPEND`)

---

**See also:** [Metadata & tags](../metadata/), [Kernel & analysis tools](../kernel/)
