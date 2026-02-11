---
title: Connection Tools
description: Connect to JupyterLab, discover files and notebooks.
---

Tools for connecting to JupyterLab and discovering available notebooks.

## connect_jupyter

Connect to a JupyterLab server. Required for kernel operations (execute, restart, etc.) and real-time sync. Many tools work without connecting by reading `.ipynb` files directly.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | JupyterLab URL with token (e.g., `http://localhost:8888/lab?token=abc123`) |

**Example:**
```
connect_jupyter(url="http://localhost:8888/lab?token=abc123")
```

**Notes:**
- Call this first before using kernel operations
- The token is parsed from the URL automatically
- Most read/write tools work without connecting (filesystem mode)

---

## list_files

List files and directories in the Jupyter file system. Use to discover available notebooks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | No | `""` (root) | Directory path to list |

**Example:**
```
list_files(path="projects/")
```

---

## list_notebooks

List notebooks with active kernel sessions. Requires JupyterLab connection.

*No parameters.*

**Notes:**
- Only shows notebooks where a kernel is running (not just open in browser)
- Use `open_notebook` to start a kernel
- Use `list_files` to see all `.ipynb` files regardless of kernel state

---

## open_notebook

Open a notebook and start a kernel session. Requires JupyterLab connection.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Notebook path (e.g., `analysis.ipynb`) |
| `kernel_name` | string | No | notebook's default | Kernel to use (e.g., `python3`) |

**Example:**
```
open_notebook(path="analysis.ipynb", kernel_name="python3")
```

**Notes:**
- Safe to call if already open (reuses existing kernel)
- Required before executing cells in a notebook not yet listed by `list_notebooks`

---

## create_notebook

Create a new notebook file. Optionally open it immediately with a kernel.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | Yes | — | Path for new notebook |
| `kernel_name` | string | No | `python3` | Kernel to use |
| `open` | boolean | No | `true` | Open the notebook after creation |

**Example:**
```
create_notebook(path="new_analysis.ipynb")
```
