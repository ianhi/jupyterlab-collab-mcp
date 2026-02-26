---
title: Kernel & Analysis
description: Kernel management, diagnostics, hover info, symbol rename, diff, and notebook rename.
---

Tools for kernel management, code analysis, and notebook-level operations.

## kernel

Manage the notebook's kernel. Use `action` to check status, interrupt, or restart.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"status"` \| `"interrupt"` \| `"restart"` | Yes | Kernel operation |
| `path` | string | Yes | Notebook path |

**Examples:**
```
# Check kernel status (returns: idle, busy, starting, dead)
kernel(action="status", path="nb.ipynb")

# Interrupt a running execution
kernel(action="interrupt", path="nb.ipynb")

# Restart the kernel (clears all variables)
kernel(action="restart", path="nb.ipynb")
```

**Notes:**
- Requires JupyterLab connection
- **interrupt** does not restart the kernel or clear state — use when code is taking too long
- **restart** clears all variables and state

---

## kernel_variables

List or inspect variables defined in the notebook's kernel. When `names` is provided, returns deep inspection of those specific variables. Otherwise lists all variables.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path |
| `names` | string[] | No | — | Variable names to deep-inspect (max 20). Omit to list all |
| `detail` | string | No | `basic` | Detail level: `basic`, `schema`, or `full` (list mode only) |
| `filter` | string | No | show all | Filter by name pattern (case-insensitive substring match, list mode only) |
| `include_private` | boolean | No | `false` | Include variables starting with underscore (list mode only) |
| `max_variables` | number | No | `50` | Maximum number of variables to return (list mode only) |
| `max_items` | number | No | `20` | Max columns/keys/elements per variable |

**Detail levels (list mode):**

- **`basic`**: Name, type, and short repr. Fast and compact.
- **`schema`** (recommended): One-line summaries with column/dtype info for DataFrames, shape for arrays, keys for dicts. Best for agents.
- **`full`**: Complete structured metadata. Verbose but machine-readable.

**Examples:**
```
# Quick scan (basic)
kernel_variables(path="nb.ipynb")

# Detailed DataFrame/array metadata (schema)
kernel_variables(path="nb.ipynb", detail="schema")

# Filter for specific variables
kernel_variables(path="nb.ipynb", filter="df", detail="schema")

# Deep-inspect specific variables
kernel_variables(path="nb.ipynb", names=["df", "results"])

# Inspect with more detail
kernel_variables(path="nb.ipynb", names=["data"], max_items=50)
```

**Output example (schema mode):**
```
df: DataFrame (100x5) [date:datetime64[ns], price:float64, volume:int64, ...]
arr: ndarray float64 (1000, 3) 23.4KB
results: dict (15 keys) [model_a, model_b, baseline, ...]
```

**Supported types with specialized handlers (inspect mode):**

- **pandas.DataFrame**: columns (name+dtype), shape, memory_bytes, MultiIndex support
- **polars.DataFrame**: columns (name+dtype), shape, estimated_size_bytes
- **polars.LazyFrame**: schema without triggering computation
- **numpy.ndarray**: shape, dtype, ndim, nbytes
- **xarray.Dataset**: dims, data_vars (with dtypes), coords
- **xarray.DataArray**: dims, dtype
- **xarray.DataTree**: children, data_vars, dims, total_nodes
- **dict**: keys, values_preview (shows type+shape for DataFrames/arrays)

**Generic fallback:** For unknown types, returns type, repr, and shape/dtype/len if available.

**Safety:**
- Never triggers lazy computation (polars `.collect()`, dask `.compute()`)
- Never crashes on broken objects
- All operations complete in <5ms per variable

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
