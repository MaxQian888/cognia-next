"""Resolve a remote repository reference into a checkout.

Upstream shelled out to ``git clone`` itself, into ``~/.repowiki/repos``, with
its own timeout, size cap and host allow-list. All four of those guard rails
moved into the host (ADR-0145's ``git_clone_guarded``), where they apply to
every plugin rather than to whichever one remembered to write them — so what
remains here is the *parsing*, which is pure, well-tested, and still ours.

:func:`ingest_github` is now async and asks ``ctx.workspace`` for the checkout.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from urllib.parse import unquote, urlsplit

from repowiki.core.models import ProjectContext
from repowiki.host import acquire_workspace
from repowiki.ingest.local import ingest_handle

logger = logging.getLogger(__name__)

#: Advisory: the host enforces its own allow-list on the clone. Keeping the
#: list here lets `parse_git_url` reject an unsupported source before a round
#: trip, and keeps the upstream parser tests meaningful.
_ALLOWED_HOSTS = frozenset({"github.com", "gitlab.com", "bitbucket.org"})
_REPOSITORY_PART_RE = re.compile(r"[A-Za-z0-9_.-]+")


def parse_git_url(url: str) -> tuple[str, str, str] | None:
    """Extract a canonical ``(host, owner, repo)`` from a supported source."""
    source = url.strip().rstrip("/")
    if not source:
        return None

    if source.startswith("git@"):
        match = re.fullmatch(r"git@([^:]+):([^/]+)/([^/]+?)(?:\.git)?", source)
        if not match:
            return None
        host, owner, repo = match.groups()
    else:
        if "://" not in source:
            parts = source.split("/")
            if len(parts) == 2:
                source = f"https://github.com/{source}"
            elif parts and parts[0].lower() in _ALLOWED_HOSTS:
                source = f"https://{source}"
            else:
                return None

        parsed = urlsplit(source)
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
            return None
        host = (parsed.hostname or "").lower()
        path_parts = [unquote(part) for part in parsed.path.split("/") if part]
        if len(path_parts) < 2:
            return None
        owner, repo = path_parts[:2]
        if repo.endswith(".git"):
            repo = repo[:-4]

    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    if host not in _ALLOWED_HOSTS:
        return None
    if any(
        part in ("", ".", "..") or not _REPOSITORY_PART_RE.fullmatch(part)
        for part in (owner, repo)
    ):
        return None
    return host, owner, repo


def _clone_url(url: str) -> str:
    """normalize a URL to a proper git clone URL."""
    parsed = parse_git_url(url)
    if not parsed:
        return url  # let git figure it out
    host, owner, repo = parsed
    return f"https://{host}/{owner}/{repo}.git"


def canonical_git_url(url: str) -> str | None:
    """Return the stable HTTPS clone URL used for IDs and cache keys."""
    parsed = parse_git_url(url)
    if not parsed:
        return None
    host, owner, repo = parsed
    return f"https://{host}/{owner}/{repo}.git"


async def ingest_github(
    url: str,
    max_file_size: int = 200 * 1024,
    max_files: int = 1000,
    force_reclone: bool = False,
    on_progress: Callable[[str], None] | None = None,
    on_warning: Callable[[str], None] | None = None,
) -> ProjectContext:
    """Ask the host for a checkout of ``url`` and ingest it.

    ``force_reclone`` is honoured by releasing the cached checkout first; the
    host then clones fresh. The progress/warning callbacks are kept so the
    caller's UI wiring is unchanged, and now report host-side outcomes.
    """
    parsed = parse_git_url(url)
    if not parsed:
        raise ValueError(f"Can't parse git URL: {url}")

    host, owner, repo = parsed
    canonical = f"https://{host}/{owner}/{repo}.git"
    if on_progress:
        on_progress(f"Acquiring {owner}/{repo}")

    spec: dict = {"kind": "git-url", "url": canonical}
    if host not in ("github.com",):
        # The host's own default allow-list is github.com; anything else this
        # parser accepts has to be named explicitly rather than assumed.
        spec["allowedHosts"] = [host]
    if force_reclone:
        spec["forceReclone"] = True

    handle = await acquire_workspace(
        spec, max_files=max_files, max_file_size=max_file_size
    )
    if handle.truncated and on_warning:
        on_warning(f"Only the first {max_files} files of {owner}/{repo} were listed")
    if handle.skipped_sensitive and on_warning:
        on_warning(
            f"The host withheld {handle.skipped_sensitive} credential file(s) in {owner}/{repo}"
        )

    project = ingest_handle(handle, max_file_size=max_file_size, max_files=max_files)
    project.name = project.name or repo
    return project
