from __future__ import annotations

import pytest

from repowiki.core.models import ProjectContext
from repowiki.host import HostBridge, set_host
from repowiki.ingest import github


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("owner/repo", ("github.com", "owner", "repo")),
        ("https://github.com/owner/repo.name", ("github.com", "owner", "repo.name")),
        ("https://github.com/owner/repo.git", ("github.com", "owner", "repo")),
        ("git@gitlab.com:owner/repo.git", ("gitlab.com", "owner", "repo")),
        ("https://bitbucket.org/owner/repo/src/main", ("bitbucket.org", "owner", "repo")),
    ],
)
def test_parse_git_url_accepts_supported_repository_forms(source, expected):
    assert github.parse_git_url(source) == expected


@pytest.mark.parametrize(
    "source",
    [
        "https://evil.example/github.com/owner/repo",
        "https://github.com/../repo",
        "https://github.com/owner/..",
        "file:///tmp/repo",
    ],
)
def test_parse_git_url_rejects_lookalikes_and_traversal(source):
    assert github.parse_git_url(source) is None


class FakeHost(HostBridge):
    """Records what the plugin asked the host for, and answers it."""

    def __init__(self, *, entries=None, truncated=False, skipped=0, root="/cache/owner/repo"):
        self.acquired: list[dict] = []
        self.walked: list[dict] = []
        self._entries = entries if entries is not None else ["README.md"]
        self._truncated = truncated
        self._skipped = skipped
        self._root = root

    async def workspace_acquire(self, spec):
        self.acquired.append(spec)
        return {
            "root": self._root,
            "origin": "clone",
            "ephemeral": True,
            "remote": {"host": "github.com", "owner": "owner", "repo": "repo"},
        }

    async def workspace_walk(self, handle, options):
        self.walked.append({"handle": handle, "options": options})
        return {
            "entries": self._entries,
            "truncated": self._truncated,
            "skippedSensitive": self._skipped,
        }


@pytest.fixture(autouse=True)
def restore_host():
    yield
    set_host(None)


async def test_the_host_is_asked_for_the_canonical_clone_url(monkeypatch):
    # Upstream shelled out to `git clone` here, into ~/.repowiki/repos, with
    # its own timeout / size cap / host allow-list. All four moved to the host,
    # so what this must prove is that the plugin asks for the *canonical* form
    # — otherwise `owner/repo` and `github.com/owner/repo.git` would clone into
    # two different directories.
    host = FakeHost()
    set_host(host)
    expected = ProjectContext(name="repo", root="/cache/owner/repo")
    monkeypatch.setattr(github, "ingest_handle", lambda *args, **kwargs: expected)

    result = await github.ingest_github("owner/repo")

    assert result is expected
    assert host.acquired == [{"kind": "git-url", "url": "https://github.com/owner/repo.git"}]


async def test_a_non_github_host_must_be_named_explicitly(monkeypatch):
    # The host's default allow-list is github.com. A gitlab source this parser
    # accepts has to be requested, not assumed — otherwise the clone is refused
    # host-side with an error the user cannot act on.
    host = FakeHost()
    set_host(host)
    monkeypatch.setattr(github, "ingest_handle", lambda *a, **k: ProjectContext(name="r", root="/x"))

    await github.ingest_github("git@gitlab.com:owner/repo.git")

    assert host.acquired[0]["allowedHosts"] == ["gitlab.com"]


async def test_only_the_files_the_host_listed_are_ingested(monkeypatch):
    host = FakeHost(entries=["src/a.py", {"path": "src/b.py"}])
    set_host(host)
    seen: dict = {}

    def capture(handle, **kwargs):
        seen["paths"] = handle.paths
        return ProjectContext(name="repo", root=handle.root)

    monkeypatch.setattr(github, "ingest_handle", capture)
    await github.ingest_github("owner/repo")

    # Both spellings the walk can return — a bare string and an entry object.
    assert seen["paths"] == ["src/a.py", "src/b.py"]


async def test_a_truncated_or_censored_walk_is_reported_not_hidden(monkeypatch):
    # A wiki built from half a repository, or from one with its credential
    # files removed, is still a useful wiki — but the user has to be told, or
    # they will read a gap as "this code does not exist".
    host = FakeHost(truncated=True, skipped=2)
    set_host(host)
    monkeypatch.setattr(github, "ingest_handle", lambda *a, **k: ProjectContext(name="r", root="/x"))
    warnings: list[str] = []

    await github.ingest_github("owner/repo", max_files=10, on_warning=warnings.append)

    assert any("first 10 files" in w for w in warnings)
    assert any("credential file" in w for w in warnings)


async def test_an_unparsable_source_never_reaches_the_host():
    host = FakeHost()
    set_host(host)
    with pytest.raises(ValueError):
        await github.ingest_github("file:///tmp/repo")
    assert host.acquired == []
