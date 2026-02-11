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

**Tools with `cell_id`:** `update_cell`, `delete_cell`, `execute_cell`, `change_cell_type`, `insert_cell` (after), `insert_and_execute` (after), `update_and_execute`, `clear_outputs`, `get_diagnostics`.

**Tools with `cell_ids` array:** `get_notebook_content`, `get_cell_outputs`, `get_cell_metadata`, `set_cell_metadata`, `add_cell_tags`, `remove_cell_tags`, `delete_cells`, `copy_cells`, `move_cells`, `execute_range`, `lock_cells`, `unlock_cells`.

## Human-focus protection

Write tools check the JupyterLab awareness protocol before modifying cells. If a human is editing the target cell, the operation is blocked:

```
Cannot modify cell 5 (a3f8c2d1) — user "Ian" is currently editing it.
Use force=true to override.
```

Applied to: `update_cell`, `update_and_execute`, `delete_cell`, `change_cell_type`, `clear_outputs`.

---

## Cell locking

### lock_cells

Acquire advisory locks on cells to prevent accidental overwrites by other agents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `cell_ids` | string[] | Yes | — | Cell IDs to lock (prefix match) |
| `owner` | string | No | `"claude-code"` | Who is claiming (e.g., agent name) |
| `ttl_minutes` | number | No | `10` | Lock duration in minutes |

**Example:**
```
lock_cells(path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"], owner="data-agent", ttl_minutes=15)
```

**Notes:**
- Calling again with the same owner renews the TTL
- Other agents see a warning when trying to modify locked cells
- The lock owner can modify their own locked cells without `force=true`

### unlock_cells

Release advisory locks on cells.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `cell_ids` | string[] | Yes | — | Cell IDs to unlock |
| `owner` | string | No | `"claude-code"` | Must match lock owner |
| `force` | boolean | No | `false` | Force unlock regardless of owner |

### list_locks

List all active cell locks for a notebook.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |

Returns who holds each lock and when it expires.

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

### snapshot_notebook

Save a named snapshot of the notebook's current state.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `name` | string | Yes | — | Snapshot name (e.g., `"before-refactor"`) |
| `description` | string | No | — | Optional description |

### restore_snapshot

Restore a notebook to a previously saved snapshot.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |
| `name` | string | Yes | Snapshot name to restore |

**Warning:** Replaces ALL cells with the snapshot's cells. Outputs are cleared. Automatically saves a `pre-restore` snapshot first for safety.

### list_snapshots

List all saved snapshots for a notebook.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |

### diff_snapshot

Compare a saved snapshot against the notebook's current state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |
| `name` | string | Yes | Snapshot name to compare against |

Shows which cells were added, deleted, modified, or unchanged. Modified cells include inline content diffs.

**Notes:**
- Snapshots are in-memory (session-scoped, cleared on server restart)
