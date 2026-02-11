---
title: Multi-Agent Collaboration
description: Patterns for running multiple Claude Code agents on the same notebook.
---

This MCP server was designed to support multiple AI agents working on the same notebook simultaneously. This guide covers the key features and patterns for safe multi-agent workflows.

## Core concepts

### Cell IDs over indices

Always use `cell_id` instead of positional `index` for multi-agent work. When one agent inserts a cell, all subsequent indices shift — but cell IDs stay stable.

```
# Fragile — breaks if another agent inserts above
update_cell(path="nb.ipynb", index=5, source="...")

# Robust — survives concurrent inserts
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="...")
```

### client_name attribution

Pass `client_name` on all write operations to track which agent made each change:

```
insert_cell(path="nb.ipynb", source="...", client_name="etl-agent")
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="...", client_name="viz-agent")
```

This shows up in change tracking history (`get_cell_history`, `get_notebook_changes`).

### Advisory locking

Agents should lock cells they're actively working on:

```
# Claim cells before modifying
lock_cells(path="nb.ipynb", cell_ids=["a3f8c2d1"], owner="etl-agent", ttl_minutes=10)

# Do work...
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="...", client_name="etl-agent")

# Release when done
unlock_cells(path="nb.ipynb", cell_ids=["a3f8c2d1"], owner="etl-agent")
```

Lock owners can modify their own locked cells without `force=true`. Other agents see a warning and must use `force=true` to override.

### Snapshots as safety nets

Take snapshots before risky multi-agent operations:

```
snapshot_notebook(path="nb.ipynb", name="before-parallel-work")

# ... multiple agents work ...

# If something goes wrong:
restore_snapshot(path="nb.ipynb", name="before-parallel-work")
```

## Typical workflow

### 1. Setup phase

Each agent connects and claims its section of the notebook:

```
# Agent 1: Data loading
lock_cells(path="nb.ipynb", cell_ids=["cell1", "cell2"], owner="data-agent")

# Agent 2: Visualization
lock_cells(path="nb.ipynb", cell_ids=["cell5", "cell6"], owner="viz-agent")
```

### 2. Work phase

Agents work in parallel on their locked cells:

```
# data-agent updates its cells
update_cell(path="nb.ipynb", cell_id="cell1", source="...", client_name="data-agent")

# viz-agent updates its cells
update_cell(path="nb.ipynb", cell_id="cell5", source="...", client_name="viz-agent")
```

### 3. Integration phase

Agents can copy cells between notebooks or within sections:

```
# Copy data processing cells to the visualization notebook
copy_cells(
  source_path="data.ipynb",
  dest_path="viz.ipynb",
  cell_ids=["cell1", "cell2"],
  client_name="data-agent"
)
```

### 4. Validation phase

Check the change log and verify all modifications:

```
# See all changes since work began
get_notebook_changes(path="nb.ipynb", since_version=0)

# Compare against the snapshot
diff_snapshot(path="nb.ipynb", name="before-parallel-work")
```

## Polling for changes

Agents can poll for changes made by other agents:

```
# Initial call
result = get_notebook_changes(path="nb.ipynb", since_version=0)
# → current_version: 15

# Later: check what changed
result = get_notebook_changes(path="nb.ipynb", since_version=15)
# → shows changes by other agents since version 15
```

## Recovery

If an agent accidentally deletes a cell, recover it from change history:

```
recover_cell(path="nb.ipynb", cell_id="deleted-cell-id", client_name="recovery-agent")
```

This re-inserts the cell with its last known content.

## Cross-notebook operations

Agents can work across multiple notebooks:

- **copy_cells** — copy cells between notebooks (originals stay in source)
- **move_cells** — move cells between notebooks (removed from source)

Both support `cell_ids` for robust addressing and track changes in both source and destination notebooks.

## Best practices

1. **Always use `cell_id`** — never rely on positional indices in multi-agent scenarios
2. **Always pass `client_name`** — enables audit trails and lock owner matching
3. **Lock before modifying** — prevents accidental overwrites between agents
4. **Snapshot before risky operations** — provides rollback safety
5. **Use `get_notebook_changes` for coordination** — poll to see what other agents have done
6. **Prefer `batch_update_cells`** — atomic multi-cell updates reduce race windows
