"""One scan, end to end.

Upstream spread this across `cli.py`'s `scan` command and the server's
`ProjectCoordinator` — two copies of the same eight steps, which is why the CLI
and the web UI drifted on things like whether the RAG index was persisted. The
plugin has one caller, so it gets one pipeline, and the surfaces (tools now, a
panel in the next batch) all drive it.

Everything host-facing goes through :mod:`repowiki.host`; nothing here imports
``cognia``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from repowiki.config import Config
from repowiki.core.analyzer import Analyzer
from repowiki.core.cache import Cache
from repowiki.core.graph import DependencyGraph
from repowiki.core.models import ProjectContext
from repowiki.core.rag import SimpleRAG
from repowiki.core.rag_store import RagStore
from repowiki.core.wiki_builder import Wiki, WikiBuilder
from repowiki.host import (
    LLMClient,
    WorkspaceHandle,
    acquire_workspace,
    changed_since,
    get_host,
    release_workspace,
)
from repowiki.ingest.git_diff import changed_paths_since
from repowiki.ingest.local import ingest_handle
from repowiki.project import project_id_for, repo_map

logger = logging.getLogger(__name__)

ProgressFn = Callable[[str], None]


@dataclass
class ScanResult:
    project_id: str
    wiki: Wiki
    handle: WorkspaceHandle
    #: ``None`` for a scan rehydrated from the wiki store: file contents were
    #: never resurrected, so consumers that need them must say so instead of
    #: pretending. The wiki, the repo map, and the handle's durable fields all
    #: survive.
    project: ProjectContext | None
    #: The source the user typed ("owner/repo", URL, or local path). Persisted
    #: so a rescan of a URL-ingested repository re-acquires it — the clone's
    #: ``handle.root`` does not outlive its release.
    source: str = ""
    #: The full PageRank reading order, computed once at scan time. Before this
    #: field existed, ``reading_order`` rebuilt the dependency graph on every
    #: call to re-rank it.
    map_entries: list[dict[str, Any]] = field(default_factory=list)
    #: The dependency graph built for the scan — import edges between files.
    #: Rehydrated scans rebuild it from the persisted snapshot; a snapshot
    #: written before graphs were persisted leaves it ``None``, and tools
    #: that need edges must say so rather than silently answer from nothing.
    graph: DependencyGraph | None = None
    file_count: int = 0
    scanned_at: float = 0.0
    rankings: list[tuple[str, float]] = field(default_factory=list)
    #: Modules the incremental pass skipped, by name.
    skipped_modules: list[str] = field(default_factory=list)
    #: Non-fatal analysis failures. A wiki with holes still ships; it says so.
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)

    def to_summary(self) -> dict[str, Any]:
        return {
            "projectId": self.project_id,
            "projectName": self.wiki.project_name,
            "root": self.handle.root,
            "origin": self.handle.origin,
            "source": self.source,
            "live": self.project is not None,
            "fileCount": len(self.project.files) if self.project is not None else self.file_count,
            "pageCount": len(self.wiki.pages),
            "pages": [
                {"id": page.id, "title": page.title, "parentId": page.parent_id}
                for page in self.wiki.pages
            ],
            "skippedModules": self.skipped_modules,
            "errors": self.errors,
            "warnings": self.warnings,
            "usage": self.usage,
            "truncated": self.handle.truncated,
            "skippedSensitive": self.handle.skipped_sensitive,
        }


@dataclass
class Staleness:
    """Whether the wiki still describes the checkout it was built from.

    ``known`` is the field that matters. A wiki whose staleness cannot be
    determined — the checkout is not a repository, the host has no git bridge,
    the commit it was built at was never recorded — must not be *badged* as
    current, because "no badge" reads as "up to date" and that is a claim we
    cannot make. It is also not badged as stale, which would send the user into
    a re-scan that changes nothing.
    """

    known: bool = False
    stale: bool = False
    #: Repo-relative paths that moved since the scan. Empty when not stale.
    changed: list[str] = field(default_factory=list)
    #: Why staleness is unknown. Empty when ``known``.
    reason: str = ""

    def to_summary(self) -> dict[str, Any]:
        return {
            "known": self.known,
            "stale": self.stale,
            "changedCount": len(self.changed),
            "changed": self.changed[:50],
            "reason": self.reason,
        }


async def staleness(result: ScanResult) -> Staleness:
    """Compare the checkout now against the commit the wiki was built at.

    This is the one caller that must *not* use
    :func:`repowiki.ingest.git_diff.changed_paths_since`: that helper collapses
    "the host could not answer" into the same empty set as "nothing changed",
    which is exactly the distinction a staleness badge is made of.

    The ref comes from the host at acquire time, so it is known-resolvable —
    which is what makes an empty diff here mean "unchanged" rather than
    "unknown ref".
    """
    ref = result.handle.head_ref
    if not ref:
        return Staleness(reason="the checkout reported no commit to compare against")
    try:
        changed = await changed_since(result.handle, ref)
    except Exception as exc:  # noqa: BLE001 — unknown, not stale, and say so
        logger.warning("staleness check failed for %s: %s", result.project_id, exc)
        return Staleness(reason=f"{type(exc).__name__}: {exc}")
    return Staleness(known=True, stale=bool(changed), changed=sorted(changed))


def spec_for(source: str) -> dict[str, Any]:
    """Read whatever the user typed as a workspace spec.

    ``auto`` is the host's own router — it decides remote-versus-local with the
    same parser the workspace API uses everywhere else, so a plugin guessing
    here would be a second answer to a question the host already answers.
    """
    return {"kind": "auto", "input": source.strip()}


async def scan(
    source: str,
    *,
    config: Config | None = None,
    since: str = "",
    on_progress: ProgressFn | None = None,
    path_filter: Callable[[str], bool] | None = None,
) -> ScanResult:
    """Acquire, ingest, analyse, build. The whole scan."""
    cfg = config or Config()
    report = on_progress or (lambda _message: None)

    report(f"Acquiring {source}")
    handle = await acquire_workspace(
        spec_for(source), max_files=cfg.max_files, max_file_size=cfg.max_file_size
    )
    try:
        return await _scan_acquired(
            source, handle, cfg=cfg, since=since, report=report,
            path_filter=path_filter,
        )
    except BaseException:
        # A failed scan never reaches _SCANS, so the shutdown sweep cannot
        # see this handle — release an ephemeral clone here or it leaks for
        # the life of the process.
        if handle.ephemeral:
            try:
                await release_workspace(handle)
            except Exception as exc:  # noqa: BLE001 — keep the original error
                logger.info("release_workspace failed for %s: %s", source, exc)
        raise


async def _scan_acquired(
    source: str,
    handle: WorkspaceHandle,
    *,
    cfg: Config,
    since: str,
    report: ProgressFn,
    path_filter: Callable[[str], bool] | None,
) -> ScanResult:
    """Everything after acquire: ingest, analyse, build."""
    warnings: list[str] = []
    if handle.truncated:
        warnings.append(f"Only the first {cfg.max_files} files were listed")
    if handle.skipped_sensitive:
        warnings.append(
            f"The host withheld {handle.skipped_sensitive} credential file(s)"
        )

    if path_filter:
        before = len(handle.paths)
        handle.paths = [path for path in handle.paths if path_filter(path)]
        dropped = before - len(handle.paths)
        if not handle.paths:
            raise ValueError("Include/exclude rules filtered out every file")
        if dropped:
            report(f"Filters excluded {dropped} file(s)")
            warnings.append(f"Include/exclude rules filtered out {dropped} file(s)")

    report("Reading files")
    # Up to max_files of synchronous disk IO / regex passes — run it off the
    # event loop so the host can keep answering other calls while a scan runs.
    project = await asyncio.to_thread(
        ingest_handle,
        handle,
        max_file_size=cfg.max_file_size,
        max_files=cfg.max_files,
    )

    report("Building the dependency graph")
    graph = await asyncio.to_thread(DependencyGraph.build_from_project, project)
    rankings = graph.rank_files()

    changed: set[str] | None = None
    if since:
        changed = await changed_paths_since(handle, since)
        if changed:
            report(f"Incremental: {len(changed)} changed path(s) since {since}")
        else:
            # Empty means "could not answer", never "nothing changed" — see
            # `changed_paths_since`. Falling back to a full pass is the only
            # safe reading, and saying so beats a silently stale wiki.
            warnings.append(f"Could not resolve '{since}'; re-analysing everything")

    cache = Cache()
    await cache.init()
    try:
        llm = LLMClient(model=cfg.model)
        analyzer = Analyzer(
            llm=llm,
            cache=cache,
            language=cfg.language,
            concurrency=cfg.concurrency,
            max_context_tokens=cfg.max_context_tokens,
            changed_paths=changed or None,
        )
        wiki_data = await analyzer.analyze(project, on_progress=report, rankings=rankings)
    finally:
        await cache.close()

    report("Assembling pages")
    builder = WikiBuilder()
    wiki = builder.build(project, wiki_data, graph)

    return ScanResult(
        project_id=project_id_for(source),
        wiki=wiki,
        handle=handle,
        project=project,
        source=source,
        # Ranked once, here: `reading_order` slices this list, and the wiki
        # store persists it so a rehydrated scan answers without the files.
        map_entries=[
            entry.to_dict()
            for entry in repo_map(
                project.files,
                root=handle.root,
                top=max(1, len(project.files)),
                ranked=rankings,
            )
        ],
        # Kept for the deps tool and persisted through the wiki snapshot —
        # the file contents the graph was built from die with the scan, but
        # the edges do not have to.
        graph=graph,
        file_count=len(project.files),
        scanned_at=time.time(),
        rankings=rankings,
        skipped_modules=list(analyzer.skipped_modules),
        errors=list(analyzer.errors),
        warnings=warnings + list(builder.warnings),
        usage={
            "inputTokens": llm.total_input_tokens,
            "outputTokens": llm.total_output_tokens,
        },
    )


async def build_index(
    result: ScanResult,
    *,
    config: Config | None = None,
    reuse: bool = True,
    on_progress: ProgressFn | None = None,
) -> SimpleRAG:
    """Return a retrieval index for the scan, reusing the saved one when valid.

    The index is what `repowiki_search` and the wiki's own conversation both
    query, so it is built once per scan and persisted. `sync_project` is the
    incremental path: it re-chunks only files whose sha moved.
    """
    cfg = config or Config()
    store = RagStore()
    await store.init()
    try:
        rag = await store.load(result.project_id) if reuse else None
        fresh = rag is None
        saved_sha: dict[str, str] | None = None
        if fresh:
            if result.project is None:
                # A rehydrated scan has no file contents to chunk. The index
                # is built at scan time and persisted, so reaching here means
                # the snapshot predates that — the honest answer is a rescan.
                raise ValueError(
                    f"No persisted index for '{result.project_id}'; "
                    "run repowiki_scan to rebuild it"
                )
            rag = SimpleRAG(
                k1=cfg.rag_bm25_k1,
                b=cfg.rag_bm25_b,
                max_chunk_lines=cfg.rag_chunk_max_lines,
                soft_chunk_lines=cfg.rag_chunk_soft_lines,
                overlap_lines=cfg.rag_chunk_overlap_lines,
            )
            await asyncio.to_thread(rag.index, result.project)
        else:
            # The content hashes we saved are the baseline: if nothing moved
            # after sync + wiki re-index, re-saving writes the identical
            # snapshot back to disk.
            saved_sha = dict(rag._file_sha)
            if result.project is not None:
                # Never run this on a rehydrated scan: content-less files would
                # hash to nothing and `sync_project` would read that as "every
                # file was deleted" and wipe the persisted index.
                await asyncio.to_thread(rag.sync_project, result.project)

        if cfg.rag_index_wiki:
            await asyncio.to_thread(rag.index_wiki_pages, result.wiki.pages)

        embedded = 0
        if cfg.rag_semantic:
            embedded = await _embed_missing(rag, on_progress=on_progress)
            if embedded:
                logger.info(
                    "embedded %d chunk(s) for %s", embedded, result.project_id
                )

        if fresh or embedded or rag._file_sha != saved_sha:
            await store.save(result.project_id, rag)
    finally:
        await store.close()
    return rag


async def _embed_missing(
    rag: SimpleRAG,
    *,
    batch: int = 64,
    on_progress: ProgressFn | None = None,
) -> int:
    """Vectorise every chunk that lacks one; the count actually embedded.

    Embeddings come from the host's provider — an opt-in capability, so a
    failure mid-pass keeps whatever landed and leaves the rest ``None``,
    which retrieval reads as "lexical only for these chunks". What must not
    happen is an exception reaching the caller: a plugin without an
    embedding provider still deserves its index.
    """
    pending = [i for i, v in enumerate(rag._vectors) if v is None]
    if not pending:
        return 0
    try:
        host = get_host()
    except Exception as exc:  # noqa: BLE001 — no host means no embedding, not a bug
        logger.warning("chunk embedding skipped: %s", exc)
        return 0

    done = 0
    for start in range(0, len(pending), batch):
        group = pending[start : start + batch]
        try:
            vectors = await host.embed([rag.chunks[i].content for i in group])
        except Exception as exc:  # noqa: BLE001 — stay lexical for the rest
            logger.warning("chunk embedding failed at %d/%d: %s", start, len(pending), exc)
            break
        if not isinstance(vectors, list):
            logger.warning("chunk embedding returned %s, not a list", type(vectors).__name__)
            break
        dims = rag.vector_dims
        for idx, vec in zip(group, vectors):
            if not vec:
                continue
            vec = list(vec)
            if dims and len(vec) != dims:
                # A mid-run model switch would corrupt every score; keep the
                # chunk lexical rather than mix widths.
                continue
            if not dims:
                dims = len(vec)
                rag.vector_dims = dims
            rag._vectors[idx] = vec
            done += 1
        if on_progress:
            on_progress(f"Embedded {min(start + batch, len(pending))}/{len(pending)} chunks")
    return done


def reading_order(result: ScanResult, *, top: int = 25) -> list[dict[str, Any]]:
    """The map the panel opens on: most-depended-upon files first."""
    return result.map_entries[:top]
