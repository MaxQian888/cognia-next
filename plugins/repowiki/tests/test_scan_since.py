"""Incremental scans: the `since` contract, now answered by the host.

Rewritten from upstream's version, which drove four `git` subprocesses and a
FastAPI request model. Both are gone; the contract the analyzer depends on is
not, and it is the one thing worth pinning:

  an empty set means "incremental unavailable, re-analyse everything",
  never "nothing changed".

Getting that backwards would silently ship a wiki that never updates.
"""

from __future__ import annotations

import pytest

from repowiki.host import HostBridge, WorkspaceHandle, set_host
from repowiki.ingest.git_diff import changed_paths_since


class FakeHost(HostBridge):
    def __init__(self, changed=None, raises=None):
        self._changed = changed
        self._raises = raises
        self.calls: list[tuple[str, str]] = []

    async def workspace_changed_since(self, handle, ref):
        self.calls.append((handle["root"], ref))
        if self._raises:
            raise self._raises
        return self._changed


@pytest.fixture(autouse=True)
def restore_host():
    yield
    set_host(None)


def handle() -> WorkspaceHandle:
    return WorkspaceHandle(root="/repo", origin="local-path")


async def test_returns_the_hosts_changed_paths():
    host = FakeHost(["src/a.py", "src/b.py"])
    set_host(host)
    assert await changed_paths_since(handle(), "HEAD~3") == {"src/a.py", "src/b.py"}
    assert host.calls == [("/repo", "HEAD~3")]


async def test_normalises_separators_to_match_scanner_output():
    set_host(FakeHost(["src\\win.py"]))
    assert await changed_paths_since(handle(), "HEAD") == {"src/win.py"}


async def test_a_host_that_cannot_answer_degrades_to_a_full_rescan():
    # Not a git repo, no git bridge, unknown ref — all the same answer, and
    # the analyzer must read it as "re-analyse everything".
    set_host(FakeHost(raises=RuntimeError("not a repository")))
    assert await changed_paths_since(handle(), "HEAD") == set()


async def test_an_empty_ref_never_reaches_the_host():
    host = FakeHost(["src/a.py"])
    set_host(host)
    assert await changed_paths_since(handle(), "") == set()
    assert host.calls == []


async def test_returns_a_set_type():
    # Stable contract for the analyzer: it does `isdisjoint(changed_paths)`,
    # which requires a set/frozenset.
    set_host(FakeHost([]))
    assert isinstance(await changed_paths_since(handle(), "HEAD"), set)
