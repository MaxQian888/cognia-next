"""The in-tree Python demo's glance module, run on the SDK's reference runtime.

``plugins/cognia-python-demo/main.py`` is the living example of a Python glance
module (ADR-0225 §6): it refreshes the module only while the
``onGlanceVisibilityChange`` hook says it is on screen, and answers its Refresh
button through ``onCommand``. This loads that file as-is and drives it the way
the host does. Skips when the repo plugin is not reachable (standalone SDK).
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

from cognia import validate_glance_data

_MAIN_REL = Path("plugins/cognia-python-demo/main.py")


def _load_demo():
    for parent in Path(__file__).resolve().parents:
        path = parent / _MAIN_REL
        if path.is_file():
            spec = importlib.util.spec_from_file_location("cognia_python_demo_main", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    pytest.skip("repo plugins/cognia-python-demo not reachable from the SDK directory")


def _attach_host(runtime, translations=None):
    """A host that answers ctx.i18n.t from `translations` (else echoes the key,
    as the real one does for a missing key) and records every call."""
    calls = []
    translations = translations or {}

    async def host(method, params):
        calls.append((method, params))
        if method == "i18n.t":
            key = params["args"][0]
            return translations.get(key, key)
        if method == "glance.update":
            return None
        raise AssertionError(f"unexpected host call {method}")

    runtime.set_host_call_handler(host)
    return calls


def _published(calls):
    return [params["args"] for method, params in calls if method == "glance.update"]


def test_demo_declares_the_hooks_the_manifest_relies_on(fresh_runtime):
    _load_demo()
    hooks = {(entry["event"], entry["name"]) for entry in fresh_runtime.get_hooks()}
    assert ("onGlanceVisibilityChange", "on_glance_visibility") in hooks
    assert ("onCommand", "on_command") in hooks


def test_refresh_command_publishes_valid_data_in_the_app_language(fresh_runtime):
    demo = _load_demo()
    calls = _attach_host(
        fresh_runtime,
        {"glance.uptime": "已运行", "glance.summary": "Python 3 · 已运行 1m", "glance.refresh": "刷新"},
    )
    result = fresh_runtime.dispatch(
        "call_hook",
        {
            "event": "onCommand",
            "name": "on_command",
            "payload": {"command": demo.GLANCE_REFRESH_COMMAND, "args": []},
        },
    )
    assert result == {"handled": True}

    [(module_id, data)] = _published(calls)
    assert module_id == demo.GLANCE_MODULE
    assert validate_glance_data(data) == data
    assert data["summary"] == "Python 3 · 已运行 1m"
    assert [stat["label"] for stat in data["stats"]] == ["Python", "已运行", "Updated"]
    assert data["actions"] == [
        {
            "id": "refresh",
            "label": "刷新",
            "icon": "RefreshCw",
            "command": demo.GLANCE_REFRESH_COMMAND,
        }
    ]
    # The summary is translated with its parameters.
    summary_call = next(
        params for method, params in calls if method == "i18n.t" and params["args"][0] == "glance.summary"
    )
    assert set(summary_call["args"][1]) == {"version", "uptime"}


def test_command_hook_declines_commands_it_does_not_own(fresh_runtime):
    _load_demo()
    calls = _attach_host(fresh_runtime)
    for payload in ({"command": "other", "args": []}, ["legacy", [], None]):
        result = fresh_runtime.dispatch(
            "call_hook", {"event": "onCommand", "name": "on_command", "payload": payload}
        )
        assert result == {"handled": False}
    assert calls == []


def test_refreshes_only_while_visible(fresh_runtime):
    demo = _load_demo()
    calls = _attach_host(fresh_runtime)

    async def scenario():
        # Hidden first (the host's initial state): nothing runs.
        await demo.on_glance_visibility({"moduleId": "runtime", "visible": False})
        await asyncio.sleep(0)
        assert _published(calls) == []

        await demo.on_glance_visibility({"moduleId": "runtime", "visible": True})
        task = demo._glance_task
        assert task is not None
        for _ in range(20):
            await asyncio.sleep(0)
        assert len(_published(calls)) == 1

        # A repeat of the same state does not start a second loop.
        await demo.on_glance_visibility({"moduleId": "runtime", "visible": True})
        assert demo._glance_task is task

        # Another module's event is not ours.
        await demo.on_glance_visibility({"moduleId": "other", "visible": False})
        assert demo._glance_task is task

        await demo.on_glance_visibility({"moduleId": "runtime", "visible": False})
        assert demo._glance_task is None
        await asyncio.sleep(0)
        assert task.cancelled()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "seconds, text",
    [(0, "0s"), (42, "42s"), (300, "5m"), (3600, "1h"), (12_000, "3h 20m"), (86_400, "1d"), (187_200, "2d 4h")],
)
def test_uptime_is_short(seconds, text):
    demo = _load_demo()
    assert demo.format_uptime(seconds) == text
