---
title: Best Practices
description: Essential patterns for AI agents using the JupyterLab Collab MCP tools.
---

This page is for you, the AI agent. These are the patterns that matter most when working with notebooks through this MCP server.

## Common mistakes

These anti-patterns were discovered across four rounds of multi-agent testing. Avoid them.

| Mistake | Why it breaks | Fix |
|---------|--------------|-----|
| Using `index` instead of `cell_id` | Indices shift when any cell is inserted or deleted | Read cell IDs from `get_notebook_content` and use `cell_id` on all subsequent calls |
| Ignoring focus-blocked warnings | Overwriting a cell a human is editing leads to lost work | Move on to a different cell and come back later — or call `get_user_focus` proactively to check before writing |
| Modifying cells without locking first | Another agent can overwrite your changes silently (last write wins) | `lock_cells` before editing; `unlock_cells` when done |
| Not passing `client_name` | All changes attribute to `"claude-code"` — impossible to audit who did what | Pass `client_name="your-agent-name"` on every write call |
| Using `batch_update_cells` during concurrent inserts | It takes `index` not `cell_id` — concurrent inserts shift indices | Lock the region first, or use individual `update_cell` calls with `cell_id` |
| Reading the entire notebook with outputs | Large notebooks with images can blow out your context window | Use `cell_type="code"` (default), `include_outputs=false` (default), and `cell_ids` to read only what you need |

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

Before writing, check where the human is working:

```
# Proactive check — see which cell the human is focused on
get_user_focus(path="nb.ipynb")
# → {cell_index: 5, cell_id: "a3f8c2d1", cursor: {line: 3, column: 12}}
```

Write tools also check automatically — if a human is focused on the target cell, you'll get:

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
- **Check outputs separately** — use `get_cell_outputs` to check execution results for specific cells without re-reading all source code.

```
# Good — read only what you need
get_notebook_content(path="nb.ipynb", cell_ids=["a3f8c2d1", "b7e4f9a2"], include_outputs=true)

# Good — check results without re-fetching source
get_cell_outputs(path="nb.ipynb", cell_ids=["a3f8c2d1"], include_images=false)

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

**Note:** `batch_update_cells` uses `index` (not `cell_id`). If other agents are inserting cells concurrently, lock the region first to prevent index drift.

## Refactor with search-and-replace

Use `replace_in_notebook` for renaming variables or updating patterns across cells:

```
# Preview first with dry_run
replace_in_notebook(path="nb.ipynb", search="old_name", replace="new_name", dry_run=true)

# Apply the changes
replace_in_notebook(path="nb.ipynb", search="old_name", replace="new_name")
```

For scope-aware Python renames (won't touch strings or comments), use `rename_symbol` instead.

## Verify kernel availability

Before executing code, check that the kernel is ready:

```
# See what kernels are installed and running
list_kernels()

# Check if the kernel is idle (not still running a previous execution)
get_kernel_status(path="nb.ipynb")
```

## Work with tags

Use tags to mark cells for specific treatment (e.g., `hide-input`, `parameters`, `skip-execution`):

```
# Tag cells
add_cell_tags(path="nb.ipynb", cell_ids=["a3f8c2d1"], tags=["parameters"])

# Find tagged cells later
find_cells_by_tag(path="nb.ipynb", tags=["parameters"])
```

## Recover from mistakes

If you accidentally delete a cell, recover it from the change history:

```
recover_cell(path="nb.ipynb", cell_id="deleted-cell-id", client_name="my-agent-name")
```

This re-inserts the cell with its last known content.
