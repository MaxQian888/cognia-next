"""Restart behaviour: a scanned wiki must outlive the session that made it.

Before the wiki store existed, a plugin-host restart emptied ``_SCANS`` — the
panel showed "no wiki yet" and every tool asked for a fresh scan. These drive
the full cycle: scan → persist → simulated restart → reads, search, ask and
staleness still work, and rescan re-acquires the *source* rather than a clone
path that stopped existing.
"""

from __future__ import annotations

import json

import main
import pytest
from repowiki.core.wiki_builder import Wiki, WikiPage
from repowiki.host import HostBridge, WorkspaceHandle, configure_paths, set_host
from repowiki.pipeline import ScanResult


def _write_repo(root):
    (root / "core").mkdir()
    (root / "core" / "engine.py").write_text(
        "from .store import save\n\ndef run():\n    return save()\n"
    )
    (root / "core" / "store.py").write_text("def save():\n    return 1\n")
    (root / "README.md").write_text("# Demo\n\nA demo project.\n")


class FakeA2ui:
    """The two calls `_push_panel` makes on a rescan action."""

    def __init__(self):
        self.updated: list[str] = []

    async def updateComponents(self, surface_id, components):
        self.updated.append(surface_id)

    async def setReady(self, surface_id):
        pass


class FakeCtx:
    def __init__(self):
        self.a2ui = FakeA2ui()


class FakeCognia:
    def __init__(self):
        self.ctx = FakeCtx()


class FakeHost(HostBridge):
    """One local checkout, a canned model, and a recordable diff."""

    def __init__(self, root, *, changed=None, head_ref="c0ffee"):
        self.root = str(root)
        self._changed = changed or []
        self._head_ref = head_ref
        self.specs: list[dict] = []
        self.prompts: list[str] = []

    async def agent_run(self, prompt, options):
        self.prompts.append(prompt)
        return {
            "text": json.dumps(
                {
                    "name": "demo",
                    "purpose": "a demo project",
                    "summary": "it demos",
                    "description": "it demos",
                    "modules": [],
                    "components": [],
                    "steps": [],
                    "entry_points": [],
                }
            ),
            "usage": {"inputTokens": 3, "outputTokens": 5},
        }

    async def workspace_acquire(self, spec):
        self.specs.append(spec)
        return {"root": self.root, "origin": "local-path", "headRef": self._head_ref}

    async def workspace_walk(self, handle, options):
        return {
            "entries": ["core/engine.py", "core/store.py", "README.md"],
            "truncated": False,
            "skippedSensitive": 0,
        }

    async def workspace_changed_since(self, handle, ref):
        return self._changed


def _result_clone(project_id: str) -> ScanResult:
    """A second scan entry without running the pipeline."""
    return ScanResult(
        project_id=project_id,
        wiki=Wiki(
            project_name="other",
            pages=[WikiPage(id="index", title="Overview", content="# x")],
        ),
        handle=WorkspaceHandle(root="/other", origin="local-path"),
        project=None,
        source="/other",
    )


@pytest.fixture(autouse=True)
def clean_state(tmp_path, monkeypatch):
    configure_paths(tmp_path / "plugin-data")
    monkeypatch.setattr(main, "get_config", dict)
    main._SCANS.clear()
    main._INDEXES.clear()
    main._FRESHNESS.clear()
    main._PANEL_STATE.clear()
    yield tmp_path
    main._SCANS.clear()
    main._INDEXES.clear()
    main._FRESHNESS.clear()
    main._PANEL_STATE.clear()
    set_host(None)
    configure_paths(None)


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "demo"
    root.mkdir()
    _write_repo(root)
    return root


async def _simulate_restart() -> None:
    """What the next plugin-host process does before serving a tool call."""
    main._SCANS.clear()
    main._INDEXES.clear()
    main._FRESHNESS.clear()
    await main._rehydrate_scans()


async def test_a_scanned_wiki_survives_a_restart(repo):
    host = FakeHost(repo)
    set_host(host)
    summary = await main.repowiki_scan(str(repo))
    project_id = summary["projectId"]

    await _simulate_restart()

    assert project_id in main._SCANS
    result = main._SCANS[project_id]
    assert result.project is None  # contents were not resurrected
    listed = main.repowiki_list()["projects"]
    assert [p["projectId"] for p in listed] == [project_id]
    assert listed[0]["live"] is False
    assert listed[0]["source"] == str(repo)


async def test_rehydrated_reads_search_and_ask_all_answer(repo):
    set_host(FakeHost(repo))
    summary = await main.repowiki_scan(str(repo))
    project_id = summary["projectId"]

    await _simulate_restart()

    page = main.repowiki_get_page(project_id, "index")
    assert page["title"] == "Overview"
    # The repo map came back from the snapshot, not a rebuilt graph.
    entries = main.repowiki_map(project_id)["entries"]
    assert entries[0]["path"] == "core/store.py"
    # Search answers from the index the scan persisted — no rescan needed.
    hits = await main.repowiki_search(project_id, "save")
    assert hits["citations"], "a restarted wiki that cannot be searched is dead"
    out = await main.repowiki_ask(project_id, "what does save return?")
    assert out["answer"]


async def test_a_single_project_makes_project_id_optional(repo):
    set_host(FakeHost(repo))
    await main.repowiki_scan(str(repo))

    out = await main.repowiki_ask("", "what does save return?")
    assert out["answer"]
    hits = await main.repowiki_search("", "save")
    assert hits["citations"]


async def test_an_omitted_project_id_between_several_fails_naming_them(repo):
    set_host(FakeHost(repo))
    await main.repowiki_scan(str(repo))
    other = _result_clone("otherwiki")
    main._SCANS["other"] = other

    with pytest.raises(ValueError, match="several wikis"):
        await main.repowiki_ask("", "anything")


async def test_rehydrated_staleness_still_asks_git(repo):
    set_host(FakeHost(repo, changed=["core/store.py"]))
    summary = await main.repowiki_scan(str(repo))
    project_id = summary["projectId"]

    await _simulate_restart()

    out = await main.repowiki_ask(project_id, "what does save return?")
    assert out["freshness"]["known"] is True
    assert out["freshness"]["stale"] is True


async def test_rescan_uses_the_source_so_a_dead_clone_path_is_never_walked(repo, monkeypatch):
    host = FakeHost(repo)
    set_host(host)
    fake_cognia = FakeCognia()
    monkeypatch.setattr(main, "cognia", fake_cognia)
    summary = await main.repowiki_scan(str(repo))
    project_id = summary["projectId"]

    await _simulate_restart()
    host.specs.clear()
    # Even if the recorded root no longer exists on disk, rescan re-acquires
    # the source — the pipeline resolves it through workspace.acquire again.
    result = main._SCANS[project_id]
    assert result.handle.paths == []
    result.handle.root = "/released/clone/that/is/gone"
    # The panel remembered which repo it was showing before the restart.
    main._PANEL_STATE["cognia-repowiki:session:s1"] = {
        "projectId": project_id,
        "pageId": "index",
    }

    await main.repowiki_panel_action(
        {
            "action": "repowiki:rescan",
            "surfaceId": "cognia-repowiki:session:s1",
            "data": {},
        }
    )

    assert host.specs[-1] == {"kind": "auto", "input": str(repo)}
    assert main._SCANS[project_id].project is not None


async def test_delete_drops_the_snapshot_and_the_index(repo):
    set_host(FakeHost(repo))
    summary = await main.repowiki_scan(str(repo))
    project_id = summary["projectId"]

    out = await main.repowiki_delete(project_id)
    assert out == {"projectId": project_id, "deleted": True}

    await _simulate_restart()
    assert project_id not in main._SCANS
    with pytest.raises(ValueError, match="No wiki for"):
        main.repowiki_get_page(project_id, "index")
