"""The wiki snapshot store: what a host restart gets back.

The RAG index and the analyzer cache were already durable; the assembled wiki
was not, so a restart emptied `repowiki_list` and cost a full re-scan. These
pin the rehydrate contract: pages, the repo map, the handle's durable fields
and the rescan source all come back — file contents deliberately do not.
"""

from __future__ import annotations

import json

import pytest
from repowiki.core import wiki_store
from repowiki.core.wiki_builder import Wiki, WikiPage
from repowiki.core.wiki_store import SCHEMA_VERSION, WikiStore
from repowiki.host import WorkspaceHandle
from repowiki.pipeline import ScanResult


def _result(project_id="deadbeef", **over) -> ScanResult:
    args = {
        "project_id": project_id,
        "wiki": Wiki(
            project_name="demo",
            pages=[
                WikiPage(id="index", title="Overview", content="# hi", order=0),
                WikiPage(
                    id="modules/core",
                    title="core",
                    content="# core",
                    parent_id="modules",
                    order=1,
                ),
            ],
        ),
        "handle": WorkspaceHandle(
            root="/tmp/repo",
            origin="github",
            ephemeral=True,
            remote={"url": "https://github.com/o/r"},
            head_ref="abc123",
            truncated=True,
            skipped_sensitive=2,
        ),
        "project": None,
        "source": "o/r",
        "map_entries": [
            {"rank": 1, "path": "a.py", "score": 0.5, "language": "python", "lines": 10}
        ],
        "file_count": 3,
        "scanned_at": 1000.0,
        "skipped_modules": ["core"],
        "errors": ["module boom"],
        "warnings": ["a truncated walk"],
        "usage": {"inputTokens": 10, "outputTokens": 20},
    }
    args.update(over)
    return ScanResult(**args)


@pytest.fixture
def store(tmp_path):
    return tmp_path / "wiki.db"


async def _save(store_path, *results):
    store = WikiStore(store_path)
    await store.init()
    for result in results:
        await store.save(result)
    await store.close()


async def test_a_saved_wiki_rehydrates_without_its_file_contents(store):
    await _save(store, _result())

    store_obj = WikiStore(store)
    await store_obj.init()
    restored = await store_obj.load_all()
    await store_obj.close()

    assert len(restored) == 1
    result = restored[0]
    assert result.project is None  # the whole point: contents stay gone
    assert result.project_id == "deadbeef"
    assert result.source == "o/r"
    assert result.wiki.project_name == "demo"
    assert result.wiki.get_page("index").content == "# hi"
    assert result.wiki.get_page("modules/core").parent_id == "modules"
    assert result.map_entries[0]["path"] == "a.py"
    assert result.file_count == 3
    assert result.skipped_modules == ["core"]
    assert result.errors == ["module boom"]
    assert result.usage == {"inputTokens": 10, "outputTokens": 20}
    assert result.scanned_at == 1000.0


async def test_the_handles_durable_fields_survive_but_paths_do_not(store):
    await _save(store, _result())

    store_obj = WikiStore(store)
    await store_obj.init()
    (result,) = await store_obj.load_all()
    await store_obj.close()

    handle = result.handle
    assert handle.head_ref == "abc123"
    assert handle.ephemeral is True
    assert handle.remote == {"url": "https://github.com/o/r"}
    assert handle.truncated is True
    assert handle.skipped_sensitive == 2
    # The persisted allow-list is a memory, not permission: the next walk is
    # the host's to grant again at rescan time.
    assert handle.paths == []


async def test_rescanning_uses_the_source_not_the_clone_path(store):
    # A URL-ingested repo's handle.root is a clone this plugin released on
    # shutdown; re-scanning it means re-acquiring the source.
    await _save(store, _result())

    store_obj = WikiStore(store)
    await store_obj.init()
    (result,) = await store_obj.load_all()
    await store_obj.close()

    assert result.source == "o/r"
    assert result.handle.root == "/tmp/repo"  # memory only, not the rescan input


async def test_a_row_from_another_schema_version_is_dropped_not_misread(store):
    await _save(store, _result())
    import aiosqlite

    db = await aiosqlite.connect(store)
    await db.execute("UPDATE wiki_projects SET schema_version = ?", (SCHEMA_VERSION + 1,))
    await db.commit()
    await db.close()

    store_obj = WikiStore(store)
    await store_obj.init()
    assert await store_obj.load_all() == []
    # And the row is gone, so a fix-up release does not keep tripping on it.
    cur = await store_obj._db.execute("SELECT COUNT(*) FROM wiki_projects")
    (count,) = await cur.fetchone()
    assert count == 0
    await store_obj.close()


async def test_a_corrupt_snapshot_is_dropped_and_the_rest_survive(store):
    await _save(store, _result(), _result(project_id="good", source="x/y"))
    import aiosqlite

    db = await aiosqlite.connect(store)
    await db.execute(
        "INSERT OR REPLACE INTO wiki_projects "
        "(project_id, schema_version, source, scanned_at, snapshot) "
        "VALUES ('bad', ?, 'x', 0, ?)",
        (SCHEMA_VERSION, b"\x00\xff not json"),
    )
    await db.commit()
    await db.close()

    store_obj = WikiStore(store)
    await store_obj.init()
    restored = await store_obj.load_all()
    assert {r.project_id for r in restored} == {"deadbeef", "good"}
    cur = await store_obj._db.execute("SELECT COUNT(*) FROM wiki_projects")
    (count,) = await cur.fetchone()
    assert count == 2
    await store_obj.close()


async def test_delete_removes_the_snapshot(store):
    await _save(store, _result(), _result(project_id="other"))

    store_obj = WikiStore(store)
    await store_obj.init()
    await store_obj.delete("deadbeef")
    restored = await store_obj.load_all()
    await store_obj.close()

    assert [r.project_id for r in restored] == ["other"]


async def test_saving_twice_replaces_rather_than_duplicates(store):
    first = _result()
    first.wiki.project_name = "before"
    second = _result()
    second.wiki.project_name = "after"
    await _save(store, first, second)

    store_obj = WikiStore(store)
    await store_obj.init()
    restored = await store_obj.load_all()
    await store_obj.close()

    assert len(restored) == 1
    assert restored[0].wiki.project_name == "after"


def test_every_snapshotted_field_is_json_shaped_because_it_crosses_the_disk():
    # The blob is data the host reads back; a non-serialisable field would
    # surface as a failed save long after the scan that produced it.
    json.dumps(wiki_store._snapshot_of(_result()))
