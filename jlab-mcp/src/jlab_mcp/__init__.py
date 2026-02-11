"""jlab-mcp — Launch JupyterLab with collaboration extensions for MCP."""

from __future__ import annotations

import os
import signal
import shutil
import subprocess
import sys
from pathlib import Path

__version__ = "0.1.0"

CORE_EXTENSIONS = [
    "jupyterlab",
    "jupyter-collaboration",
    "jupyter-lsp",
    "python-lsp-server",
]

DEFAULT_USER_EXTENSIONS = [
    "jupyterlab-vim",
    "jupyterlab-myst",
    "jupyterlab-git",
]


# ---------------------------------------------------------------------------
# Config file management
# ---------------------------------------------------------------------------


def _config_dir() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "jlab-mcp"
    return Path.home() / ".config" / "jlab-mcp"


def _config_file() -> Path:
    return _config_dir() / "config.toml"


def _write_config(extensions: list[str]) -> None:
    """Write config file with given extensions."""
    config_dir = _config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)

    lines = [
        "# jlab-mcp configuration",
        "#",
        "# Extra packages to include when launching JupyterLab.",
        "# Core extensions (jupyter-collaboration, jupyter-lsp, python-lsp-server)",
        "# are always included and don't need to be listed here.",
        "#",
        "# To skip these extras temporarily, run: jlab-mcp --no-extras",
        "",
        "extensions = [",
    ]
    for ext in extensions:
        lines.append(f'    "{ext}",')
    lines.append("]")

    _config_file().write_text("\n".join(lines) + "\n")


def _parse_extensions() -> list[str]:
    """Parse extensions from the TOML config file."""
    cf = _config_file()
    if not cf.exists():
        return []

    extensions: list[str] = []
    in_array = False

    for raw_line in cf.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        # Detect start of extensions array
        if line.startswith("extensions") and "=" in line and "[" in line:
            in_array = True
            after = line.split("[", 1)[1]
            if "]" in after:
                after = after.split("]")[0]
                in_array = False
            for part in after.split(","):
                part = part.strip().strip('"').strip("'").strip()
                if part:
                    extensions.append(part)
            continue

        if in_array:
            if "]" in line:
                line = line.split("]")[0]
                in_array = False
            # Strip inline comments
            if "#" in line:
                line = line[: line.index("#")]
            line = line.strip().rstrip(",").strip('"').strip("'").strip()
            if line:
                extensions.append(line)

    return extensions


def _ensure_config() -> None:
    """Create default config on first run."""
    cf = _config_file()
    if not cf.exists():
        _write_config(DEFAULT_USER_EXTENSIONS)
        print(f"Created config file: {cf}")
        print("  Edit it to customize which extensions are loaded.")
        print()


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def _cmd_list() -> None:
    print("Core extensions (always included):")
    for pkg in CORE_EXTENSIONS:
        print(f"  - {pkg}")
    print()

    cf = _config_file()
    exts = _parse_extensions()
    print(f"User extensions (from {cf}):")
    if not exts:
        print("  (none)")
    else:
        for pkg in exts:
            print(f"  + {pkg}")


def _cmd_add(packages: list[str]) -> None:
    if not packages:
        print("Usage: jlab-mcp add <package> [package...]")
        sys.exit(1)

    current = _parse_extensions()
    for pkg in packages:
        if pkg in current:
            print(f"Already configured: {pkg}")
        else:
            current.append(pkg)
            print(f"Added: {pkg}")
    _write_config(current)


def _cmd_remove(packages: list[str]) -> None:
    if not packages:
        print("Usage: jlab-mcp remove <package> [package...]")
        sys.exit(1)

    current = _parse_extensions()
    new_list: list[str] = []
    removed: set[str] = set()
    for ext in current:
        if ext in packages:
            print(f"Removed: {ext}")
            removed.add(ext)
        else:
            new_list.append(ext)

    for pkg in packages:
        if pkg not in removed:
            print(f"Not found: {pkg}")

    _write_config(new_list)


def _find_uv() -> tuple[str, str]:
    """Find uv/uvx executables. Returns (uv_cmd, uvx_cmd)."""
    if shutil.which("uv"):
        return ("uv", "uvx")
    if shutil.which("npx"):
        print("uv not found — falling back to npx @manzt/uv")
        return ("npx @manzt/uv", "npx @manzt/uvx")

    print("Error: neither 'uv' nor 'npx' found in PATH.")
    print()
    print("Install uv:")
    print("  curl -LsSf https://astral.sh/uv/install.sh | sh")
    print()
    print("Or see: https://docs.astral.sh/uv/getting-started/installation/")
    sys.exit(1)


def _cmd_launch(args: list[str]) -> None:
    uv_cmd, uvx_cmd = _find_uv()

    no_extras = "--no-extras" in args
    passthrough = [a for a in args if a != "--no-extras"]

    # Build extension list
    user_extensions = [] if no_extras else _parse_extensions()
    all_extensions = CORE_EXTENSIONS + user_extensions

    # Print what we're loading
    print("Core extensions:")
    for pkg in CORE_EXTENSIONS:
        print(f"  - {pkg}")
    if no_extras:
        print("User extensions: skipped (--no-extras)")
    elif user_extensions:
        print(f"User extensions (from {_config_file()}):")
        for pkg in user_extensions:
            print(f"  + {pkg}")
    else:
        print("User extensions: none configured")
    print()

    # Port handling
    port = os.environ.get("JUPYTER_PORT", "8888")
    has_port = any("--port" in a for a in passthrough)
    port_args = [] if has_port else ["--port", port]

    # Build --with args
    with_args: list[str] = []
    for pkg in all_extensions:
        with_args.extend(["--with", pkg])

    # Detect environment and build command
    cwd = Path.cwd()
    if (cwd / "pixi.toml").exists() or (cwd / "pixi.lock").exists():
        print("Pixi project detected")
        print(f"  Note: Add to pixi.toml: {' '.join(all_extensions)}")
        cmd = ["pixi", "run", "jupyter-lab"] + port_args + passthrough
    elif (cwd / "pyproject.toml").exists():
        print("Python project detected — installing local package + extras...")
        cmd = uv_cmd.split() + ["run"] + with_args + ["jupyter-lab"] + port_args + passthrough
    else:
        print("Standalone mode — launching JupyterLab with extras...")
        cmd = uvx_cmd.split() + ["--from", "jupyterlab"] + with_args + ["jupyter-lab"] + port_args + passthrough

    # Launch with signal forwarding
    proc = subprocess.Popen(cmd)

    def handler(sig: int, frame: object) -> None:
        print("\nShutting down JupyterLab...")
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            print("Force killing hung process...")
            proc.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)

    sys.exit(proc.wait())


def _cmd_help() -> None:
    print("jlab-mcp — Launch JupyterLab with collaboration extensions")
    print()
    print("Usage:")
    print("  jlab-mcp                        Launch JupyterLab")
    print("  jlab-mcp --no-extras [args]     Launch without user extensions")
    print("  jlab-mcp list                   Show configured extensions")
    print("  jlab-mcp add <pkg> [pkg...]     Add user extensions")
    print("  jlab-mcp remove <pkg> [pkg...]  Remove user extensions")
    print()
    print(f"Config: {_config_file()}")
    print()
    print("Install: uv tool install jlab-mcp")
    print("Also available as: jupyter-collab")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    _ensure_config()

    args = sys.argv[1:]

    if not args:
        _cmd_launch([])
        return

    cmd = args[0]
    if cmd == "list":
        _cmd_list()
    elif cmd == "add":
        _cmd_add(args[1:])
    elif cmd == "remove":
        _cmd_remove(args[1:])
    elif cmd in ("--help", "-h"):
        _cmd_help()
    elif cmd == "--version":
        print(f"jlab-mcp {__version__}")
    else:
        _cmd_launch(args)


if __name__ == "__main__":
    main()
