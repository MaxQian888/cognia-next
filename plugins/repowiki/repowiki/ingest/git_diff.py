"""Resolve a git ref into the set of changed file paths.

Upstream ran four ``git`` subprocesses here. The host answers the same question
through ``ctx.workspace.changedSince``, which is the version that also works
when the checkout is one the host cloned on our behalf and we hold no path to
a ``.git`` directory of our own.

The empty set still means "incremental mode unavailable, re-analyse
everything" — that contract is what the analyzer's `--since` path is built on,
so a host that cannot answer degrades rather than fails.
"""

from __future__ import annotations

import logging

from repowiki.host import WorkspaceHandle, changed_since

logger = logging.getLogger(__name__)


async def changed_paths_since(handle: WorkspaceHandle, ref: str) -> set[str]:
    """Return repo-relative paths that differ between ``ref`` and the checkout.

    Returns an empty set when the host cannot answer — no git bridge, not a
    repository, an unknown ref. Callers must treat that as "fall back to a full
    re-analysis" rather than as "nothing changed".
    """
    if not ref:
        return set()
    try:
        return await changed_since(handle, ref)
    except Exception as exc:  # noqa: BLE001 — degrade, never abort the scan
        logger.warning("changedSince(%s) failed: %s", ref, exc)
        return set()
