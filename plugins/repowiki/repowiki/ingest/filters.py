"""Include/exclude rules for what a scan reads.

The shape is borrowed from DeepWiki-Open's ``iterate_files`` filters — dirs
and file glob patterns, in both polarities — with matching rules that stay
predictable:

- a *dir* entry is a bare name (``"vendor"`` — any path segment) or a
  repo-relative path prefix (``"tests/fixtures"``); a file is filtered when
  its path sits at or under it
- a *file* entry is an ``fnmatch`` glob tried against both the full
  repo-relative path and the basename, so ``"*.min.js"`` and
  ``"src/gen/**"`` both work
- ``included_*`` are a whitelist: when either is non-empty, a file survives
  only by matching one of them; exclusions are applied first and still win
  over inclusions
"""

from __future__ import annotations

import fnmatch
from collections.abc import Callable, Iterable


def _norm_dirs(entries: Iterable[str] | None) -> tuple[list[str], list[str]]:
    """Split dir entries into (bare names, path prefixes)."""
    names: list[str] = []
    prefixes: list[str] = []
    for entry in entries or []:
        cleaned = entry.strip().replace("\\", "/").strip("/")
        if not cleaned:
            continue
        (prefixes if "/" in cleaned else names).append(cleaned)
    return names, prefixes


def _norm_globs(entries: Iterable[str] | None) -> list[str]:
    return [e.strip() for e in entries or [] if e.strip()]


def _matches_glob(path: str, patterns: list[str]) -> bool:
    basename = path.rsplit("/", 1)[-1]
    return any(
        fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(basename, pattern)
        for pattern in patterns
    )


def _under_dir(path: str, names: list[str], prefixes: list[str]) -> bool:
    if any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes):
        return True
    # A bare name matches any directory segment, never the file itself.
    return any(segment in names for segment in path.split("/")[:-1])


def build_path_filter(
    *,
    included_dirs: list[str] | None = None,
    included_files: list[str] | None = None,
    excluded_dirs: list[str] | None = None,
    excluded_files: list[str] | None = None,
) -> Callable[[str], bool] | None:
    """A predicate over repo-relative paths, or ``None`` when nothing is set.

    ``None`` — not an always-true function — so the call site can skip the
    pass entirely and stays able to tell "user filtered" from "everything
    survived".
    """
    exc_names, exc_prefixes = _norm_dirs(excluded_dirs)
    exc_globs = _norm_globs(excluded_files)
    inc_names, inc_prefixes = _norm_dirs(included_dirs)
    inc_globs = _norm_globs(included_files)

    if not (exc_names or exc_prefixes or exc_globs or inc_names or inc_prefixes or inc_globs):
        return None

    whitelisting = bool(inc_names or inc_prefixes or inc_globs)

    def keep(path: str) -> bool:
        p = path.replace("\\", "/").lstrip("/")
        if _under_dir(p, exc_names, exc_prefixes) or _matches_glob(p, exc_globs):
            return False
        if whitelisting:
            return _under_dir(p, inc_names, inc_prefixes) or _matches_glob(p, inc_globs)
        return True

    return keep
