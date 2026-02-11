---
title: Multi-Agent Workflows
description: Patterns for multiple AI agents working on the same notebook simultaneously.
---

This page covers coordination patterns when multiple agents work on the same notebook. For single-agent best practices, see [Best Practices](/agents/best-practices/).

## Typical workflow

### 1. Setup phase

Take a snapshot and have each agent claim its section:

```
snapshot_notebook(path="nb.ipynb", name="before-parallel-work")

# Agent 1: Data loading
lock_cells(path="nb.ipynb", cell_ids=["cell1", "cell2"], owner="data-agent")

# Agent 2: Visualization
lock_cells(path="nb.ipynb", cell_ids=["cell5", "cell6"], owner="viz-agent")
```

### 2. Work phase

Agents work in parallel on their locked cells. Each passes its `client_name`:

```
# data-agent works on its cells
update_cell(path="nb.ipynb", cell_id="cell1", source="...", client_name="data-agent")

# viz-agent works on its cells
update_cell(path="nb.ipynb", cell_id="cell5", source="...", client_name="viz-agent")
```

New cells can be inserted anywhere — cell IDs prevent index collisions even with concurrent inserts.

### 3. Integration phase

Agents can share work across notebooks:

```
copy_cells(
  source_path="data.ipynb",
  dest_path="viz.ipynb",
  cell_ids=["cell1", "cell2"],
  client_name="data-agent"
)
```

Both `copy_cells` and `move_cells` track changes in source and destination notebooks.

### 4. Validation phase

Check the change log and compare against the snapshot:

```
get_notebook_changes(path="nb.ipynb", since_version=0)
diff_snapshot(path="nb.ipynb", name="before-parallel-work")
```

## Polling for coordination

Agents can monitor each other's progress without direct communication:

```
# Initial call — get current version number
result = get_notebook_changes(path="nb.ipynb", since_version=0)
# → current_version: 15

# Later — see what's new since version 15
result = get_notebook_changes(path="nb.ipynb", since_version=15)
# → shows changes by other agents
```

This is useful for agents that need to wait for another agent's output before proceeding.

## Cross-notebook operations

Agents can work across multiple notebooks:

- **`copy_cells`** — duplicate cells between notebooks (originals stay in source)
- **`move_cells`** — transfer cells between notebooks (removed from source)

Both support `cell_ids` for robust addressing and `dest_cell_id` for precise placement.

## Conflict resolution

When two agents try to modify the same cell:

1. **With locking** — the second agent gets a warning and must use `force=true` to override. The override is recorded in the audit trail.
2. **Without locking** — the last write wins (CRDT semantics). Use `get_cell_history` to see what happened and `recover_cell` if needed.

Prefer locking. It's the safest pattern for multi-agent work.

## Recovery

If something goes wrong:

- **Deleted cell** — `recover_cell(path, cell_id="...", client_name="...")` re-inserts it from change history
- **Bad edit** — `restore_snapshot(path, name="before-parallel-work")` rolls back the entire notebook (auto-saves a backup first)
- **Need to investigate** — `get_cell_history(path, cell_id="...")` shows the full change log for any cell
