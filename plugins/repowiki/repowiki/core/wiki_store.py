"""SQLite-backed persistence for assembled wikis.

The analyzer cache keeps LLM pass results and ``RagStore`` keeps the retrieval
index, but the assembled ``Wiki`` — the thing the panel renders and the read
tools answer from — lived only in process memory, so every plugin-host restart
emptied ``repowiki_list`` and cost a full re-scan to get back. This store
persists what a restart needs to rebuild a ``ScanResult`` without re-running
the pipeline: the pages, the repo map, the workspace handle's durable fields,
and the source string a later rescan would re-acquire.

A rehydrated result carries ``project=None``: file contents are not
resurrected. Reads answer from the snapshot, search answers from the persisted
RAG index, and staleness still asks git — live file contents are the one thing
only a rescan produces.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import aiosqlite

from repowiki.core.graph import DependencyGraph
from repowiki.core.wiki_builder import Wiki, WikiPage
from repowiki.host import PATHS, WorkspaceHandle
from repowiki.pipeline import ScanResult

logger = logging.getLogger(__name__)

# Bump when the snapshot layout changes; ``load_all`` drops rows stamped with
# a different version rather than misinterpreting them — the same contract
# ``RagStore`` keeps.
SCHEMA_VERSION = 1


def _graph_snapshot(graph: DependencyGraph | None) -> dict | None:
    """Nodes with their attrs plus the edge list — everything the graph's
    readers need that survives losing the file contents it was built from."""
    if graph is None:
        return None
    return {
        "nodes": {n: dict(a) for n, a in graph.graph.nodes(data=True)},
        "edges": [[s, d] for s, d in graph.graph.edges],
    }


def _graph_from_snapshot(data) -> DependencyGraph | None:
    if not isinstance(data, dict):
        return None
    graph = DependencyGraph()
    nodes = data.get("nodes")
    if isinstance(nodes, dict):
        for path, attrs in nodes.items():
            graph.graph.add_node(str(path), **(attrs if isinstance(attrs, dict) else {}))
    for edge in data.get("edges") or []:
        if isinstance(edge, (list, tuple)) and len(edge) == 2:
            graph.graph.add_edge(str(edge[0]), str(edge[1]))
    graph._file_paths = set(graph.graph.nodes)
    return graph if graph.graph.nodes else None


def _snapshot_of(result: ScanResult) -> dict:
    handle = result.handle
    return {
        "source": result.source,
        "handle": {
            "root": handle.root,
            "origin": handle.origin,
            "ephemeral": handle.ephemeral,
            "remote": handle.remote,
            "headRef": handle.head_ref,
            "truncated": handle.truncated,
            "skippedSensitive": handle.skipped_sensitive,
        },
        "projectName": result.wiki.project_name,
        "fileCount": result.file_count,
        "pages": [
            {
                "id": page.id,
                "title": page.title,
                "content": page.content,
                "parentId": page.parent_id,
                "order": page.order,
            }
            for page in result.wiki.pages
        ],
        "mapEntries": result.map_entries,
        # The import edges the dependency graph was built from. File contents
        # die with the scan; the edges are small enough to keep so a
        # rehydrated project still answers "what imports X".
        "graph": _graph_snapshot(result.graph),
        "skippedModules": result.skipped_modules,
        "errors": result.errors,
        "warnings": result.warnings,
        "usage": result.usage,
        "scannedAt": result.scanned_at,
    }


def _result_from_snapshot(project_id: str, data: dict) -> ScanResult:
    """Rebuild a ScanResult whose ``project`` is deliberately absent.

    ``handle.paths`` stays empty: the persisted blob is a memory of what the
    host once allowed, not permission to keep reading — the next walk is the
    host's to grant again at rescan time.
    """
    raw_handle = data.get("handle") or {}
    handle = WorkspaceHandle(
        root=str(raw_handle.get("root") or ""),
        origin=str(raw_handle.get("origin") or "local-path"),
        ephemeral=bool(raw_handle.get("ephemeral")),
        remote=raw_handle.get("remote") if isinstance(raw_handle.get("remote"), dict) else None,
        truncated=bool(raw_handle.get("truncated")),
        skipped_sensitive=int(raw_handle.get("skippedSensitive") or 0),
        head_ref=str(raw_handle.get("headRef") or ""),
    )
    wiki = Wiki(
        project_name=str(data.get("projectName") or ""),
        pages=[
            WikiPage(
                id=str(page.get("id") or ""),
                title=str(page.get("title") or ""),
                content=str(page.get("content") or ""),
                parent_id=str(page.get("parentId") or ""),
                order=int(page.get("order") or 0),
            )
            for page in data.get("pages") or []
            if isinstance(page, dict)
        ],
    )
    usage = data.get("usage")
    return ScanResult(
        project_id=project_id,
        wiki=wiki,
        handle=handle,
        project=None,
        source=str(data.get("source") or ""),
        map_entries=[e for e in data.get("mapEntries") or [] if isinstance(e, dict)],
        graph=_graph_from_snapshot(data.get("graph")),
        file_count=int(data.get("fileCount") or 0),
        skipped_modules=[str(m) for m in data.get("skippedModules") or []],
        errors=[str(e) for e in data.get("errors") or []],
        warnings=[str(w) for w in data.get("warnings") or []],
        usage={str(k): int(v) for k, v in usage.items()} if isinstance(usage, dict) else {},
        scanned_at=float(data.get("scannedAt") or 0),
    )


class WikiStore:
    """async, project-scoped persistence for assembled wikis."""

    def __init__(self, db_path: str | Path | None = None):
        self._explicit_path = str(db_path) if db_path else None
        self._db: aiosqlite.Connection | None = None

    @property
    def db_path(self) -> str:
        return self._explicit_path or str(PATHS.wiki_db)

    async def init(self) -> None:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self.db_path)
        await self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS wiki_projects (
                project_id     TEXT PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                source         TEXT NOT NULL,
                scanned_at     REAL NOT NULL,
                snapshot       BLOB NOT NULL
            );
            """
        )
        await self._db.commit()

    async def close(self) -> None:
        if self._db:
            await self._db.close()
            self._db = None

    async def save(self, result: ScanResult) -> None:
        if not self._db:
            return
        snapshot = json.dumps(_snapshot_of(result), ensure_ascii=False)
        await self._db.execute(
            "INSERT OR REPLACE INTO wiki_projects "
            "(project_id, schema_version, source, scanned_at, snapshot) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                result.project_id,
                SCHEMA_VERSION,
                result.source,
                result.scanned_at or time.time(),
                snapshot,
            ),
        )
        await self._db.commit()

    async def load_all(self) -> list[ScanResult]:
        """Rehydrate every snapshot; drop rows this build cannot interpret."""
        if not self._db:
            return []
        cur = await self._db.execute(
            "SELECT project_id, schema_version, snapshot FROM wiki_projects"
        )
        rows = await cur.fetchall()
        results: list[ScanResult] = []
        stale_ids: list[str] = []
        for project_id, schema_version, blob in rows:
            if schema_version != SCHEMA_VERSION:
                stale_ids.append(project_id)
                continue
            try:
                data = json.loads(blob)
            except (TypeError, ValueError, UnicodeDecodeError):
                stale_ids.append(project_id)
                continue
            if not isinstance(data, dict):
                stale_ids.append(project_id)
                continue
            try:
                results.append(_result_from_snapshot(project_id, data))
            except Exception as exc:  # noqa: BLE001 — one bad row must not lose the rest
                logger.warning("wiki snapshot %s failed to rehydrate: %s", project_id, exc)
                stale_ids.append(project_id)
        for project_id in stale_ids:
            await self.delete(project_id)
        return results

    async def delete(self, project_id: str) -> None:
        if not self._db:
            return
        await self._db.execute(
            "DELETE FROM wiki_projects WHERE project_id = ?", (project_id,)
        )
        await self._db.commit()
