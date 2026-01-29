"""WebSocket client for connecting to JupyterLab's Claude Code extension.

This module provides an async WebSocket client that communicates with the JupyterLab
extension to execute notebook operations like running cells, reading/writing notebooks,
and managing kernels.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any

import websockets
from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedError,
    InvalidStatusCode,
    WebSocketException,
)

if TYPE_CHECKING:
    from websockets.asyncio.client import ClientConnection

logger = logging.getLogger(__name__)

# Directory where JupyterLab writes connection files
CONNECTION_DIR = Path.home() / ".jupyter" / "claude-code-connections"


def discover_instances() -> list[dict[str, Any]]:
    """Discover available JupyterLab instances.

    Reads connection files from ~/.jupyter/claude-code-connections/
    and returns info about running instances.

    Returns:
        List of connection info dicts, each containing:
        - instance_id: Short unique ID for the instance
        - port: Server port
        - token: Auth token
        - ws_url: WebSocket URL
        - pid: Process ID
    """
    instances = []

    if not CONNECTION_DIR.exists():
        return instances

    for conn_file in CONNECTION_DIR.glob("*.json"):
        try:
            data = json.loads(conn_file.read_text())

            # Check if the process is still running
            pid = data.get("pid")
            if pid and not _is_process_running(pid):
                # Clean up stale connection file
                conn_file.unlink()
                continue

            instances.append(data)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Error reading connection file {conn_file}: {e}")

    return instances


def _is_process_running(pid: int) -> bool:
    """Check if a process with the given PID is running."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def get_default_instance() -> dict[str, Any] | None:
    """Get the default JupyterLab instance to connect to.

    If JUPYTER_INSTANCE_ID env var is set, returns that instance.
    If only one instance is running, returns it.
    Otherwise returns None (user must specify).

    Returns:
        Connection info dict or None if no default can be determined.
    """
    # Check for explicit instance ID
    instance_id = os.environ.get("JUPYTER_INSTANCE_ID")
    if instance_id:
        return get_instance_by_id(instance_id)

    instances = discover_instances()

    if len(instances) == 1:
        return instances[0]
    elif len(instances) == 0:
        return None
    else:
        # Multiple instances - check env vars for port hint
        port = os.environ.get("JUPYTER_PORT")
        if port:
            for inst in instances:
                if str(inst.get("port")) == port:
                    return inst

        # Can't determine default
        logger.warning(
            f"Multiple JupyterLab instances found: {[i['instance_id'] for i in instances]}. "
            "Set JUPYTER_INSTANCE_ID to specify which one to connect to."
        )
        return None


def get_instance_by_id(instance_id: str) -> dict[str, Any] | None:
    """Get connection info for a specific instance by ID.

    Args:
        instance_id: The instance ID to look up.

    Returns:
        Connection info dict or None if not found.
    """
    conn_file = CONNECTION_DIR / f"{instance_id}.json"
    if conn_file.exists():
        try:
            return json.loads(conn_file.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return None


class ConnectionState(Enum):
    """State of the WebSocket connection."""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"


class JupyterClientError(Exception):
    """Base exception for JupyterLab client errors."""

    pass


class ConnectionError(JupyterClientError):
    """Raised when connection to JupyterLab fails."""

    pass


class AuthenticationError(JupyterClientError):
    """Raised when authentication with JupyterLab fails."""

    pass


class RequestError(JupyterClientError):
    """Raised when a request to JupyterLab fails."""

    def __init__(self, message: str, request_id: str | None = None, error_data: Any = None):
        super().__init__(message)
        self.request_id = request_id
        self.error_data = error_data


class TimeoutError(JupyterClientError):
    """Raised when a request times out."""

    pass


@dataclass
class Request:
    """A request to be sent to JupyterLab."""

    action: str
    notebook_id: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        """Convert request to dictionary for JSON serialization."""
        data: dict[str, Any] = {
            "id": self.id,
            "type": "request",
            "action": self.action,
        }
        if self.notebook_id is not None:
            data["notebook_id"] = self.notebook_id
        if self.params:
            data["params"] = self.params
        return data

    def to_json(self) -> str:
        """Convert request to JSON string."""
        return json.dumps(self.to_dict())


@dataclass
class Response:
    """A response received from JupyterLab."""

    id: str
    success: bool
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Response:
        """Create a Response from a dictionary."""
        return cls(
            id=data.get("id", ""),
            success=data.get("success", False),
            data=data.get("data", {}),
            error=data.get("error"),
        )

    @classmethod
    def from_json(cls, json_str: str) -> Response:
        """Create a Response from a JSON string."""
        data = json.loads(json_str)
        return cls.from_dict(data)


class JupyterLabClient:
    """Async WebSocket client for JupyterLab Claude Code extension.

    This client manages a WebSocket connection to JupyterLab and provides methods
    for sending requests and receiving responses. It handles authentication via
    Jupyter tokens and supports automatic reconnection.

    Example usage:
        async with JupyterLabClient() as client:
            response = await client.execute_cell("notebook.ipynb", cell_index=0)
            print(response.data)
    """

    DEFAULT_HOST = "localhost"
    DEFAULT_PORT = 8888
    DEFAULT_PATH = "/claude-code/ws"
    DEFAULT_TIMEOUT = 30.0
    DEFAULT_RECONNECT_DELAY = 1.0
    MAX_RECONNECT_DELAY = 30.0
    MAX_RECONNECT_ATTEMPTS = 5

    def __init__(
        self,
        host: str | None = None,
        port: int | None = None,
        path: str | None = None,
        token: str | None = None,
        instance_id: str | None = None,
        use_ssl: bool = False,
        timeout: float = DEFAULT_TIMEOUT,
        auto_reconnect: bool = True,
    ):
        """Initialize the JupyterLab WebSocket client.

        Connection can be specified in three ways (in order of priority):
        1. Explicit parameters (host, port, token)
        2. Instance ID (looks up from discovery)
        3. Auto-discovery (finds running JupyterLab instances)

        Args:
            host: JupyterLab server hostname. Defaults to localhost.
            port: JupyterLab server port. Defaults to 8888.
            path: WebSocket endpoint path. Defaults to /claude-code/ws.
            token: Jupyter authentication token.
            instance_id: Connect to a specific instance by ID.
            use_ssl: Whether to use wss:// instead of ws://. Defaults to False.
            timeout: Default timeout for requests in seconds. Defaults to 30.0.
            auto_reconnect: Whether to automatically reconnect on connection loss.
                           Defaults to True.
        """
        self.instance_id = instance_id

        # Try to auto-discover connection info if not explicitly provided
        discovered = None
        if not (host or port or token):
            discovered = get_instance_by_id(instance_id) if instance_id else get_default_instance()

            if discovered:
                logger.info(
                    f"Auto-discovered JupyterLab instance: {discovered.get('instance_id')} "
                    f"on port {discovered.get('port')}"
                )

        # Use discovered values as defaults
        if discovered:
            self.host = host or self.DEFAULT_HOST
            self.port = port or discovered.get("port", self.DEFAULT_PORT)
            self.path = path or discovered.get("base_url", "") + "claude-code/ws"
            self.token = token or discovered.get("token")
            self.instance_id = discovered.get("instance_id")
        else:
            # Fall back to env vars / defaults
            self.host = host or os.environ.get("JUPYTER_HOST", self.DEFAULT_HOST)
            self.port = port or int(os.environ.get("JUPYTER_PORT", str(self.DEFAULT_PORT)))
            self.path = path or os.environ.get("JUPYTER_WS_PATH", self.DEFAULT_PATH)
            self.token = token or os.environ.get("JUPYTER_TOKEN")

        self.use_ssl = use_ssl
        self.timeout = timeout
        self.auto_reconnect = auto_reconnect

        self._connection: ClientConnection | None = None
        self._state = ConnectionState.DISCONNECTED
        self._pending_requests: dict[str, asyncio.Future[Response]] = {}
        self._receive_task: asyncio.Task[None] | None = None
        self._reconnect_task: asyncio.Task[None] | None = None
        self._reconnect_attempts = 0
        self._lock = asyncio.Lock()
        self._closed = False

    @property
    def state(self) -> ConnectionState:
        """Current connection state."""
        return self._state

    @property
    def is_connected(self) -> bool:
        """Whether the client is currently connected."""
        return self._state == ConnectionState.CONNECTED

    @property
    def ws_url(self) -> str:
        """Construct the WebSocket URL."""
        protocol = "wss" if self.use_ssl else "ws"
        url = f"{protocol}://{self.host}:{self.port}{self.path}"
        if self.token:
            url = f"{url}?token={self.token}"
        return url

    async def connect(self) -> None:
        """Establish a WebSocket connection to JupyterLab.

        Raises:
            ConnectionError: If connection fails.
            AuthenticationError: If authentication fails (invalid token).
        """
        if self._closed:
            raise ConnectionError("Client has been closed")

        async with self._lock:
            if self._state in (ConnectionState.CONNECTED, ConnectionState.CONNECTING):
                return

            self._state = ConnectionState.CONNECTING
            logger.info("Connecting to JupyterLab at %s", self.ws_url.split("?")[0])

            try:
                self._connection = await websockets.connect(
                    self.ws_url,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5,
                )
                self._state = ConnectionState.CONNECTED
                self._reconnect_attempts = 0
                logger.info("Successfully connected to JupyterLab")

                # Start the message receive loop
                self._receive_task = asyncio.create_task(self._receive_loop())

            except InvalidStatusCode as e:
                self._state = ConnectionState.DISCONNECTED
                if e.status_code == 403:
                    raise AuthenticationError(
                        "Authentication failed. Check your JUPYTER_TOKEN."
                    ) from e
                raise ConnectionError(f"Connection failed with status {e.status_code}") from e
            except OSError as e:
                self._state = ConnectionState.DISCONNECTED
                raise ConnectionError(f"Failed to connect to JupyterLab: {e}") from e
            except WebSocketException as e:
                self._state = ConnectionState.DISCONNECTED
                raise ConnectionError(f"WebSocket error: {e}") from e

    async def disconnect(self) -> None:
        """Close the WebSocket connection gracefully."""
        async with self._lock:
            await self._cleanup()

    async def _cleanup(self) -> None:
        """Clean up connection resources."""
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._receive_task
            self._receive_task = None

        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reconnect_task
            self._reconnect_task = None

        if self._connection:
            with contextlib.suppress(Exception):
                await self._connection.close()
            self._connection = None

        # Cancel all pending requests
        for _request_id, future in self._pending_requests.items():
            if not future.done():
                future.set_exception(ConnectionError("Connection closed"))
        self._pending_requests.clear()

        self._state = ConnectionState.DISCONNECTED
        logger.info("Disconnected from JupyterLab")

    async def close(self) -> None:
        """Close the client permanently. Cannot be reconnected after this."""
        self._closed = True
        await self.disconnect()

    async def _receive_loop(self) -> None:
        """Background task that receives and dispatches messages."""
        if not self._connection:
            return

        try:
            async for message in self._connection:
                if isinstance(message, bytes):
                    message = message.decode("utf-8")

                try:
                    data = json.loads(message)
                    await self._handle_message(data)
                except json.JSONDecodeError as e:
                    logger.warning("Received invalid JSON: %s", e)

        except ConnectionClosed as e:
            logger.info("Connection closed: code=%s reason=%s", e.code, e.reason)
        except Exception as e:
            logger.error("Error in receive loop: %s", e)
        finally:
            self._state = ConnectionState.DISCONNECTED
            if self.auto_reconnect and not self._closed:
                self._reconnect_task = asyncio.create_task(self._reconnect())

    async def _handle_message(self, data: dict[str, Any]) -> None:
        """Handle an incoming message from JupyterLab.

        Args:
            data: Parsed JSON message data.
        """
        msg_type = data.get("type")
        msg_id = data.get("id")

        if msg_type == "response" and msg_id:
            future = self._pending_requests.pop(msg_id, None)
            if future and not future.done():
                response = Response.from_dict(data)
                future.set_result(response)
        elif msg_type == "error":
            logger.error("Server error: %s", data.get("error", "Unknown error"))
        else:
            logger.debug("Received message: %s", data)

    async def _reconnect(self) -> None:
        """Attempt to reconnect to JupyterLab with exponential backoff."""
        self._state = ConnectionState.RECONNECTING

        while not self._closed and self._reconnect_attempts < self.MAX_RECONNECT_ATTEMPTS:
            self._reconnect_attempts += 1
            delay = min(
                self.DEFAULT_RECONNECT_DELAY * (2 ** (self._reconnect_attempts - 1)),
                self.MAX_RECONNECT_DELAY,
            )

            logger.info(
                "Reconnection attempt %d/%d in %.1f seconds",
                self._reconnect_attempts,
                self.MAX_RECONNECT_ATTEMPTS,
                delay,
            )

            await asyncio.sleep(delay)

            try:
                # Reset state for reconnection
                self._state = ConnectionState.DISCONNECTED
                await self.connect()
                return
            except JupyterClientError as e:
                logger.warning("Reconnection failed: %s", e)

        logger.error("Failed to reconnect after %d attempts", self.MAX_RECONNECT_ATTEMPTS)
        self._state = ConnectionState.DISCONNECTED

    async def send_request(
        self,
        action: str,
        notebook_id: str | None = None,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Response:
        """Send a request to JupyterLab and wait for the response.

        Args:
            action: The action to perform (e.g., "execute_cell", "get_notebook").
            notebook_id: Optional notebook path/identifier.
            params: Optional parameters for the action.
            timeout: Request timeout in seconds. Uses default if not specified.

        Returns:
            The response from JupyterLab.

        Raises:
            ConnectionError: If not connected and cannot reconnect.
            TimeoutError: If the request times out.
            RequestError: If the request fails on the server side.
        """
        if not self.is_connected:
            await self.connect()

        if not self._connection:
            raise ConnectionError("Not connected to JupyterLab")

        request = Request(
            action=action,
            notebook_id=notebook_id,
            params=params or {},
        )

        # Create a future to wait for the response
        future: asyncio.Future[Response] = asyncio.get_event_loop().create_future()
        self._pending_requests[request.id] = future

        try:
            # Send the request
            await self._connection.send(request.to_json())
            logger.debug("Sent request: %s", request.action)

            # Wait for the response with timeout
            response = await asyncio.wait_for(future, timeout=timeout or self.timeout)

            if not response.success:
                raise RequestError(
                    response.error or "Request failed",
                    request_id=request.id,
                    error_data=response.data,
                )

            return response

        except asyncio.TimeoutError as e:
            self._pending_requests.pop(request.id, None)
            raise TimeoutError(
                f"Request {request.action} timed out after {timeout or self.timeout}s"
            ) from e
        except ConnectionClosedError as e:
            self._pending_requests.pop(request.id, None)
            raise ConnectionError(f"Connection lost: {e}") from e

    # Convenience methods for common operations

    async def execute_cell(
        self,
        notebook_id: str,
        cell_index: int,
        timeout: float | None = None,
    ) -> Response:
        """Execute a cell in a notebook.

        Args:
            notebook_id: Path to the notebook.
            cell_index: Index of the cell to execute.
            timeout: Optional timeout override.

        Returns:
            Response containing cell outputs.
        """
        return await self.send_request(
            action="execute_cell",
            notebook_id=notebook_id,
            params={"cell_index": cell_index},
            timeout=timeout,
        )

    async def get_notebook(self, notebook_id: str) -> Response:
        """Get the contents of a notebook.

        Args:
            notebook_id: Path to the notebook.

        Returns:
            Response containing notebook data.
        """
        return await self.send_request(
            action="get_notebook",
            notebook_id=notebook_id,
        )

    async def list_notebooks(self, path: str = "") -> Response:
        """List notebooks in a directory.

        Args:
            path: Directory path to list. Defaults to root.

        Returns:
            Response containing list of notebooks.
        """
        return await self.send_request(
            action="list_notebooks",
            params={"path": path},
        )

    async def get_cell(self, notebook_id: str, cell_index: int) -> Response:
        """Get a specific cell from a notebook.

        Args:
            notebook_id: Path to the notebook.
            cell_index: Index of the cell to get.

        Returns:
            Response containing cell data.
        """
        return await self.send_request(
            action="get_cell",
            notebook_id=notebook_id,
            params={"cell_index": cell_index},
        )

    async def update_cell(
        self,
        notebook_id: str,
        cell_index: int,
        source: str,
        cell_type: str | None = None,
    ) -> Response:
        """Update a cell's content.

        Args:
            notebook_id: Path to the notebook.
            cell_index: Index of the cell to update.
            source: New cell source content.
            cell_type: Optional cell type ("code" or "markdown").

        Returns:
            Response confirming the update.
        """
        params: dict[str, Any] = {"cell_index": cell_index, "source": source}
        if cell_type:
            params["cell_type"] = cell_type
        return await self.send_request(
            action="update_cell",
            notebook_id=notebook_id,
            params=params,
        )

    async def insert_cell(
        self,
        notebook_id: str,
        cell_index: int,
        source: str = "",
        cell_type: str = "code",
    ) -> Response:
        """Insert a new cell into a notebook.

        Args:
            notebook_id: Path to the notebook.
            cell_index: Index where to insert the cell.
            source: Cell source content.
            cell_type: Cell type ("code" or "markdown").

        Returns:
            Response confirming the insertion.
        """
        return await self.send_request(
            action="insert_cell",
            notebook_id=notebook_id,
            params={"cell_index": cell_index, "source": source, "cell_type": cell_type},
        )

    async def delete_cell(self, notebook_id: str, cell_index: int) -> Response:
        """Delete a cell from a notebook.

        Args:
            notebook_id: Path to the notebook.
            cell_index: Index of the cell to delete.

        Returns:
            Response confirming the deletion.
        """
        return await self.send_request(
            action="delete_cell",
            notebook_id=notebook_id,
            params={"cell_index": cell_index},
        )

    async def get_kernel_status(self, notebook_id: str) -> Response:
        """Get the kernel status for a notebook.

        Args:
            notebook_id: Path to the notebook.

        Returns:
            Response containing kernel status.
        """
        return await self.send_request(
            action="get_kernel_status",
            notebook_id=notebook_id,
        )

    async def restart_kernel(self, notebook_id: str) -> Response:
        """Restart the kernel for a notebook.

        Args:
            notebook_id: Path to the notebook.

        Returns:
            Response confirming kernel restart.
        """
        return await self.send_request(
            action="restart_kernel",
            notebook_id=notebook_id,
        )

    async def interrupt_kernel(self, notebook_id: str) -> Response:
        """Interrupt the kernel for a notebook.

        Args:
            notebook_id: Path to the notebook.

        Returns:
            Response confirming kernel interrupt.
        """
        return await self.send_request(
            action="interrupt_kernel",
            notebook_id=notebook_id,
        )

    async def __aenter__(self) -> JupyterLabClient:
        """Async context manager entry - connects to JupyterLab."""
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> None:
        """Async context manager exit - closes the connection."""
        await self.close()


# Singleton client instance for the MCP server
_client: JupyterLabClient | None = None


async def get_client() -> JupyterLabClient:
    """Get or create the singleton JupyterLab client.

    Returns:
        The shared JupyterLabClient instance.
    """
    global _client
    if _client is None or _client._closed:
        _client = JupyterLabClient()
    if not _client.is_connected:
        await _client.connect()
    return _client


async def close_client() -> None:
    """Close the singleton client if it exists."""
    global _client
    if _client is not None:
        await _client.close()
        _client = None
