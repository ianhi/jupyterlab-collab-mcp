---
title: Best Practices
description: Essential patterns for AI agents using the JupyterLab Collab MCP tools.
---

This page is for you, the AI agent. These are the patterns that matter most when working with notebooks through this MCP server.

## Always use cell IDs, not indices

Positional indices shift when cells are inserted or deleted — by you, by another agent, or by a human. Cell IDs are stable 8-character identifiers that survive any reordering.

```
# Bad — breaks if anything changes above cell 5
update_cell(path="nb.ipynb", index=5, source="...")

# Good — stays correct no matter what
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="...")
```

After reading a notebook with `get_notebook_content`, note the cell IDs and use them for all subsequent operations.

## Always pass client_name

Every write operation accepts a `client_name` parameter. Pass it on every call — it enables:
- **Change tracking attribution** — `get_cell_history` shows who changed what
- **Lock owner matching** — you can modify your own locked cells without `force=true`
- **Audit trails** — force-overrides of locks are recorded with the overrider's name

```
insert_cell(path="nb.ipynb", source="...", client_name="my-agent-name")
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="...", client_name="my-agent-name")
delete_cell(path="nb.ipynb", cell_id="a3f8c2d1", client_name="my-agent-name")
```

Tools that accept `client_name`: `insert_cell`, `update_cell`, `delete_cell`, `insert_and_execute`, `update_and_execute`, `batch_update_cells`, `batch_insert_cells`, `copy_cells`, `move_cells`, `recover_cell`.

## Lock cells before modifying them

If other agents or humans might be working on the same notebook, lock the cells you plan to modify:

```
# Claim your cells (default TTL: 10 minutes)
lock_cells(path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"], owner="my-agent-name")

# Work on them...
update_cell(path="nb.ipynb", cell_id="a3f8c2d1", source="...", client_name="my-agent-name")

# Release when done
unlock_cells(path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"], owner="my-agent-name")
```

- Lock owners can modify their own cells freely
- Other agents get a warning and must use `force=true` to override
- Locks auto-expire after 10 minutes (configurable via `ttl_minutes`)
- Calling `lock_cells` again on cells you own renews the TTL

## Snapshot before risky operations

Take a named snapshot before doing anything you might want to undo:

```
snapshot_notebook(path="nb.ipynb", name="before-refactor")

# Do risky work...

# If something goes wrong:
restore_snapshot(path="nb.ipynb", name="before-refactor")
```

`restore_snapshot` automatically saves a `pre-restore` backup, so you can't lose the current state.

## Check for human activity

Before modifying a cell, the server checks if a human is editing it via JupyterLab's awareness protocol. If a human is focused on the target cell, you'll get:

```
Cannot modify cell 5 (a3f8c2d1) — user "Ian" is currently editing it.
Use force=true to override.
```

Don't force-override unless you have a good reason. Move on to a different cell and come back later.

## Manage context efficiently

Notebooks can be large. Use these patterns to avoid context blowout:

- **Skip markdown cells** — `get_notebook_content` defaults to `cell_type="code"`, which skips markdown. Only use `cell_type="all"` when you need prose.
- **Skip outputs by default** — `include_outputs=false` (the default) keeps responses small. Only request outputs when you need to check execution results.
- **Limit images** — for cells that produce plots, use `max_images=2` or `include_images=false` to prevent large base64 blobs from filling your context.
- **Read specific cells** — use `cell_ids` or `indices` to read only the cells you need, not the whole notebook.
- **Use `get_notebook_outline`** — get a condensed view (headers + first lines) before reading full cells.

```
# Good — read only what you need
get_notebook_content(path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"], include_outputs=true)

# Risky — reads everything with all outputs
get_notebook_content(path="nb.ipynb", cell_type="all", include_outputs=true)
```

## Poll for changes from others

Use `get_notebook_changes` to see what other agents (or humans) have done since you last checked:

```
# First call — get current version number
result = get_notebook_changes(path="nb.ipynb", since_version=0)
# → current_version: 15

# Later — see what's new
result = get_notebook_changes(path="nb.ipynb", since_version=15)
# → changes by others since version 15
```

## Use batch operations

When updating multiple cells, prefer batch operations — they reduce the window for race conditions:

```
# Atomic — all cells update together
batch_update_cells(path="nb.ipynb", updates=[
  {"index": 2, "source": "..."},
  {"index": 5, "source": "..."}
])
```

## Recover from mistakes

If you accidentally delete a cell, recover it from the change history:

```
recover_cell(path="nb.ipynb", cell_id="deleted-cell-id", client_name="my-agent-name")
```

This re-inserts the cell with its last known content.
