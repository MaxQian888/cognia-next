"""The inspection tools: pages, status, deps, file_chunks, scoped search.

Each exists because the shipped tools could not answer the question: which
page ids exist after a restart, can this project be searched, what imports
this file, and what did the index keep for a path. They are all read-only —
the plan-mode surface stays the plan-mode surface.
"""

from __future__ import annotations

import main
import pytest
from repowiki.core.graph import DependencyGraph
from repowiki.core.models import FileInfo, ProjectContext
from repowiki.core.wiki_builder import Wiki, WikiPage
from repowiki.core.wiki_store import WikiStore
from repowiki.host import HostBridge, WorkspaceHandle, configure_paths, set_host
from repowiki.pipeline import ScanResult


class FakeHost(HostBridge):
    def __init__(self, *, changed=None):
        self._changed = changed or []

    async def workspace_changed_since(self, handle, ref):
        return self._changed


def _seed(*, with_graph: bool = True) -> ScanResult:
    """A live scan: real file contents, a two-page wiki, a one-edge graph."""
    project = ProjectContext(
        name="demo",
        root="/repo",
        files=[
            FileInfo(
                path="core/store.py",
                size=30,
                language="python",
                lines=2,
                content="def save():\n    return 1\n",
            ),
            FileInfo(
                path="core/engine.py",
                size=60,
                language="python",
                lines=3,
                content="from .store import save\n\ndef run():\n    return save()\n",
            ),
        ],
    )
    graph = None
    if with_graph:
        graph = DependencyGraph()
        graph.graph.add_node("core/store.py", language="python", lines=2)
        graph.graph.add_node("core/engine.py", language="python", lines=3)
        graph.graph.add_node("README.md")
        graph.graph.add_edge("core/engine.py", "core/store.py")
        graph._file_paths = {"core/store.py", "core/engine.py", "README.md"}
    return ScanResult(
        project_id="deadbeef",
        wiki=Wiki(
            project_name="demo",
            pages=[
                WikiPage(id="index", title="Overview", content="# demo"),
                WikiPage(
                    id="modules/core",
                    title="core",
                    content="the core module",
                    parent_id="index",
                    order=1,
                ),
            ],
        ),
        handle=WorkspaceHandle(root="/repo", origin="local-path", head_ref="abc"),
        project=project,
        source="/repo",
        graph=graph,
        file_count=3,
    )


@pytest.fixture(autouse=True)
def clean_state(tmp_path, monkeypatch):
    configure_paths(tmp_path / "plugin-data")
    monkeypatch.setattr(main, "get_config", dict)
    main._SCANS.clear()
    main._INDEXES.clear()
    main._FRESHNESS.clear()
    yield
    main._SCANS.clear()
    main._INDEXES.clear()
    main._FRESHNESS.clear()
    set_host(None)
    configure_paths(None)


# ---------- repowiki_pages ----------


def test_pages_lists_the_outline_after_the_scan_summary_is_gone():
    main._SCANS["deadbeef"] = _seed()

    out = main.repowiki_pages("deadbeef")

    assert [(p["id"], p["parentId"]) for p in out["pages"]] == [
        ("index", ""),
        ("modules/core", "index"),
    ]


# ---------- repowiki_status ----------


async def test_status_reports_absent_persisted_and_ready_indexes(tmp_path):
    set_host(FakeHost())
    result = _seed()
    main._SCANS["deadbeef"] = result

    out = await main.repowiki_status("deadbeef")
    assert out["index"]["state"] == "none"
    assert out["index"]["chunkCount"] is None
    assert out["live"] is True
    assert out["pageCount"] == 2

    # build_index persists as it builds — moving the index out of memory
    # leaves the on-disk snapshot behind.
    rag = await main._ensure_index(result, main._config())
    main._INDEXES.clear()
    out = await main.repowiki_status("deadbeef")
    assert out["index"]["state"] == "persisted"
    assert out["index"]["chunkCount"] == len(rag.chunks)

    main._INDEXES["deadbeef"] = rag
    out = await main.repowiki_status("deadbeef")
    assert out["index"]["state"] == "ready"
    assert out["index"]["chunkCount"] == len(rag.chunks)
    assert out["freshness"]["known"] is True
    assert out["freshness"]["stale"] is False


async def test_status_never_builds_an_index_to_answer(tmp_path, monkeypatch):
    """The probe must stay a probe: status that built an index would be the
    most expensive read in the surface."""
    set_host(FakeHost())
    main._SCANS["deadbeef"] = _seed()

    async def explode(result, **kwargs):
        raise AssertionError("status built an index")

    monkeypatch.setattr(main, "build_index", explode)
    out = await main.repowiki_status("deadbeef")
    assert out["index"]["state"] == "none"


# ---------- repowiki_deps ----------


def test_deps_answers_the_blast_radius_question():
    main._SCANS["deadbeef"] = _seed()

    downstream = main.repowiki_deps("deadbeef", "core/store.py")
    assert downstream["imports"] == []
    assert downstream["importedBy"] == ["core/engine.py"]

    upstream = main.repowiki_deps("deadbeef", "core/engine.py")
    assert upstream["imports"] == ["core/store.py"]
    assert upstream["importedBy"] == []


def test_deps_summary_reports_the_graphs_shape():
    main._SCANS["deadbeef"] = _seed()

    out = main.repowiki_deps("deadbeef")

    assert out["fileCount"] == 3
    assert out["edgeCount"] == 1
    assert out["isolatedFiles"]["paths"] == ["README.md"]
    assert "core/engine.py" in out["entryPoints"]["paths"]
    assert out["cycles"] == []


def test_deps_on_a_snapshot_without_a_graph_says_so():
    main._SCANS["deadbeef"] = _seed(with_graph=False)

    with pytest.raises(ValueError, match="dependency graph"):
        main.repowiki_deps("deadbeef")


def test_deps_unknown_path_suggests_the_near_miss():
    main._SCANS["deadbeef"] = _seed()

    with pytest.raises(ValueError, match="Did you mean: core/store.py"):
        main.repowiki_deps("deadbeef", "store.py")


async def test_the_graph_survives_a_wiki_snapshot_roundtrip(tmp_path):
    """A rehydrated project has no file contents but keeps the edges —
    'what imports X' stays answerable across restarts."""
    set_host(FakeHost())
    main._SCANS["deadbeef"] = _seed()

    store = WikiStore()
    await store.init()
    try:
        await store.save(main._SCANS["deadbeef"])
        loaded = await store.load_all()
    finally:
        await store.close()

    restored = next(r for r in loaded if r.project_id == "deadbeef")
    assert restored.project is None
    assert restored.graph is not None
    assert restored.graph.graph.has_edge("core/engine.py", "core/store.py")

    main._SCANS["deadbeef"] = restored
    out = main.repowiki_deps("deadbeef", "core/store.py")
    assert out["importedBy"] == ["core/engine.py"]


# ---------- repowiki_file_chunks ----------


async def test_file_chunks_reads_what_the_index_holds_verbatim():
    set_host(FakeHost())
    main._SCANS["deadbeef"] = _seed()

    out = await main.repowiki_file_chunks("deadbeef", "core/store.py")

    assert out["chunks"], "the indexed file must produce chunks"
    assert all(c["kind"] == "code" for c in out["chunks"])
    assert "def save" in out["chunks"][0]["content"]
    assert out["chunks"][0]["startLine"] >= 1


async def test_file_chunks_for_a_path_the_index_lacks_names_it():
    set_host(FakeHost())
    main._SCANS["deadbeef"] = _seed()

    with pytest.raises(ValueError, match="not in the search index"):
        await main.repowiki_file_chunks("deadbeef", "nope.py")


async def test_file_chunks_leading_dot_paths_are_not_eaten(tmp_path):
    """``.github/`` is a legitimate repo path — normalisation strips a
    ``./`` prefix, not the leading dot of a dot-directory."""
    set_host(FakeHost())
    result = _seed()
    result.project.files.append(
        FileInfo(
            path=".github/workflows/ci.yml",
            size=20,
            language="yaml",
            lines=2,
            content="on: push\n",
        )
    )
    main._SCANS["deadbeef"] = result

    out = await main.repowiki_file_chunks("deadbeef", "./.github/workflows/ci.yml")
    assert out["path"] == ".github/workflows/ci.yml"
    assert out["chunks"]


# ---------- scoped repowiki_search ----------


async def test_search_scope_wiki_returns_only_page_chunks():
    set_host(FakeHost())
    main._SCANS["deadbeef"] = _seed()

    out = await main.repowiki_search("deadbeef", "demo core module", scope="wiki")

    assert out["citations"], "the wiki page should be a scoped hit"
    assert all(c["kind"] == "wiki" for c in out["citations"])


async def test_search_scope_code_excludes_wiki_pages():
    set_host(FakeHost())
    main._SCANS["deadbeef"] = _seed()

    out = await main.repowiki_search("deadbeef", "demo core module", scope="code")

    assert out["citations"] == []


async def test_search_path_glob_narrows_to_matching_files():
    set_host(FakeHost())
    main._SCANS["deadbeef"] = _seed()

    out = await main.repowiki_search("deadbeef", "save", pathGlob="core/store.py")
    assert out["citations"]
    assert all(c["path"] == "core/store.py" for c in out["citations"])

    # The basename form matches like the scan's own file globs.
    out = await main.repowiki_search("deadbeef", "save", pathGlob="store.py")
    assert out["citations"]
    assert all(c["path"] == "core/store.py" for c in out["citations"])


async def test_search_rejects_an_unknown_scope():
    set_host(FakeHost())
    main._SCANS["deadbeef"] = _seed()

    with pytest.raises(ValueError, match="Unknown scope"):
        await main.repowiki_search("deadbeef", "save", scope="bogus")
