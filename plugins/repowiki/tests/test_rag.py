"""tests for repowiki.core.rag: tokenization and chunking."""

from __future__ import annotations

from repowiki.core.models import FileInfo, ProjectContext
from repowiki.core.rag import (
    SimpleRAG,
    _split_identifier,
    _split_into_chunks,
    _tokenize,
    format_context,
)


def test_split_identifier_camel_case():
    parts = _split_identifier("getUserById")
    assert "getuserbyid" in parts
    assert "get" in parts
    assert "user" in parts
    assert "by" in parts
    assert "id" in parts


def test_split_identifier_snake_case():
    parts = _split_identifier("is_authenticated_user")
    assert "is_authenticated_user" in parts
    assert "authenticated" in parts
    assert "user" in parts


def test_split_identifier_plain_word_only_yields_lowercase():
    parts = _split_identifier("hello")
    assert parts == ["hello"]


def test_tokenize_drops_stopwords_and_short_pieces():
    tokens = _tokenize("def hello_world(): return None")
    # `def`, `return`, `none` filtered as stopwords; one-char tokens dropped
    assert "def" not in tokens
    assert "return" not in tokens
    assert "none" not in tokens
    assert "hello_world" in tokens
    assert "hello" in tokens
    assert "world" in tokens


def test_tokenize_keeps_meaningful_identifiers():
    tokens = _tokenize("getUserById getOrderTotal")
    # both originals + their sub-words land in the bag
    assert "getuserbyid" in tokens
    assert "user" in tokens
    assert "order" in tokens
    assert "total" in tokens


def test_python_chunking_splits_at_def_boundaries():
    code = "\n".join(
        [
            "def first():",
            *["    pass"] * 25,  # 25 lines, plus the def line above -> 26
            "",
            "def second():",
            *["    return 1"] * 25,
            "",
            "def third():",
            *["    return 2"] * 25,
        ]
    )
    chunks = _split_into_chunks(code, "x.py", "python", soft_chunk_lines=10)

    # Three top-level defs should result in at least 3 chunks, each
    # *containing* one of the def lines (the def itself may not be on
    # line 1 of the chunk because of the overlap window).
    assert len(chunks) >= 3
    bodies = [c.content for c in chunks]
    assert sum("def first" in b for b in bodies) >= 1
    assert sum("def second" in b for b in bodies) >= 1
    assert sum("def third" in b for b in bodies) >= 1


def test_chunking_unknown_language_falls_back_to_blank_lines():
    code = "alpha\nbeta\n\ngamma\ndelta\nepsilon\n"
    chunks = _split_into_chunks(code, "x.txt", language="")
    # smoke: returns non-empty list and preserves all content
    assert len(chunks) >= 1
    rebuilt = "\n".join(c.content for c in chunks)
    assert "alpha" in rebuilt and "epsilon" in rebuilt


def test_chunk_line_numbers_are_1_based():
    code = "alpha\nbeta\ngamma\n"
    chunks = _split_into_chunks(code, "x.txt", language="")
    assert chunks[0].line_start == 1
    assert chunks[0].line_end >= 1


def test_simple_rag_retrieve_matches_camel_case_via_sub_word():
    """query 'user' should retrieve a chunk containing getUserById."""
    project = ProjectContext(
        name="t",
        root=".",
        files=[
            FileInfo(
                path="a.py",
                size=100,
                language="python",
                lines=3,
                content="def getUserById(uid):\n    return uid\n",
            ),
            FileInfo(
                path="b.py",
                size=100,
                language="python",
                lines=2,
                content="def compute():\n    return 42\n",
            ),
        ],
    )
    rag = SimpleRAG()
    rag.index(project)
    hits = rag.retrieve("user", top_k=2)
    assert hits, "expected at least one hit for 'user'"
    assert hits[0].file_path == "a.py"


def test_simple_rag_filters_zero_score_results():
    project = ProjectContext(
        name="t",
        root=".",
        files=[
            FileInfo(
                path="a.py",
                size=10,
                language="python",
                lines=1,
                content="alpha beta gamma",
            ),
        ],
    )
    rag = SimpleRAG()
    rag.index(project)
    hits = rag.retrieve("xyzzy_no_match_whatsoever", top_k=5)
    assert hits == []


def _project(*files: tuple[str, str]) -> ProjectContext:
    return ProjectContext(
        name="demo",
        root="/demo",
        files=[
            FileInfo(path=path, size=len(content), language="python", content=content)
            for path, content in files
        ],
    )


def test_retrieve_ranks_relevant_file_first():
    # several files so TF-IDF is non-degenerate (a 2-doc corpus collapses idf to 0)
    project = _project(
        ("auth.py", "def login(user, password):\n    return verify_password(user, password)\n"),
        ("db.py", "def connect_database(url):\n    return create_engine(url)\n"),
        ("cache.py", "def get_cached(key):\n    return store.lookup(key)\n"),
        ("router.py", "def add_route(path, handler):\n    routes.append((path, handler))\n"),
        ("logging.py", "def log_event(name):\n    writer.emit(name)\n"),
    )
    rag = SimpleRAG()
    rag.index(project)
    results = rag.retrieve("how does password login work")
    assert results, "expected at least one relevant chunk"
    assert results[0].file_path == "auth.py"
    assert results[0].score > 0


def test_unrelated_query_returns_nothing():
    project = _project(("auth.py", "def login(user, password): ...\n"))
    rag = SimpleRAG()
    rag.index(project)
    # no token overlap -> cosine similarity 0 -> filtered out
    assert rag.retrieve("kubernetes helm chart deployment") == []


def test_empty_index_retrieve():
    rag = SimpleRAG()
    assert rag.retrieve("anything") == []


def test_index_skips_empty_files():
    project = _project(("empty.py", ""), ("real.py", "def f():\n    return 1\n"))
    rag = SimpleRAG()
    rag.index(project)
    assert all(c.file_path == "real.py" for c in rag.chunks)


def test_sync_project_updates_changed_files_and_removes_stale_files():
    rag = SimpleRAG()
    rag.index(_project(("old.py", "def old_name(): pass"), ("keep.py", "def before(): pass")))

    rag.sync_project(
        _project(("keep.py", "def after_refresh(): pass"), ("new.py", "def added(): pass"))
    )

    indexed_paths = {chunk.file_path for chunk in rag.chunks}
    assert indexed_paths == {"keep.py", "new.py"}
    assert rag.retrieve("after_refresh")[0].file_path == "keep.py"


def test_format_context():
    project = _project(("auth.py", "def login():\n    pass\n"))
    rag = SimpleRAG()
    rag.index(project)
    chunks = rag.retrieve("login")
    ctx = format_context(chunks)
    assert "auth.py" in ctx
    assert "```" in ctx
    assert "def login" in ctx


def test_format_context_empty():
    assert "no relevant code" in format_context([])
