"""Project identity: the key everything durable hangs off.

Rewritten from upstream's ``test_scan_project_id.py``, which drove the FastAPI
scan router this port does not ship. The property it pinned is unchanged and
still load-bearing: the analyzer cache, the on-disk RAG snapshot and the wiki's
row in the host's projection are all keyed by this id, so a random-per-scan id
would orphan the snapshot every run and make the incremental path dead code.
"""

from __future__ import annotations

from repowiki.project import project_id_for


def test_project_id_is_stable_for_same_path(tmp_path):
    assert project_id_for({"path": str(tmp_path)}) == project_id_for({"path": str(tmp_path)})


def test_project_id_differs_across_paths(tmp_path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    assert project_id_for({"path": str(a)}) != project_id_for({"path": str(b)})


def test_project_id_canonicalises_relative_and_absolute(tmp_path, monkeypatch):
    # Relative and absolute forms of the same target must collide so the
    # snapshot is reused regardless of which form the user typed.
    monkeypatch.chdir(tmp_path)
    sub = tmp_path / "demo"
    sub.mkdir()
    assert project_id_for({"path": str(sub)}) == project_id_for({"path": "demo"})


def test_project_id_is_short_hex():
    pid = project_id_for({"path": "/tmp/whatever"})
    assert len(pid) == 8
    int(pid, 16)  # raises if not hex


def test_project_id_uses_url_when_no_path():
    a = project_id_for({"url": "https://github.com/foo/bar"})
    b = project_id_for({"url": "https://github.com/foo/baz"})
    assert a != b
    assert a == project_id_for({"url": "https://github.com/foo/bar"})


def test_project_id_canonicalises_equivalent_remote_sources():
    expected = project_id_for({"url": "https://github.com/foo/repo.name"})
    assert expected == project_id_for({"url": "github.com/foo/repo.name.git"})
    assert expected == project_id_for({"url": "foo/repo.name"})


def test_bare_string_routes_by_shape():
    # The panel and the tools take whatever the user typed; a remote must not
    # be mistaken for a relative path (which would abspath it against cwd).
    assert project_id_for("foo/repo") == project_id_for({"url": "foo/repo"})
    assert project_id_for("/tmp/whatever") == project_id_for({"path": "/tmp/whatever"})


def test_anonymous_source_still_yields_an_id():
    assert len(project_id_for({})) == 8
