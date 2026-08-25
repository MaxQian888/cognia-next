"""Project identity and the LLM-free repo map.

Two pieces that upstream kept in surfaces this port dropped — the FastAPI scan
router and the Click CLI — but whose behaviour the plugin still needs, and
whose tests were worth keeping rather than deleting along with their hosts.

* :func:`project_id_for` is what keys everything durable: the analyzer cache,
  the RAG snapshot on disk, and the wiki's row in the host's projection. It has
  to be a pure function of the *source*, because a random id per scan would
  orphan the snapshot on every run and quietly make the incremental path dead
  code.
* :func:`repo_map` is the ranked file list, PageRank over the real import
  graph. Zero model calls, so it is the cheapest useful thing this plugin can
  hand an agent, and it is what the panel's reading order is built from.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Any

from repowiki.core.graph import DependencyGraph
from repowiki.core.models import FileInfo, ProjectContext
from repowiki.ingest.github import canonical_git_url


def project_id_for(source: dict[str, Any] | str) -> str:
    """Derive a stable 8-hex-char id from a repository source.

    Accepts either a spec dict (``{"url": …}`` or ``{"path": …}``) or a bare
    string, which is read as a URL when it parses as one and a path otherwise.
    A remote is canonicalised first, so ``foo/bar``, ``github.com/foo/bar.git``
    and ``https://github.com/foo/bar`` all land on the same id — otherwise the
    same repository would get a fresh cache every time the user typed it a
    different way.
    """
    if isinstance(source, str):
        canonical = canonical_git_url(source)
        source = {"url": source} if canonical else {"path": source}

    url = (source.get("url") or "").strip()
    if url:
        key = canonical_git_url(url) or url
    else:
        path = (source.get("path") or "").strip()
        key = os.path.abspath(path) if path else "anonymous"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:8]


@dataclass
class RepoMapEntry:
    rank: int
    path: str
    score: float
    language: str
    lines: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "rank": self.rank,
            "path": self.path,
            "score": self.score,
            "language": self.language,
            "lines": self.lines,
        }


def repo_map(files: list[FileInfo], *, root: str = "", top: int = 50) -> list[RepoMapEntry]:
    """Rank files by dependency PageRank. No model calls.

    Paths are published in forward-slash form regardless of platform: the
    output is destined for prompts and for the panel, and a backslash there
    reads as an escape rather than a separator.
    """
    if top <= 0:
        raise ValueError("top must be greater than zero")

    project = ProjectContext(name=root or "project", root=root, files=files)
    ranked = DependencyGraph.build_from_project(project).rank_files()
    by_path = {f.path: f for f in files}

    entries: list[RepoMapEntry] = []
    for index, (path, score) in enumerate(ranked[:top]):
        info = by_path.get(path)
        entries.append(
            RepoMapEntry(
                rank=index + 1,
                path=path.replace(os.sep, "/"),
                score=round(score, 6),
                language=info.language if info else "unknown",
                lines=info.lines if info else 0,
            )
        )
    return entries
