"""Ingest a checkout into a ProjectContext.

Upstream took a path and walked it. Here the path arrives inside a
:class:`~repowiki.host.WorkspaceHandle` the host granted — which also carries
the list of files the host is willing to expose — so the enumeration is the
host's and only the reading is ours. :func:`ingest_local` keeps the plain-path
signature for the offline unit tests and for a caller that already holds a
directory it is allowed to read.
"""

from __future__ import annotations

import json
from pathlib import Path

from repowiki.core.models import FileInfo, ProjectContext
from repowiki.core.scanner import build_file_tree, scan_directory
from repowiki.host import WorkspaceHandle


def _guess_project_name(root: Path, files: list[FileInfo]) -> str:
    """try to extract the project name from config files, fall back to dir name."""
    for f in files:
        if f.path == "pyproject.toml" and f.content:
            for line in f.content.splitlines():
                if line.strip().startswith("name"):
                    # name = "something"
                    val = line.split("=", 1)[-1].strip().strip('"').strip("'")
                    if val:
                        return val

        if f.path == "package.json" and f.content:
            try:
                pkg = json.loads(f.content)
                if name := pkg.get("name"):
                    return str(name).lstrip("@").replace("/", "-")
            except (json.JSONDecodeError, TypeError):
                pass

        if f.path == "Cargo.toml" and f.content:
            for line in f.content.splitlines():
                if line.strip().startswith("name"):
                    val = line.split("=", 1)[-1].strip().strip('"').strip("'")
                    if val:
                        return val

    return root.name


def ingest_local(
    path: str | Path,
    max_file_size: int = 200 * 1024,
    max_files: int = 1000,
    paths: list[str] | None = None,
) -> ProjectContext:
    """Scan a directory and package it into a ProjectContext."""
    root = Path(path).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Not a directory: {root}")

    files = scan_directory(
        root, max_file_size=max_file_size, max_files=max_files, paths=paths
    )
    name = _guess_project_name(root, files)
    tree = build_file_tree(files)

    return ProjectContext(
        name=name,
        root=str(root),
        files=files,
        file_tree=tree,
    )


def ingest_handle(
    handle: WorkspaceHandle,
    max_file_size: int = 200 * 1024,
    max_files: int = 1000,
) -> ProjectContext:
    """Ingest a host-granted checkout, reading only the files it listed.

    The handle's `paths` is an allow-list, not a hint: passing it through means
    a file the host withheld — a `.env`, anything `.gitignore`d — is never even
    opened, rather than opened and then filtered by our own heuristics.
    """
    return ingest_local(
        handle.root,
        max_file_size=max_file_size,
        max_files=max_files,
        paths=handle.paths,
    )
