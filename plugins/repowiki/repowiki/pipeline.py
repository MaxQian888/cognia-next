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

import logging
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
from repowiki.host import LLMClient, WorkspaceHandle, acquire_workspace, changed_since
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
    project: ProjectContext
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
            "fileCount": len(self.project.files),
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
) -> ScanResult:
    """Acquire, ingest, analyse, build. The whole scan."""
    cfg = config or Config()
    report = on_progress or (lambda _message: None)

    report(f"Acquiring {source}")
    handle = await acquire_workspace(
        spec_for(source), max_files=cfg.max_files, max_file_size=cfg.max_file_size
    )
    warnings: list[str] = []
    if handle.truncated:
        warnings.append(f"Only the first {cfg.max_files} files were listed")
    if handle.skipped_sensitive:
        warnings.append(
            f"The host withheld {handle.skipped_sensitive} credential file(s)"
        )

    report("Reading files")
    project = ingest_handle(handle, max_file_size=cfg.max_file_size, max_files=cfg.max_files)

    report("Building the dependency graph")
    graph = DependencyGraph.build_from_project(project)
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
        if rag is None:
            rag = SimpleRAG(
                k1=cfg.rag_bm25_k1,
                b=cfg.rag_bm25_b,
                max_chunk_lines=cfg.rag_chunk_max_lines,
                soft_chunk_lines=cfg.rag_chunk_soft_lines,
                overlap_lines=cfg.rag_chunk_overlap_lines,
            )
            rag.index(result.project)
        else:
            rag.sync_project(result.project)

        if cfg.rag_index_wiki:
            rag.index_wiki_pages(result.wiki.pages)

        await store.save(result.project_id, rag)
    finally:
        await store.close()
    return rag


def reading_order(result: ScanResult, *, top: int = 25) -> list[dict[str, Any]]:
    """The map the panel opens on: most-depended-upon files first."""
    return [entry.to_dict() for entry in repo_map(result.project.files, root=result.handle.root, top=top)]
