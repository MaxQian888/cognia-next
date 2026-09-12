"""The semantic layer: chunk vectors as a third retrieval signal.

TF-IDF and BM25 match the words a question literally uses. ``query_vector``
is what lets a paraphrase find code it never names — and every failure mode
(no provider, wrong dims, partial pass) must degrade to the lexical answer,
never to an error.
"""

from __future__ import annotations

import main
import pytest
from repowiki.core.models import FileInfo, ProjectContext
from repowiki.core.rag import SimpleRAG, _dense_cosine
from repowiki.core.rag_store import SCHEMA_VERSION, RagStore
from repowiki.host import HostBridge, WorkspaceHandle, configure_paths, set_host
from repowiki.pipeline import ScanResult, build_index


def _rag() -> SimpleRAG:
    project = ProjectContext(
        name="t",
        root=".",
        files=[
            FileInfo(
                path="src/auth.py", size=10, language="python", lines=2,
                content="def authenticate_user(uid):\n    return uid\n",
            ),
            FileInfo(
                path="src/view.py", size=10, language="python", lines=2,
                content="def render_dashboard():\n    return 'ok'\n",
            ),
        ],
    )
    rag = SimpleRAG()
    rag.index(project)
    return rag


def test_a_semantic_hit_surfaces_without_any_shared_tokens():
    rag = _rag()
    # "dashboard" shares no vocabulary with the query; only the vector can
    # carry it.
    vectors = [None] * len(rag.chunks)
    view_idx = next(
        i for i, c in enumerate(rag.chunks) if c.file_path == "src/view.py"
    )
    vectors[view_idx] = [1.0, 0.0, 0.0]
    auth_idx = next(
        i for i, c in enumerate(rag.chunks) if c.file_path == "src/auth.py"
    )
    vectors[auth_idx] = [0.0, 1.0, 0.0]
    rag.set_vectors(vectors, dims=3)

    hits = rag.retrieve(
        "zzz-nothing-matches-this", query_vector=[0.9, 0.1, 0.0]
    )
    assert hits and hits[0].file_path == "src/view.py"


def test_a_wrong_width_query_vector_is_refused_not_scored():
    rag = _rag()
    rag.set_vectors([[0.1] * 8] * len(rag.chunks), dims=8)
    hits = rag.retrieve("authenticate", query_vector=[0.9, 0.1])
    # Lexical still answered; the mismatched vector added nothing.
    assert hits and hits[0].file_path == "src/auth.py"


def test_lexical_scores_do_not_pay_the_vector_tax_when_index_is_lexical():
    rag = _rag()
    lexical = rag.retrieve("authenticate")
    rag2 = _rag()
    rag2.set_vectors([None] * len(rag2.chunks))
    vecless = rag2.retrieve("authenticate", query_vector=[0.5, 0.5])
    # vector_dims stays 0 when nothing is embedded, so the divisor is still 2.
    assert lexical[0].score == pytest.approx(vecless[0].score)


def test_set_vectors_requires_chunk_alignment():
    rag = _rag()
    with pytest.raises(ValueError, match="alignment|length"):
        rag.set_vectors([[0.1, 0.2]])


def test_dense_cosine_basics():
    assert _dense_cosine([1, 0], [1, 0]) == pytest.approx(1.0)
    assert _dense_cosine([1, 0], [0, 1]) == pytest.approx(0.0)
    assert _dense_cosine([0, 0], [1, 1]) == 0.0


async def test_store_round_trips_vectors(tmp_path):
    rag = _rag()
    rag.set_vectors([[0.1, 0.2, 0.3]] * len(rag.chunks), dims=3)
    store = RagStore(tmp_path / "idx.db")
    await store.init()
    try:
        await store.save("p1", rag)
        restored = await store.load("p1")
    finally:
        await store.close()
    assert restored is not None
    assert restored.vector_dims == 3
    assert restored._vectors[0] == pytest.approx([0.1, 0.2, 0.3])
    # And retrieval still fuses after the round trip.
    hits = restored.retrieve("zz", query_vector=[0.1, 0.2, 0.3])
    assert hits


async def test_store_drops_v2_rows_instead_of_misreading_them(tmp_path, monkeypatch):
    store = RagStore(tmp_path / "idx.db")
    await store.init()
    try:
        await store.save("p1", _rag())
        await store._db.execute(
            "UPDATE rag_meta SET schema_version = ? WHERE project_id = ?",
            (SCHEMA_VERSION - 1, "p1"),
        )
        await store._db.commit()
        assert await store.load("p1") is None
    finally:
        await store.close()


class FakeEmbedHost(HostBridge):
    """An embed that maps each text to a 2-d point: 'auth'→x, else→y."""

    def __init__(self, *, fail: bool = False):
        self._fail = fail
        self.calls: list[list[str]] = []

    async def embed(self, texts, options=None):
        self.calls.append(list(texts))
        if self._fail:
            raise RuntimeError("no embedding provider")
        return [
            [1.0, 0.0] if "auth" in text else [0.0, 1.0] for text in texts
        ]


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


async def test_build_index_embeds_and_search_uses_the_vector(tmp_path):
    host = FakeEmbedHost()
    set_host(host)
    result = ScanResult(
        project_id="deadbeef",
        wiki=__import__("repowiki.core.wiki_builder", fromlist=["Wiki"]).Wiki(
            project_name="demo", pages=[]
        ),
        handle=WorkspaceHandle(root="/repo", origin="local-path", head_ref="abc"),
        project=ProjectContext(
            name="demo", root="/repo",
            files=[
                FileInfo(path="src/auth.py", size=10, language="python", lines=1,
                         content="def authenticate_user(): pass"),
            ],
        ),
        source="/repo",
    )
    rag = await build_index(result)
    assert rag.vector_dims == 2
    assert host.calls, "the embed pass never ran"
    # A query vector close to x-axis pulls the auth chunk even through
    # a query that shares few tokens.
    main._SCANS["deadbeef"] = result
    main._INDEXES["deadbeef"] = rag
    out = await main.repowiki_search("deadbeef", "auth")
    assert out["citations"]


async def test_build_index_survives_an_embed_that_fails(tmp_path):
    set_host(FakeEmbedHost(fail=True))
    result = ScanResult(
        project_id="deadbeef",
        wiki=__import__("repowiki.core.wiki_builder", fromlist=["Wiki"]).Wiki(
            project_name="demo", pages=[]
        ),
        handle=WorkspaceHandle(root="/repo", origin="local-path", head_ref="abc"),
        project=ProjectContext(
            name="demo", root="/repo",
            files=[
                FileInfo(path="src/auth.py", size=10, language="python", lines=1,
                         content="def authenticate_user(): pass"),
            ],
        ),
        source="/repo",
    )
    rag = await build_index(result)
    assert rag.vector_dims == 0
    # Lexical retrieval still answers.
    assert rag.retrieve("authenticate")
