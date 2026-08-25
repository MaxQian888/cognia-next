"""Repo map: files ranked by dependency PageRank, no model calls.

Rewritten from upstream's CLI test — the `repowiki map` command is not ported,
but the ranking behind it is what the panel's reading order and the agent-facing
`repowiki_map` tool both return, so the properties are pinned here against the
pure function instead of a CliRunner.
"""

from __future__ import annotations

import pytest

from repowiki.core.scanner import scan_directory
from repowiki.project import repo_map


def _make_repo(tmp_path):
    (tmp_path / "core").mkdir()
    (tmp_path / "core" / "engine.py").write_text(
        "from .store import save\nfrom .cache import warm\n\ndef run(): ...\n"
    )
    (tmp_path / "core" / "store.py").write_text("from .cache import warm\n\ndef save(): ...\n")
    (tmp_path / "core" / "cache.py").write_text("def warm(): ...\n")
    (tmp_path / "notes.py").write_text("# orphan file\n")


def test_ranks_by_dependency_pagerank(tmp_path):
    _make_repo(tmp_path)
    files = scan_directory(tmp_path)
    entries = repo_map(files, root=str(tmp_path))

    assert len(files) == 4
    # cache.py sits at the bottom of every import chain, so it outranks the rest
    assert entries[0].path == "core/cache.py"
    assert entries[0].score >= entries[-1].score
    assert entries[0].rank == 1


def test_top_limits_the_list_without_reordering(tmp_path):
    _make_repo(tmp_path)
    files = scan_directory(tmp_path)
    full = repo_map(files, root=str(tmp_path))
    trimmed = repo_map(files, root=str(tmp_path), top=2)

    assert len(trimmed) == 2
    assert [e.path for e in trimmed] == [e.path for e in full[:2]]


def test_rejects_a_non_positive_top(tmp_path):
    _make_repo(tmp_path)
    with pytest.raises(ValueError):
        repo_map(scan_directory(tmp_path), top=0)


def test_paths_are_forward_slashed_for_prompts(tmp_path):
    _make_repo(tmp_path)
    entries = repo_map(scan_directory(tmp_path), root=str(tmp_path))
    assert all("\\" not in entry.path for entry in entries)


def test_entries_carry_language_and_line_counts(tmp_path):
    _make_repo(tmp_path)
    entries = repo_map(scan_directory(tmp_path), root=str(tmp_path))
    cache = next(e for e in entries if e.path == "core/cache.py")
    assert cache.language == "python"
    assert cache.lines >= 1
    assert cache.to_dict()["rank"] == cache.rank


def test_an_empty_project_maps_to_an_empty_list():
    assert repo_map([], root="/tmp/empty") == []
