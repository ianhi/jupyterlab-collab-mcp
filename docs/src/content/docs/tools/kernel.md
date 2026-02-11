---
title: Kernel & Analysis
description: Kernel management, diagnostics, hover info, symbol rename, diff, and notebook rename.
---

Tools for kernel management, code analysis, and notebook-level operations.

## get_kernel_status

Get the status of a notebook's kernel. Requires JupyterLab connection.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |

Returns one of: `idle`, `busy`, `starting`, `dead`.

---

## get_kernel_variables

List variables defined in the notebook's kernel. Requires JupyterLab connection.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `filter` | string | No | show all | Filter by name pattern (case-insensitive substring match) |
| `include_private` | boolean | No | `false` | Include variables starting with underscore |

**Example:**
```
get_kernel_variables(path="nb.ipynb", filter="df")
```

---

## interrupt_kernel

Stop a running execution. Requires JupyterLab connection.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |

**Notes:**
- Does not restart the kernel or clear state
- Use when code is taking too long or stuck in an infinite loop

---

## restart_kernel

Restart the kernel, clearing all variables and state. Requires JupyterLab connection.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |

**Warning:** All variables will be lost.

---

## get_diagnostics

Get code diagnostics (errors, warnings) without executing. Uses LSP if available, otherwise falls back to Python syntax checking.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `cell_index` | number | No | all cells | Check only this cell |
| `cell_id` | string | No | — | Check only this cell by ID |

**Example:**
```
# Check entire notebook
get_diagnostics(path="nb.ipynb")

# Check one cell
get_diagnostics(path="nb.ipynb", cell_id="a3f8c2d1")
```

---

## get_hover_info

Get documentation/type info for code at a specific position. Requires JupyterLab connection.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |
| `cell_index` | number | Yes | Cell index containing the code |
| `line` | number | Yes | Line number within cell (0-indexed) |
| `character` | number | Yes | Character position (0-indexed) |

**Example:**
```
get_hover_info(path="nb.ipynb", cell_index=3, line=0, character=5)
```

**Notes:**
- Uses LSP if available, otherwise falls back to kernel introspection

---

## rename_symbol

Rename a Python symbol (variable, function, import) across all cells. Uses scope-aware analysis via jedi.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Notebook path |
| `cell_index` | number | Yes | Cell containing the symbol (0-indexed) |
| `line` | number | Yes | Line within cell (0-indexed) |
| `character` | number | Yes | Column within line (0-indexed) |
| `new_name` | string | Yes | New name for the symbol |

**Example:**
```
rename_symbol(path="nb.ipynb", cell_index=0, line=2, character=0, new_name="process_data")
```

**Notes:**
- Won't rename occurrences in strings or comments
- Unlike `replace_in_notebook`, understands Python scoping
- Requires jedi (auto-installed via `uvx`, or `pip install jedi`)

---

## rename_notebook

Rename a notebook file. Disconnects any active collaboration session first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Current notebook path |
| `new_path` | string | Yes | New path (must end in `.ipynb`) |

---

## diff_notebooks

Compare two notebooks cell by cell. Returns unified diff.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path1` | string | Yes | — | First notebook path |
| `path2` | string | Yes | — | Second notebook path |
| `include_outputs` | boolean | No | `false` | Include output differences |
| `summary_only` | boolean | No | `false` | Only show counts, not full diffs |
| `max_diffs` | number | No | all | Max cell diffs to show |

**Example:**
```
diff_notebooks(path1="v1.ipynb", path2="v2.ipynb", summary_only=true)
```
