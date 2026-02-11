---
title: Multi-Agent Workflows
description: Patterns for multiple AI agents working on the same notebook simultaneously.
---

This page covers coordination patterns when multiple agents work on the same notebook. For single-agent fundamentals, see [Best Practices](/agents/best-practices/).

## Coordination patterns

### Sequential pipeline

Agent A finishes a phase, Agent B polls for completion and picks up where A left off.

```
# Agent A: build the data loading cells, then signal completion
insert_cell(path="nb.ipynb", source="df = load_data()", client_name="agent-a")
# Agent A's work is done — the change is tracked automatically

# Agent B: poll until Agent A's work appears
result = get_notebook_changes(path="nb.ipynb", since_version=0)
# When Agent B sees Agent A's changes, it starts its own work
insert_cell(path="nb.ipynb", source="df.describe()", client_name="agent-b")
```

Best for: ETL → analysis → visualization pipelines where each stage depends on the previous.

### Parallel independent

Agents work on disjoint cell regions in the same notebook. Snapshots provide a safety net.

```
# Coordinator: take a snapshot, then assign regions
snapshot_notebook(path="nb.ipynb", name="before-parallel-work")

# Agent A: lock and work on the import section (cells 0-3)
lock_cells(path="nb.ipynb", cell_ids=["cell0", "cell1", "cell2", "cell3"], owner="agent-a")

# Agent B: lock and work on the visualization section (cells 8-11)
lock_cells(path="nb.ipynb", cell_ids=["cell8", "cell9", "cell10", "cell11"], owner="agent-b")

# Both agents work simultaneously — locks prevent accidental overlap
# When done, unlock and verify with diff_snapshot
```

Best for: sections of a notebook that don't depend on each other (imports, data loading, visualization, tests).

### Shared notebook

All agents write to the same notebook, using locks and change polling to coordinate between phases.

```
# Phase 1: All agents insert their cells (concurrent inserts are safe — cell IDs prevent collisions)
# Phase 2: Each agent locks its cells, edits them, then unlocks
# Phase 3: Poll for changes, review each other's work

# Between phases, agents poll to know when others are done:
result = get_notebook_changes(path="nb.ipynb", since_version=last_known_version)
```

Best for: collaborative dashboards or reports where all agents contribute to a shared document.

## Conflict resolution

### With locking (recommended)

The second agent gets a warning and must use `force=true` to override. The override is recorded in the change log with the overrider's name.

### Without locking

Edits go through the Yjs CRDT, which resolves conflicts at the character level. In practice, this means **last write wins** — if two agents update the same cell, the second write replaces the first. This can produce broken code if the writes overlap in time.

Use `get_cell_history` to see what happened and `recover_cell` to restore lost content.

**Always prefer locking.** It's the safest pattern for multi-agent work.

## Deadlock avoidance

- **Design lock regions upfront** — assign each agent a set of cell IDs before they start working
- **Keep locked regions small** — lock only the cells you're actively editing, not entire notebooks
- **Locks auto-expire** — the default TTL is 10 minutes, so stale locks from crashed agents don't block others forever
- **Renew locks if your work takes longer** — calling `lock_cells` again on cells you own resets the TTL

## Cross-notebook operations

Agents can share work across notebooks:

- **`copy_cells`** — duplicate cells between notebooks (originals stay in source). Returns new cell IDs for the destination copies.
- **`move_cells`** — transfer cells between notebooks (removed from source)

Both support `cell_ids` for robust addressing, `dest_cell_id` for precise placement, and are tracked in the change log.

## Recovery

If something goes wrong:

- **Deleted cell** — `recover_cell(path, cell_id="...", client_name="...")` re-inserts it from change history
- **Bad edit** — `restore_snapshot(path, name="before-parallel-work")` rolls back the entire notebook (auto-saves a backup first)
- **Need to investigate** — `get_cell_history(path, cell_id="...")` shows the full change log for any cell

## Tools for multi-agent work

All collaboration-relevant tools in one place. For full parameter docs, see the [tool reference](/tools/).

| Tool | Purpose |
|------|---------|
| [`lock_cells`](/tools/collaboration/#lock_cells) | Claim cells before editing |
| [`unlock_cells`](/tools/collaboration/#unlock_cells) | Release locks when done |
| [`list_locks`](/tools/collaboration/#list_locks) | See who holds which locks |
| [`get_user_focus`](/tools/collaboration/#get_user_focus) | See which cell a human is editing |
| [`get_notebook_changes`](/tools/collaboration/#get_notebook_changes) | Poll for changes since a version |
| [`get_cell_history`](/tools/collaboration/#get_cell_history) | Full change log for one cell |
| [`recover_cell`](/tools/collaboration/#recover_cell) | Re-insert a deleted cell from history |
| [`snapshot_notebook`](/tools/collaboration/#snapshot_notebook) | Save a named checkpoint |
| [`restore_snapshot`](/tools/collaboration/#restore_snapshot) | Roll back to a checkpoint |
| [`diff_snapshot`](/tools/collaboration/#diff_snapshot) | Compare checkpoint vs current state |
| [`copy_cells`](/tools/editing/#copy_cells) | Duplicate cells between notebooks |
| [`move_cells`](/tools/editing/#move_cells) | Transfer cells between notebooks |
| [`batch_update_cells`](/tools/editing/#batch_update_cells) | Update multiple cells atomically |
| [`batch_insert_cells`](/tools/editing/#batch_insert_cells) | Insert multiple cells at once |
| [`replace_in_notebook`](/tools/editing/#replace_in_notebook) | Search and replace across cells |
| [`execute_range`](/tools/execution/#execute_range) | Run a section of cells in sequence |
