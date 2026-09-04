"""Cognia Python plugin template.

The desktop host injects the ``cognia`` module before importing this file, so
nothing here is installed from PyPI. For local type checking and tests, use the
Python SDK under ``plugin-sdk/python`` in the cognia-next repository.

What this template shows, in the order the host exercises it:

* ``on_startup`` / ``on_config_updated`` / ``on_shutdown``, the module-level
  lifecycle names the host calls if they exist.
* ``@tool``, both a pure one and one that reaches the host through ``ctx``.
* ``cognia.ctx``, whose calls are coroutines, which is why the tools that use
  it are ``async def``.
* ``get_config()``, answering from the ``configSchema`` in ``plugin.json``.
* ``progress()``, so a slow tool reports where it is instead of going quiet.
  Its ``pct`` is a percentage, 0-100.
* An A2UI context panel. A Python plugin cannot hand the host a React
  component, so the panel is data: a component tree pushed with ``ctx.a2ui``.
  Traffic comes back on two hooks, and it takes both to make a form work:
  ``onA2UIDataChange`` reports typing, ``onA2UIAction`` reports the click. A
  click carries the button's own label and nothing else, so a Save handler
  that reads a field off the action writes an empty string every time.
"""

from __future__ import annotations

from typing import Any

import cognia
from cognia import get_config, hook, log, progress, tool

#: Where the note lives, resolved in ``on_startup``. The host jails ``ctx.fs``
#: to this plugin's own data directory, and the directory is reclaimed when the
#: plugin is uninstalled, so nothing here escapes into the user's home folder.
_DATA_DIR: str = ""

#: Panel chrome, translated once. ``ctx.i18n.t`` resolves against this plugin's
#: own ``i18n.locales`` bundle in ``plugin.json`` and echoes the key back when
#: nothing resolved it, which is why the fallback is applied per key rather
#: than all-or-nothing.
_LABELS: dict[str, str] = {
    "panel.title": "Template",
    "panel.note": "Note",
    "panel.save": "Save note",
    "panel.empty": "No note yet.",
}

#: Namespaced because ``onA2UIAction`` is a broadcast: every plugin's hook sees
#: every surface's actions.
ACTION_SAVE_NOTE = "cognia-plugin-template-python:save-note"

#: Data path the panel's text field is bound to.
DRAFT_PATH = "draft"

#: What the user has typed into the panel, per surface.
#:
#: A click carries only the button's own label, so the typed text cannot ride
#: along with the action. The renderer reports typing separately, through
#: ``onA2UIDataChange``, and this is where that lands until Save is pressed.
_DRAFTS: dict[str, str] = {}


def _note_path() -> str:
    if not _DATA_DIR:
        raise RuntimeError("on_startup has not run, so the data directory is unknown")
    return f"{_DATA_DIR}/note.txt"


async def _read_note() -> str:
    if not await cognia.ctx.fs.exists(_note_path()):
        return ""
    return str(await cognia.ctx.fs.readText(_note_path()) or "")


# ---------------------------------------------------------------------------
# Lifecycle. All three are optional and all three are looked up by name.
# ---------------------------------------------------------------------------


async def on_startup() -> None:
    """Resolve the data directory and the panel's labels, once."""
    global _DATA_DIR
    _DATA_DIR = str(await cognia.ctx.fs.getDataDir())
    for key in list(_LABELS):
        value = await cognia.ctx.i18n.t(key)
        if isinstance(value, str) and value and value != key:
            _LABELS[key] = value


def on_config_updated(config: dict[str, Any]) -> None:
    """Fired when the user edits this plugin's settings.

    Config is read per call below, so there is nothing to invalidate here. The
    hook stays because anything you derive from config needs one place to drop
    it, and finding that place after the fact is the hard part.
    """
    log(f"config updated: {sorted(config)}")


async def on_shutdown() -> None:
    """Last chance to release anything the host cannot reclaim for you."""
    log("template python plugin shutting down")


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@tool(
    name="template_echo",
    description="Echo the supplied message back to the agent.",
    parameters={
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "The message to echo.",
            }
        },
        "required": ["message"],
        "additionalProperties": False,
    },
)
def template_echo(message: str) -> dict[str, Any]:
    """Return a small JSON-serializable echo payload.

    Synchronous on purpose: a tool that never calls the host does not need to
    be a coroutine, and the runtime accepts both.
    """

    text = message if isinstance(message, str) else str(message)
    if get_config().get("shoutEcho"):
        text = text.upper()
    log("template_echo called")
    return {"ok": True, "echoed": text}


@tool(
    name="template_note",
    description="Read or replace the plugin's saved note.",
    parameters={
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "New note text. Omit to read the current note.",
            }
        },
        "additionalProperties": False,
    },
)
async def template_note(text: str | None = None) -> dict[str, Any]:
    """Show what a tool that reaches the host looks like.

    Async because every ``ctx`` call is a coroutine: the host answers over the
    plugin's stdio channel, so there is no synchronous version of it.
    """

    if text is None:
        return {"ok": True, "note": await _read_note()}

    # Percent, 0-100 — not a fraction. The host renders `pct` verbatim with a
    # `%` suffix (`lib/plugin/devtools/runtime-log-stream.ts`), so 0.5 reads as
    # half a percent rather than half done.
    progress(50, "writing note")
    await cognia.ctx.fs.writeText(_note_path(), text)
    # A toast is the honest confirmation for a write the user asked for. The
    # agent sees the return value, the user sees this.
    await cognia.ctx.ui.showToast("Note saved", "success")
    progress(100, "done")
    return {"ok": True, "note": text}


# ---------------------------------------------------------------------------
# The context panel, declared in plugin.json and built here
# ---------------------------------------------------------------------------


def _panel_components(note: str) -> list[dict[str, Any]]:
    """The component tree for the panel.

    The root id must be ``"root"``. The host fixes it when the surface is
    created and no message changes it, so a tree without one renders the
    surface's "no content" state instead of your panel.

    No host calls and no IO in here, so the layout stays unit-testable without
    a running app.
    """
    return [
        {
            "id": "root",
            "component": "Column",
            "children": ["title", "body", "draft", "save"],
            "gap": 8,
        },
        {
            "id": "title",
            "component": "Text",
            "text": _LABELS["panel.title"],
            "variant": "heading4",
        },
        {
            "id": "body",
            "component": "Text",
            "text": note or _LABELS["panel.empty"],
        },
        {
            # Bound to a data path rather than a literal, which is what makes it
            # editable: the renderer only reports typing for a component whose
            # `value` is a `{"path": ...}` binding, and it reports it through
            # `onA2UIDataChange`, never in the click below.
            "id": "draft",
            "component": "TextField",
            "label": _LABELS["panel.note"],
            "value": {"path": DRAFT_PATH},
        },
        {
            "id": "save",
            "component": "Button",
            "text": _LABELS["panel.save"],
            "variant": "outline",
            "action": ACTION_SAVE_NOTE,
        },
    ]


async def _push_panel(surface_id: str, *, create: bool = False) -> dict[str, Any]:
    note = await _read_note()
    if create:
        await cognia.ctx.a2ui.createSurface(
            surface_id, "panel", {"title": _LABELS["panel.title"]}
        )
    await cognia.ctx.a2ui.updateComponents(surface_id, _panel_components(note))
    # A surface is created with ready=False and every consumer shows a spinner
    # until this flips. Forgetting it is the classic "my panel never renders".
    await cognia.ctx.a2ui.setReady(surface_id)
    return {"ok": True, "surfaceId": surface_id, "note": note}


@tool(
    name="template_build_panel",
    description="Build the context panel's surface. Invoked by the host when the panel opens.",
    parameters={
        "type": "object",
        "properties": {
            "surfaceId": {"type": "string"},
            "resource": {"type": "object"},
        },
        "required": ["surfaceId"],
        "additionalProperties": False,
    },
)
async def template_build_panel(surfaceId: str, resource: dict | None = None) -> dict[str, Any]:
    return await _push_panel(surfaceId, create=True)


def _owns_surface(payload: Any) -> str | None:
    """The surface id when this plugin owns it, else None.

    Both A2UI hooks are broadcasts: every plugin's hook sees every surface's
    traffic. The namespace prefix is what keeps this one answering only for its
    own panel.
    """
    if not isinstance(payload, dict):
        return None
    surface_id = str(payload.get("surfaceId") or "")
    return surface_id if surface_id.startswith("cognia-plugin-template-python:") else None


@hook("onA2UIDataChange")
async def template_panel_data_change(payload: Any) -> Any:
    """Typing in the panel comes back here, one edit at a time.

    It has to be a separate hook: a click reports the BUTTON, not the form, so
    what the user typed reaches the plugin only through this. Holding the draft
    until Save is what stops the button writing an empty note over a real one.
    """
    surface_id = _owns_surface(payload)
    if surface_id is None:
        return payload
    if payload.get("path") != DRAFT_PATH:
        return payload
    _DRAFTS[surface_id] = str(payload.get("value") or "")
    return payload


@hook("onA2UIAction")
async def template_panel_action(payload: Any) -> Any:
    """Clicks in the panel come back here, still with no JavaScript involved."""
    surface_id = _owns_surface(payload)
    if surface_id is None or payload.get("action") != ACTION_SAVE_NOTE:
        return payload

    # The draft, not the click's own payload. `data` on an action is the
    # button's own text, so reading a field out of it wrote "" over whatever
    # the note held every single time Save was pressed.
    draft = _DRAFTS.get(surface_id)
    if draft is None:
        return payload

    await cognia.ctx.fs.writeText(_note_path(), draft)
    _DRAFTS.pop(surface_id, None)
    await _push_panel(surface_id)
    return payload
