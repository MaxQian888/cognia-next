"""The panel's Rescan button, and the per-surface state behind every panel.

A rescan is minutes of model calls; the action hook that receives the click is
bounded far below that. These pin the shape that fixes it: the hook paints
"Scanning…" and returns, a background task does the scan, and the outcome —
the fresh wiki or a translated failure — is painted when it lands. They also
pin that a surface the host destroyed stops costing memory.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

import main
from repowiki.core.wiki_builder import Wiki, WikiPage
from repowiki.host import WorkspaceHandle
from repowiki.panel import DEFAULT_LABELS
from repowiki.pipeline import ScanResult

SURFACE = "cognia-repowiki:session:s1"
OTHER_SURFACE = "cognia-repowiki:project:p:r:README.md"
MANIFEST = json.loads((Path(__file__).resolve().parents[1] / "plugin.json").read_text("utf8"))


class RecordingA2ui:
    def __init__(self):
        self.pushes: list[tuple[str, dict]] = []

    async def createSurface(self, surface_id, kind, options):  # noqa: N802
        pass

    async def updateComponents(self, surface_id, components):  # noqa: N802
        self.pushes.append((surface_id, {c["id"]: c for c in components}))

    async def setReady(self, surface_id):  # noqa: N802
        pass

    def last(self, surface_id):
        return next(c for sid, c in reversed(self.pushes) if sid == surface_id)


class FakeCognia:
    def __init__(self):
        self.ctx = type("Ctx", (), {})()
        self.ctx.a2ui = RecordingA2ui()


def _snapshot(project_id="demo-1") -> ScanResult:
    return ScanResult(
        project_id=project_id,
        wiki=Wiki(
            project_name="demo",
            pages=[WikiPage(id="index", title="Overview", content="# Overview")],
        ),
        handle=WorkspaceHandle(root="/gone", origin="local-path"),
        project=None,
        source="/src/demo",
    )


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    fake = FakeCognia()
    monkeypatch.setattr(main, "cognia", fake)

    async def no_freshness(project_id):
        return None

    monkeypatch.setattr(main, "_refresh_freshness", no_freshness)
    for table in (main._SCANS, main._PANEL_STATE, main._RESCANS, main._RESCAN_ERRORS):
        table.clear()
    yield fake
    for task in main._RESCANS.values():
        task.cancel()
    for table in (main._SCANS, main._PANEL_STATE, main._RESCANS, main._RESCAN_ERRORS):
        table.clear()


def _open_panel(surface_id=SURFACE, project_id="demo-1"):
    main._SCANS[project_id] = main._SCANS.get(project_id) or _snapshot(project_id)
    main._PANEL_STATE[surface_id] = {"projectId": project_id, "pageId": "index"}


def _click(surface_id=SURFACE):
    return main.repowiki_panel_action(
        {"action": "repowiki:rescan", "surfaceId": surface_id, "data": {}}
    )


def _gated_scan(monkeypatch, *, fail=None):
    """A scan that finishes only when the test says so."""
    release = asyncio.Event()
    calls: list[str] = []

    async def scan(source, *args, **kwargs):
        calls.append(source)
        await release.wait()
        if fail:
            raise fail
        return {"projectId": "demo-1"}

    monkeypatch.setattr(main, "repowiki_scan", scan)
    return release, calls


async def test_the_click_paints_scanning_and_returns_before_the_scan_ends(clean_state, monkeypatch):
    release, calls = _gated_scan(monkeypatch)
    _open_panel()

    await _click()  # returns while the scan is still blocked

    task = main._RESCANS["demo-1"]
    assert not task.done()
    painted = clean_state.ctx.a2ui.last(SURFACE)
    assert painted["rescan"]["text"] == DEFAULT_LABELS["panel.scanning"]
    assert painted["rescan"]["loading"] is True

    release.set()
    await task
    # Re-acquires the recorded *source*, not the released clone path.
    assert calls == ["/src/demo"]
    assert "demo-1" not in main._RESCANS
    done = clean_state.ctx.a2ui.last(SURFACE)
    assert done["rescan"]["text"] == DEFAULT_LABELS["panel.rescan"]
    assert "loading" not in done["rescan"]
    assert "scan-error" not in done


async def test_a_second_click_joins_the_running_scan(clean_state, monkeypatch):
    release, calls = _gated_scan(monkeypatch)
    _open_panel()

    await _click()
    task = main._RESCANS["demo-1"]
    await _click()
    assert main._RESCANS["demo-1"] is task

    release.set()
    await task
    assert calls == ["/src/demo"]


async def test_every_panel_on_the_wiki_learns_the_outcome(clean_state, monkeypatch):
    release, _ = _gated_scan(monkeypatch)
    _open_panel(SURFACE)
    _open_panel(OTHER_SURFACE)

    await _click(SURFACE)
    assert clean_state.ctx.a2ui.last(OTHER_SURFACE)["rescan"]["loading"] is True

    release.set()
    await main._RESCANS["demo-1"]
    assert "loading" not in clean_state.ctx.a2ui.last(OTHER_SURFACE)["rescan"]


async def test_a_failed_scan_is_painted_with_a_translated_title(clean_state, monkeypatch):
    release, _ = _gated_scan(monkeypatch, fail=RuntimeError("clone refused: host not allowed"))
    monkeypatch.setattr(main, "_LABELS", {**DEFAULT_LABELS, "panel.scanFailed": "重新扫描失败"})
    _open_panel()

    await _click()
    task = main._RESCANS["demo-1"]
    release.set()
    await task  # the failure is caught and painted, never raised into the loop

    painted = clean_state.ctx.a2ui.last(SURFACE)
    assert painted["scan-error"]["title"] == "重新扫描失败"
    assert painted["scan-error"]["message"] == "clone refused: host not allowed"
    assert painted["rescan"]["text"] == DEFAULT_LABELS["panel.rescan"]
    assert "demo-1" not in main._RESCANS


async def test_the_next_rescan_clears_the_last_failure(clean_state, monkeypatch):
    main._RESCAN_ERRORS["demo-1"] = "old failure"
    release, _ = _gated_scan(monkeypatch)
    _open_panel()

    await _click()
    assert "scan-error" not in clean_state.ctx.a2ui.last(SURFACE)
    release.set()
    await main._RESCANS["demo-1"]


async def test_shutdown_cancels_a_running_rescan(clean_state, monkeypatch):
    _gated_scan(monkeypatch)
    _open_panel()
    await _click()
    task = main._RESCANS["demo-1"]

    await main.on_shutdown()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert main._RESCANS == {}


def test_a_destroyed_surface_drops_its_panel_state():
    main._PANEL_STATE[SURFACE] = {"projectId": "demo-1", "pageId": "index"}
    main._PANEL_STATE["other-plugin:x"] = {"projectId": "?", "pageId": "?"}

    assert main.repowiki_panel_destroyed(SURFACE) is None

    assert SURFACE not in main._PANEL_STATE
    # A broadcast: another plugin's surface is not ours to forget.
    assert "other-plugin:x" in main._PANEL_STATE
    main.repowiki_panel_destroyed({"surfaceId": "cognia-repowiki:x"})  # not a surface id
    main.repowiki_panel_destroyed(None)


def test_the_destroy_hook_is_registered_under_the_host_event_name():
    # The name is the host's `onA2UISurfaceDestroy` plugin point; a typo would
    # register a hook nothing ever dispatches.
    from cognia.runtime import get_active_runtime

    assert {"event": "onA2UISurfaceDestroy", "name": "repowiki_panel_destroyed"} in (
        get_active_runtime().get_hooks()
    )


def test_every_panel_label_ships_in_both_locales():
    for locale in ("en", "zh-CN"):
        bundle = MANIFEST["i18n"]["locales"][locale]
        missing = [key for key in DEFAULT_LABELS if key not in bundle]
        assert missing == [], f"{locale} is missing {missing}"
    for key, default in DEFAULT_LABELS.items():
        assert MANIFEST["i18n"]["locales"]["en"][key] == default


async def test_deleting_the_wiki_stops_its_running_rescan(clean_state, monkeypatch):
    release = asyncio.Event()

    async def scan(source, *args, **kwargs):
        await release.wait()
        # What a finished scan does: re-register the project it scanned.
        main._SCANS["demo-1"] = _snapshot()
        return {"projectId": "demo-1"}

    class NullStore:
        async def init(self):
            pass

        async def close(self):
            pass

        async def delete(self, project_id):
            pass

        async def delete_project(self, project_id):
            pass

    monkeypatch.setattr(main, "repowiki_scan", scan)
    monkeypatch.setattr(main, "WikiStore", NullStore)
    monkeypatch.setattr(main, "RagStore", NullStore)
    _open_panel()
    await _click()
    task = main._RESCANS["demo-1"]

    out = await main.repowiki_delete("demo-1")

    assert out == {"projectId": "demo-1", "deleted": True}
    assert task.cancelled()
    release.set()
    await asyncio.sleep(0)
    # The deleted wiki stays deleted.
    assert "demo-1" not in main._SCANS
    assert "demo-1" not in main._RESCANS
