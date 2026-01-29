"""MCP tools for notebook discovery and content access."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mcp.server import Server

    from jupyterlab_claude_mcp.client import JupyterLabClient

logger = logging.getLogger(__name__)


def register_notebook_tools(mcp_server: Server, client: JupyterLabClient) -> None:
    """Register notebook discovery tools with the MCP server.

    Args:
        mcp_server: The MCP server instance to register tools with.
        client: The WebSocket client for communicating with JupyterLab.
    """
    # Import here to avoid circular imports
    from jupyterlab_claude_mcp.client import discover_instances

    @mcp_server.call_tool()
    async def list_jupyterlab_instances() -> list[dict[str, Any]]:
        """List all running JupyterLab instances that Claude can connect to.

        This discovers JupyterLab servers that have the Claude Code extension
        installed and are currently running. Use this to see available instances
        before connecting.

        Returns:
            List of instance info dictionaries, each containing:
            - instance_id: Short ID to identify this instance
            - port: The port JupyterLab is running on
            - pid: Process ID of the JupyterLab server

        If no instances are found, returns an empty list. The user may need to:
        1. Start JupyterLab with: jupyter lab
        2. Ensure jupyterlab-claude-code extension is installed
        """
        instances = discover_instances()
        # Remove token from response for security (don't expose in logs/output)
        return [
            {
                "instance_id": inst.get("instance_id"),
                "port": inst.get("port"),
                "pid": inst.get("pid"),
            }
            for inst in instances
        ]

    @mcp_server.call_tool()
    async def list_notebooks() -> list[dict[str, Any]]:
        """List all open notebooks in JupyterLab.

        Returns a list of notebooks with their paths, names, and kernel information.
        Each notebook entry includes:
        - path: The file path of the notebook
        - name: The display name of the notebook
        - kernel_id: The ID of the associated kernel (if any)
        - kernel_name: The name of the kernel (e.g., 'python3')

        Returns:
            A list of notebook information dictionaries.
        """
        try:
            response = await client.send_request("list_notebooks", params={})
            return response.data.get("notebooks", [])
        except Exception as e:
            logger.exception("Error listing notebooks")
            return [{"error": str(e), "notebooks": []}]

    @mcp_server.call_tool()
    async def get_active_notebook() -> dict[str, Any]:
        """Get the currently focused/active notebook in JupyterLab.

        Returns information about the notebook that currently has focus in the
        JupyterLab interface. This is useful for operations that should target
        the notebook the user is actively working on.

        The response includes:
        - notebook: The active notebook info (path, name, kernel_id, kernel_name)
          or None if no notebook is active
        - is_fallback: Boolean indicating if this is a best-guess (e.g., first
          open notebook) rather than the truly focused notebook

        Returns:
            A dictionary with the active notebook information.
        """
        try:
            response = await client.send_request("get_active_notebook", params={})
            return response.data
        except Exception as e:
            logger.exception("Error getting active notebook")
            return {"notebook": None, "is_fallback": False, "error": str(e)}

    @mcp_server.call_tool()
    async def get_notebook_content(path: str) -> dict[str, Any]:
        """Get the full content of a notebook including all cells and outputs.

        Retrieves the complete notebook document with all cells, their source code,
        outputs, and metadata. This is useful for understanding the current state
        of a notebook before making modifications.

        Args:
            path: The file path of the notebook to retrieve (e.g., 'notebooks/analysis.ipynb').

        Returns:
            A dictionary containing:
            - path: The notebook path
            - cells: List of cell objects, each with:
                - index: Cell position (0-indexed)
                - cell_type: 'code' or 'markdown'
                - source: The cell's source content
                - outputs: List of cell outputs (for code cells)
                - metadata: Cell metadata dictionary
            - metadata: Notebook-level metadata
        """
        if not path:
            return {"error": "Notebook path is required", "path": None, "cells": []}

        try:
            response = await client.send_request(
                "get_notebook_content",
                notebook_id=path,
                params={"path": path},
            )
            return response.data
        except Exception as e:
            logger.exception("Error getting notebook content")
            return {"error": str(e), "path": path, "cells": [], "metadata": {}}

    logger.info(
        "Registered notebook tools: list_notebooks, get_active_notebook, get_notebook_content"
    )
