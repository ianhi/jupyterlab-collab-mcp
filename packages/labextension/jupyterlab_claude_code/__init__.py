"""JupyterLab extension for Claude Code integration."""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import uuid
from pathlib import Path

from .handlers import setup_handlers

# Directory for connection files
CONNECTION_DIR = Path.home() / ".jupyter" / "claude-code-connections"

# Global to track our connection file for cleanup
_connection_file: Path | None = None


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "@jupyterlab-claude-code/labextension"}]


def _jupyter_server_extension_points():
    return [{"module": "jupyterlab_claude_code"}]


def _write_connection_file(server_app) -> Path:
    """Write connection info to a file for the MCP server to discover."""
    CONNECTION_DIR.mkdir(parents=True, exist_ok=True)

    # Generate a unique instance ID
    instance_id = str(uuid.uuid4())[:8]

    # Get connection details
    port = server_app.port
    token = server_app.identity_provider.token if server_app.identity_provider else ""
    base_url = server_app.base_url

    connection_info = {
        "instance_id": instance_id,
        "port": port,
        "token": token,
        "base_url": base_url,
        "ws_url": f"ws://localhost:{port}{base_url}claude-code/ws",
        "pid": os.getpid(),
    }

    # Write to file named by instance ID
    connection_file = CONNECTION_DIR / f"{instance_id}.json"
    connection_file.write_text(json.dumps(connection_info, indent=2))

    server_app.log.info(
        f"Claude Code connection file written: {connection_file}\n"
        f"  Instance ID: {instance_id}\n"
        f"  Port: {port}"
    )

    return connection_file


def _cleanup_connection_file():
    """Remove connection file on shutdown."""
    global _connection_file
    if _connection_file and _connection_file.exists():
        with contextlib.suppress(Exception):
            _connection_file.unlink()


def _load_jupyter_server_extension(server_app):
    """Register the API handler to receive HTTP requests from the frontend."""
    global _connection_file

    setup_handlers(server_app.web_app)

    # Write connection file for MCP server discovery
    _connection_file = _write_connection_file(server_app)

    # Clean up on exit
    atexit.register(_cleanup_connection_file)

    name = "jupyterlab_claude_code"
    server_app.log.info(f"Registered {name} server extension")


# For backward compatibility
load_jupyter_server_extension = _load_jupyter_server_extension
