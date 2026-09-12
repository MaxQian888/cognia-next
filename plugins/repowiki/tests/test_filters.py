"""The include/exclude rules a scan applies before reading a single file.

Borrowed from DeepWiki-Open's ``iterate_files`` knobs, pinned here because a
filter that silently keeps vendor/ or drops src/ turns the whole wiki into a
confident picture of the wrong repository.
"""

from __future__ import annotations

from repowiki.ingest.filters import build_path_filter


def test_no_rules_means_no_filter():
    assert build_path_filter() is None
    assert build_path_filter(excluded_dirs=[], included_files=[]) is None


def test_a_bare_dir_name_excludes_it_anywhere():
    keep = build_path_filter(excluded_dirs=["vendor"])
    assert keep is not None
    assert not keep("vendor/lib.js")
    assert not keep("src/vendor/lib.js")
    assert keep("src/vendored-util.js")  # a name, not a prefix
    assert keep("src/main.py")


def test_a_dir_with_a_slash_is_a_path_prefix_not_a_name():
    keep = build_path_filter(excluded_dirs=["tests/fixtures"])
    assert not keep("tests/fixtures/big.json")
    assert keep("other/tests/fixtures/small.json")
    assert keep("tests/test_main.py")


def test_file_globs_match_full_path_and_basename():
    keep = build_path_filter(excluded_files=["*.min.js", "src/gen/**"])
    assert not keep("web/dist/app.min.js")
    assert not keep("src/gen/out.ts")
    assert keep("src/app.js")


def test_inclusions_whitelist_and_exclusions_still_win():
    keep = build_path_filter(
        included_dirs=["src"], excluded_dirs=["src/vendor"], excluded_files=["*.test.ts"]
    )
    assert keep("src/app.ts")
    assert not keep("src/vendor/lib.ts")
    assert not keep("src/app.test.ts")
    assert not keep("docs/readme.md")


def test_include_globs_can_stand_alone():
    keep = build_path_filter(included_files=["**/*.py"])
    assert keep("a/b/c.py")
    assert not keep("a/b/c.ts")
