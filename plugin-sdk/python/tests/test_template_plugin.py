"""The emitted Python plugin template, run against the SDK's reference runtime.

The template is the first Python a plugin author ever runs, so anything wrong
in it is wrong in every plugin that starts from it. These tests drive the real
asset — ``crates/cognia-plugin-template-python/main.py``, the same bytes
``cognia plugin new --kind python`` writes — rather than a copy of it.

The defect they pin: ``progress()`` takes a PERCENTAGE. The host renders ``pct``
verbatim with a ``%`` suffix (``lib/plugin/devtools/runtime-log-stream.ts``),
and the template reported ``0.5`` then ``1.0``, so a finished write showed the
author "1%" and taught them a scale the runtime does not use.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

import cognia

TEMPLATE_MAIN = (
    Path(__file__).resolve().parents[3] / "crates" / "cognia-plugin-template-python" / "main.py"
)


def _load_template():
    """Import the template asset under its own name, freshly each time.

    Freshly because the template keeps its data directory in a module global
    that ``on_startup`` fills in; a cached module would carry one test's
    directory into the next.
    """
    spec = importlib.util.spec_from_file_location("cognia_plugin_template_python", TEMPLATE_MAIN)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules.pop(spec.name, None)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(spec.name, None)
    return module


class _Host:
    """A host that answers the template's ``ctx`` calls and records them."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, Dict[str, Any]]] = []
        self.files: Dict[str, str] = {}

    def _arg(self, params: Dict[str, Any], index: int, default: Any = None) -> Any:
        args = params.get("args") or []
        return args[index] if len(args) > index else default

    def __call__(self, method: str, params: Dict[str, Any]) -> Any:
        self.calls.append((method, params))
        if method == "fs.getDataDir":
            return "/data/template"
        if method == "fs.exists":
            return self._arg(params, 0) in self.files
        if method == "fs.readText":
            return self.files.get(self._arg(params, 0), "")
        if method == "fs.writeText":
            self.files[self._arg(params, 0, "")] = self._arg(params, 1, "")
            return None
        if method == "i18n.t":
            # The template applies its own fallback per key, so echoing the key
            # back is the honest answer for a bundle that resolved nothing.
            return self._arg(params, 0, "")
        return None


@pytest.fixture()
def template():
    """The loaded template, a stub host, and the runtime's event tape."""
    runtime = cognia.get_active_runtime()
    host = _Host()
    runtime.set_host_call_handler(host)
    events: List[Tuple[str, Any, Any]] = []
    runtime.set_event_sink(lambda event, data, call_id: events.append((event, data, call_id)))
    module = _load_template()
    # The note path is unknown until on_startup resolves the data directory.
    asyncio.run(module.on_startup())
    events.clear()
    return module, host, events


def _progress_pcts(events) -> List[Any]:
    return [data.get("pct") for event, data, _ in events if event == "progress" and data]


def test_the_write_path_reports_progress_as_a_percentage(template):
    module, host, events = template

    result = asyncio.run(module.template_note(text="hello"))

    assert result == {"ok": True, "note": "hello"}
    pcts = _progress_pcts(events)
    assert pcts == [50, 100], pcts
    # The one that matters: a finished call must say 100, not 1.
    assert pcts[-1] == 100
    assert all(isinstance(pct, int) and 0 <= pct <= 100 for pct in pcts)
    assert host.files["/data/template/note.txt"] == "hello"


def test_progress_carries_a_message_with_every_step(template):
    module, _host, events = template

    asyncio.run(module.template_note(text="hello"))

    messages = [data.get("message") for event, data, _ in events if event == "progress"]
    assert messages == ["writing note", "done"]


def test_reading_the_note_reports_no_progress_at_all(template):
    module, _host, events = template

    result = asyncio.run(module.template_note())

    assert result == {"ok": True, "note": ""}
    assert _progress_pcts(events) == []


def test_the_template_never_reports_a_fraction():
    """A fraction is the whole bug: 1.0 renders as "1%", not "done"."""
    source = TEMPLATE_MAIN.read_text(encoding="utf-8")
    assert "progress(0." not in source
    assert "progress(1.0" not in source


SURFACE = "cognia-plugin-template-python:session-1"


def test_saving_writes_what_the_user_typed(template):
    module, host, _events = template
    host.files["/data/template/note.txt"] = "existing"

    asyncio.run(
        module.template_panel_data_change(
            {"surfaceId": SURFACE, "path": module.DRAFT_PATH, "value": "typed by hand"}
        )
    )
    asyncio.run(
        module.template_panel_action(
            {"surfaceId": SURFACE, "action": module.ACTION_SAVE_NOTE, "data": {"text": "Save note"}}
        )
    )

    assert host.files["/data/template/note.txt"] == "typed by hand"


def test_saving_without_an_edit_leaves_the_note_alone(template):
    """The defect this pins: Save used to read a field off the CLICK.

    An action carries the button's own label and nothing else, so
    ``data.get("value")`` was always absent and every press wrote "" over
    whatever the note held.
    """
    module, host, _events = template
    host.files["/data/template/note.txt"] = "existing"

    asyncio.run(
        module.template_panel_action(
            {"surfaceId": SURFACE, "action": module.ACTION_SAVE_NOTE, "data": {"text": "Save note"}}
        )
    )

    assert host.files["/data/template/note.txt"] == "existing"


def test_the_panel_offers_somewhere_to_type(template):
    """A Save button with no bound input is a button that can only destroy."""
    module, _host, _events = template

    components = module._panel_components("existing")
    field = next(c for c in components if c["component"] == "TextField")
    # A literal `value` renders read-only: the renderer only reports typing for
    # a component bound to a data path.
    assert field["value"] == {"path": module.DRAFT_PATH}
    root = next(c for c in components if c["id"] == "root")
    assert field["id"] in root["children"]


def test_another_plugin_s_surface_is_left_alone(template):
    module, host, _events = template
    host.files["/data/template/note.txt"] = "existing"

    asyncio.run(
        module.template_panel_data_change(
            {"surfaceId": "someone-else:1", "path": module.DRAFT_PATH, "value": "not ours"}
        )
    )
    asyncio.run(
        module.template_panel_action(
            {"surfaceId": "someone-else:1", "action": module.ACTION_SAVE_NOTE, "data": {}}
        )
    )

    assert host.files["/data/template/note.txt"] == "existing"
