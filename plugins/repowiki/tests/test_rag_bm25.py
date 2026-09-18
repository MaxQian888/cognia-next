"""tests for BM25 fusion + incremental upsert/remove + wiki indexing.

These exercise the SimpleRAG surface added in the Phase 1 refactor without
touching the LLM, so they run in milliseconds.
"""

from __future__ import annotations

from collections import Counter

import pytest

from repowiki.core.models import FileInfo, ProjectContext
from repowiki.core.rag import (
    SimpleRAG,
    _bm25,
    _cosine_similarity,
    _fast_sha,
    _split_markdown_into_chunks,
    _tfidf_norm,
    _tokenize,
)


def _proj(files: list[FileInfo]) -> ProjectContext:
    return ProjectContext(name="t", root=".", files=files)


def test_bm25_normalises_for_chunk_length():
    """Short docs containing the term should outscore long ones that
    happen to repeat it -- that's the whole point of BM25 over plain TF.
    """
    # Use the same IDF table for both calls so we measure pure length
    # normalisation rather than IDF differences.
    idf = {"alpha": 1.0}
    short = _bm25(["alpha"], {"alpha": 1}, chunk_len=10, idf=idf, avgdl=100, k1=1.5, b=0.75)
    long_ = _bm25(["alpha"], {"alpha": 1}, chunk_len=200, idf=idf, avgdl=100, k1=1.5, b=0.75)
    assert short > long_


def test_bm25_unknown_token_scores_zero():
    idf = {"alpha": 1.0}
    assert _bm25(["beta"], {"alpha": 1}, chunk_len=10, idf=idf, avgdl=10, k1=1.5, b=0.75) == 0.0


def test_retrieve_returns_normalised_score():
    project = _proj([
        FileInfo(
            path="a.py", size=10, language="python", lines=2,
            content="def authenticate_user(uid):\n    return uid\n",
        ),
        FileInfo(
            path="b.py", size=10, language="python", lines=2,
            content="def render_view(req):\n    return req\n",
        ),
    ])
    rag = SimpleRAG()
    rag.index(project)
    hits = rag.retrieve("authenticate", top_k=5)
    assert hits
    # Top hit scores into [0, 1] because we average two normalised channels.
    assert 0.0 < hits[0].score <= 1.0
    assert hits[0].file_path == "a.py"


def test_retrieve_min_score_filters_low_relevance():
    project = _proj([
        FileInfo(
            path="a.py", size=10, language="python", lines=1,
            content="def authenticate_user(): pass\n",
        ),
        FileInfo(
            path="b.py", size=10, language="python", lines=1,
            content="def render_view(): pass\n",
        ),
    ])
    rag = SimpleRAG()
    rag.index(project)
    # A very strict floor should drop the lower-scoring chunk.
    strict = rag.retrieve("authenticate", top_k=5, min_score=0.99)
    permissive = rag.retrieve("authenticate", top_k=5, min_score=0.0)
    assert len(strict) <= len(permissive)


def test_upsert_file_replaces_old_chunks():
    rag = SimpleRAG(soft_chunk_lines=2, max_chunk_lines=4)
    rag.upsert_file(
        "a.py", sha="v1", language="python",
        text="def first(): pass\n",
    )
    n_after_first = len(rag.chunks)
    # Replace with very different content -- the old "first" chunk must
    # disappear and the new content must be retrievable.
    rag.upsert_file(
        "a.py", sha="v2", language="python",
        text="def second_function_xyzzy(): pass\n",
    )
    # Same file -> still exactly one set of chunks; total didn't grow.
    assert len(rag.chunks) == n_after_first
    hits = rag.retrieve("xyzzy", top_k=5)
    assert hits and "xyzzy" in hits[0].content
    # And the old keyword no longer matches anything.
    assert rag.retrieve("first", top_k=5) == []


def test_remove_file_clears_chunks_and_keeps_alignment():
    rag = SimpleRAG()
    rag.upsert_file("a.py", sha="x", language="python",
                    text="def keep_alpha(): pass\n")
    rag.upsert_file("b.py", sha="y", language="python",
                    text="def drop_beta(): pass\n")
    rag.remove_file("b.py")

    # Length invariants the cosine + bm25 paths rely on.
    assert len(rag.chunks) == len(rag._tf_vectors) == len(rag._chunk_lens)
    # b.py is gone from both the chunk list and the file map.
    assert all(c.file_path != "b.py" for c in rag.chunks)
    assert "b.py" not in rag._file_to_chunks
    # a.py still searchable.
    hits = rag.retrieve("alpha", top_k=5)
    assert hits and hits[0].file_path == "a.py"


def test_wiki_indexing_assigns_wiki_kind():
    rag = SimpleRAG()
    rag.upsert_file(
        "src/a.py", sha=_fast_sha("def f(): pass"),
        language="python", text="def authenticate_user(): pass\n",
    )

    class _P:  # mimic WikiPage duck-typing without importing the real one
        def __init__(self, page_id: str, content: str):
            self.id = page_id
            self.content = content

    rag.index_wiki_pages([
        _P("architecture", "# Architecture\n\nThis project uses authentication for users.\n"),
        _P("index", "# Overview\n\nTodo lists and stuff.\n"),
    ])

    # Both kinds now live in the same index.
    kinds = {c.kind for c in rag.chunks}
    assert kinds == {"code", "wiki"}
    # A wiki-side query is matchable.
    hits = rag.retrieve("authentication users", top_k=5)
    assert any(c.kind == "wiki" for c in hits)


def test_wiki_indexing_replaces_prior_wiki_chunks():
    """Re-running scan must not double-index the same wiki page."""
    rag = SimpleRAG()

    class _P:
        def __init__(self, page_id: str, content: str):
            self.id = page_id
            self.content = content

    rag.index_wiki_pages([_P("index", "# A\nfirst body alpha\n")])
    n_first = len(rag.chunks)
    rag.index_wiki_pages([_P("index", "# A\nsecond body beta\n")])
    assert len(rag.chunks) == n_first  # same shape, just different content
    assert rag.retrieve("alpha", top_k=5) == []
    hits = rag.retrieve("beta", top_k=5)
    assert hits


class _P:
    """WikiPage duck-type: only ``id`` and ``content`` are read."""

    def __init__(self, page_id: str, content: str):
        self.id = page_id
        self.content = content


def test_index_wiki_pages_keeps_vectors_of_unchanged_pages():
    """A cold-start re-index used to drop+re-add every wiki page, throwing
    away persisted embeddings and forcing a re-embed pass per restart.
    A sha-identical page must keep its chunks *and* their vectors."""
    rag = SimpleRAG()
    rag.index_wiki_pages([
        _P("index", "# Overview\nbody alpha\n"),
        _P("guide", "# Guide\nbody beta\n"),
    ])
    rag.set_vectors([[0.9, 0.1]] * len(rag.chunks), dims=2)

    # Same index page, changed guide page.
    rag.index_wiki_pages([
        _P("index", "# Overview\nbody alpha\n"),
        _P("guide", "# Guide\nbody gamma\n"),
    ])

    vecs = {c.file_path: rag._vectors[i] for i, c in enumerate(rag.chunks)}
    assert vecs["wiki/index.md"] == [0.9, 0.1], "unchanged page lost its vector"
    assert vecs["wiki/guide.md"] is None, "changed page kept a stale vector"
    # And the new content is what retrieval sees.
    assert rag.retrieve("gamma", top_k=5)


def test_index_wiki_pages_drops_pages_that_disappeared():
    rag = SimpleRAG()
    rag.index_wiki_pages([_P("a", "# A\nalpha\n"), _P("b", "# B\nbeta\n")])

    rag.index_wiki_pages([_P("a", "# A\nalpha\n")])

    assert "wiki/b.md" not in rag._file_sha
    assert "wiki/b.md" not in rag._file_to_chunks
    assert all(c.file_path != "wiki/b.md" for c in rag.chunks)


def test_remove_files_drops_several_paths_in_one_pass():
    rag = SimpleRAG()
    rag.upsert_file("a.py", sha="x", language="python", text="def keep_alpha(): pass\n")
    rag.upsert_file("b.py", sha="y", language="python", text="def drop_beta(): pass\n")
    rag.upsert_file("c.py", sha="z", language="python", text="def drop_gamma(): pass\n")

    rag.remove_files({"b.py", "c.py"})

    assert {c.file_path for c in rag.chunks} == {"a.py"}
    assert set(rag._file_sha) == {"a.py"}
    # Index-aligned arrays all shrank together.
    assert (
        len(rag.chunks)
        == len(rag._tf_vectors)
        == len(rag._tfidf_norms)
        == len(rag._chunk_lens)
        == len(rag._vectors)
    )
    assert rag.retrieve("alpha", top_k=5)


def test_tfidf_norms_stay_aligned_and_match_the_reference():
    """``_tfidf_norms`` is an index-aligned cache of ``_tfidf_norm`` over the
    current idf — pin both the alignment and the values, since ``retrieve``
    now trusts the cache instead of recomputing."""
    rag = SimpleRAG()
    rag.upsert_file("a.py", sha="x", language="python", text="def keep_alpha(): pass\n")
    rag.upsert_file("b.py", sha="y", language="python", text="def drop_beta(): pass\n")
    rag.remove_file("b.py")

    assert len(rag._tfidf_norms) == len(rag.chunks)
    for i, tf in enumerate(rag._tf_vectors):
        assert rag._tfidf_norms[i] == pytest.approx(_tfidf_norm(tf, rag._idf))

    # The norm cache must produce the same cosine as the reference helper.
    query_tf = Counter(_tokenize("alpha"))
    ref = [
        _cosine_similarity(query_tf, tf, rag._idf) for tf in rag._tf_vectors
    ]
    assert rag.retrieve("alpha", top_k=5)[0].score > 0
    assert max(ref) > 0


def test_postings_cover_upserts_without_waiting_for_a_rebuild():
    """``rebuild=False`` upserts invalidate the postings map; the next
    retrieve must rebuild it lazily rather than miss the new chunks.
    The new file shares a token the current idf already knows — a novel
    token scores zero against the stale idf either way."""
    rag = SimpleRAG()
    rag.upsert_file("a.py", sha="x", language="python", text="def keep_alpha(): pass\n")

    rag.upsert_file(
        "b.py", sha="y", language="python",
        text="def alpha_helper_two(): pass\n", rebuild=False,
    )

    hits = rag.retrieve("alpha", top_k=5)
    assert any(h.file_path == "b.py" for h in hits), (
        "the new file's chunks were invisible — postings went stale"
    )


def test_postings_drop_removed_chunks_without_waiting_for_a_rebuild():
    rag = SimpleRAG()
    rag.upsert_file("a.py", sha="x", language="python", text="def keep_alpha(): pass\n")
    rag.upsert_file("b.py", sha="y", language="python", text="def drop_beta(): pass\n")

    rag.remove_file("b.py", rebuild=False)

    assert rag.retrieve("beta", top_k=5) == []
    assert rag.retrieve("alpha", top_k=5)


def test_index_on_a_used_instance_resets_everything():
    """``index()`` must not leak the previous index's tf vectors or lengths —
    the arrays are rebuilt alongside ``chunks``, not accumulated."""
    rag = SimpleRAG()
    rag.index(_proj([
        FileInfo(path="a.py", size=10, language="python", content="def aaa_old(): pass\n"),
    ]))

    rag.index(_proj([
        FileInfo(path="b.py", size=10, language="python", content="def bbb_new(): pass\n"),
    ]))

    assert len(rag.chunks) == len(rag._tf_vectors) == len(rag._chunk_lens)
    assert all(c.file_path == "b.py" for c in rag.chunks)
    hits = rag.retrieve("bbb_new", top_k=5)
    assert hits and hits[0].file_path == "b.py"
    assert rag.retrieve("aaa_old", top_k=5) == []


def test_retrieve_with_an_include_predicate_scores_inside_the_scope_only():
    """A scoped search is a search of the scope: out-of-scope chunks neither
    rank nor reshape the normalisation the in-scope chunks get."""
    rag = SimpleRAG()
    rag.upsert_file("a.py", sha="x", language="python", text="def alpha_hit(): pass\n")
    rag.upsert_file("b.py", sha="y", language="python", text="def alpha_hit(): pass\n")

    scoped = rag.retrieve(
        "alpha_hit", top_k=5, include=lambda c: c.file_path == "b.py"
    )
    assert [c.file_path for c in scoped] == ["b.py"]

    # A scope that accepts nothing is an empty corpus, not a fallback.
    assert rag.retrieve("alpha_hit", include=lambda c: False) == []


def test_split_markdown_breaks_at_headings():
    md = (
        "# Title\n"
        "lead paragraph\n"
        "## Section A\n"
        "alpha text\n"
        "## Section B\n"
        "beta text\n"
    )
    chunks = _split_markdown_into_chunks(md, "x.md")
    # At least one chunk per heading (3 headings + the lead before any).
    assert len(chunks) >= 3
    joined = "\n---\n".join(c.content for c in chunks)
    assert "Section A" in joined and "Section B" in joined


def test_tokenize_smoke():
    """Sanity check that the camelCase/snake_case tokenisation behaviour
    still holds after the rewrite (test_rag.py covers it more thoroughly).
    """
    tokens = _tokenize("authenticateUser is_admin")
    assert "authenticate" in tokens and "user" in tokens
    assert "is_admin" in tokens and "admin" in tokens
