"""Cognia Python runtime reference plugin.

Exercises every host feature end-to-end and doubles as living
documentation for plugin authors:

  * ``@tool``            — plain tools with inferred / explicit parameters
  * generator tools      — each ``yield`` streams a chunk event to the UI
  * ``cognia.progress``  — progress frames for long-running work
  * ``@hook``            — host-dispatched event handlers (transform style)
  * lifecycle            — ``on_startup`` / ``on_config_updated`` /
                           ``on_shutdown`` module conventions
  * ``cognia.get_config`` — the user's persisted configSchema values
  * ``cognia.ctx``       — the plugin -> host RPC surface (ADR-0145): reach
                           the same ``ctx.*`` APIs a TypeScript plugin gets,
                           from sync *and* async tools
  * ``ctx.i18n.t``       — user-facing strings from ``plugin.json``
                           ``i18n.locales`` (see ``_panel_labels``)

Stdlib only; no pythonDependencies, so it loads on any Python >= 3.9.

Copying this as a template? Delete the ``OPTIONAL, HIGH-RISK`` section below
(``onMessageSend``) together with the ``hooks:chat-intercept`` permission
unless your plugin genuinely needs to read and rewrite every outgoing message.
"""

import asyncio
import time

import cognia
from cognia import get_config, hook, progress, tool


def _format(text):
    config = get_config()
    greeting = config.get("greeting") or "Hello"
    message = f"{greeting}, {text}!"
    return message.upper() if config.get("shout") else message


#: Every surface this plugin creates starts with this — the manifest's
#: ``surface: "cognia-python-demo:{resourceKey}"``. ``onA2UIAction`` is a
#: broadcast to every plugin, so the prefix is how the hook knows a click is ours.
SURFACE_PREFIX = "cognia-python-demo:"

#: A2UI action names are namespaced for the same reason.
ACTION_OPEN_SECTION = "python-demo:open-section"

#: The panel's user-facing strings and their English defaults. The
#: translations live in plugin.json ``i18n.locales`` (en + zh-CN); the host
#: prefixes them with ``plugin.cognia-python-demo.`` itself, so the keys here
#: are the flat ones from the manifest.
PANEL_LABELS = {
    "panel.title": "Python demo",
    "panel.heading": "Python demo panel",
    "panel.intro": (
        "This panel is **declarative**: plugin.json names a surface and a build "
        "tool, and the host renders the A2UI components that tool pushes — no "
        "JavaScript module, no webview."
    ),
    "panel.outline.runtime": "Runtime",
    "panel.outline.frames": "Frames",
    "panel.outline.environments": "Environments",
}

#: Code and a diagram — the same in every language, so not translated.
_PANEL_REFERENCE = """```json
{ "kind": "a2ui", "surface": "cognia-python-demo:{resourceKey}", "activateTool": "build_demo_panel" }
```

```mermaid
sequenceDiagram
    Host->>Plugin: call build_demo_panel(surfaceId)
    Plugin->>Host: a2ui.createSurface / updateComponents
    Plugin->>Host: a2ui.setReady
    Host-->>Plugin: onA2UIAction (clicks)
```
"""


def on_startup():
    print(f"cognia-python-demo started with config: {get_config()}")


def on_config_updated(config):
    print(f"cognia-python-demo config updated: {config}")


def on_shutdown():
    print("cognia-python-demo shutting down")


@tool(description="Greet someone using the configured greeting.")
def greet(name: str):
    return _format(name)


@tool(description="Add two numbers.")
def add(a: float, b: float):
    return a + b


@tool(
    name="word_stats",
    description="Count words and characters in a text.",
    parameters={
        "text": {"type": "string", "required": True, "description": "Text to analyze"},
    },
)
def word_stats(text):
    words = text.split()
    return {
        "words": len(words),
        "characters": len(text),
        "longest": max(words, key=len) if words else "",
    }


@tool(description="Stream a countdown, one chunk per step, with progress.")
def countdown(start: int = 3):
    start = max(1, min(int(start), 10))
    for index in range(start, 0, -1):
        progress(pct=round((start - index + 1) / start * 100), message=f"counting {index}")
        yield f"{index}... "
        time.sleep(0.05)
    yield "liftoff!"


# ---------------------------------------------------------------------------
# OPTIONAL, HIGH-RISK EXAMPLE — chat interception.
#
# `onMessageSend` sees, and can rewrite, EVERY outgoing chat message. It is
# here only to demonstrate the transform-hook shape (and the host's test suite
# round-trips it). A real plugin should not copy it: delete this hook AND the
# `hooks:chat-intercept` permission from plugin.json unless reading the whole
# conversation is the plugin's actual job. The two must go together — a
# chat-interception hook without the permission aborts the entire Python load.
# ---------------------------------------------------------------------------


@hook("onMessageSend")
def stamp_outgoing(payload):
    """Transform hook: tag outgoing chat payloads (dict in, dict out).

    ``onMessageSend`` is a CHAT-INTERCEPTION hook: it sees, and can rewrite,
    every outgoing message. The host therefore refuses to register any hook in
    that family unless the manifest declares ``hooks:chat-intercept`` — and the
    refusal aborts the whole Python load, not just this hook, leaving the plugin
    in ``error``. If you copy this template and do not need to see the
    conversation, drop both the permission and this hook.
    """
    if isinstance(payload, dict):
        payload.setdefault("metadata", {})["pythonDemo"] = True
    return payload


@tool(description="Log a line through the host (ctx.logger.info) and confirm the round trip.")
async def host_log(message: str = "hello from python") -> str:
    """Async tool calling the host — the natural shape for `ctx.*`.

    `cognia.ctx.<namespace>.<method>(...)` is a coroutine: it writes a
    `host_request` frame and suspends until the host answers. The host loop
    keeps serving other requests meanwhile, so a blocked tool never stalls the
    plugin.
    """
    await cognia.ctx.logger.info(message)
    return f"host logged: {message}"


@tool(description="Same host call from a synchronous tool, via ctx.run_sync.")
def host_log_sync(message: str = "hello from a sync tool") -> str:
    """Sync tools run on a worker thread, so they must bridge explicitly.

    `cognia.ctx.run_sync` blocks *this thread* on the coroutine — it refuses to
    run on the event loop, where blocking would deadlock the reader that has to
    deliver the answer.
    """
    cognia.ctx.run_sync(cognia.ctx.logger.info(message))
    return f"host logged (sync): {message}"


@tool(description="Fan out concurrent host calls to show the loop stays responsive.")
async def host_fanout(count: int = 3) -> list:
    """Concurrency is real: these calls overlap.

    RepoWiki's per-module analysis leans on exactly this — N agent turns in
    flight at once, bounded by the host's outbound gate rather than serialized
    one behind another.
    """
    count = max(1, min(int(count), 5))
    results = await asyncio.gather(
        *[cognia.ctx.logger.info(f"fanout {index}") for index in range(count)]
    )
    return [str(item) for item in results]


# ---------------------------------------------------------------------------
# Declarative context panel
# ---------------------------------------------------------------------------


async def _panel_labels() -> dict:
    """The panel's strings in the app's language, via ``ctx.i18n.t``.

    ``t`` resolves against this plugin's own manifest bundle (current locale,
    then English) and echoes the key back when nothing matched, so an echoed
    key — or a host with no i18n namespace — keeps the English default rather
    than painting a raw dotted key into the panel. The calls are independent,
    so they go out concurrently.
    """

    async def resolve(key, fallback):
        try:
            value = await cognia.ctx.i18n.t(key)
        except Exception:  # noqa: BLE001 — a missing translation is not a failure
            return fallback
        return value if isinstance(value, str) and value and value != key else fallback

    values = await asyncio.gather(
        *[resolve(key, fallback) for key, fallback in PANEL_LABELS.items()]
    )
    return dict(zip(PANEL_LABELS, values))


@tool(
    name="build_demo_panel",
    description="Build the plugin's context-panel surface. Invoked by the host on first activation.",
    parameters={
        "surfaceId": {
            "type": "string",
            "required": True,
            "description": "Surface the panel renders",
        },
        "resource": {
            "type": "object",
            "required": False,
            "description": "The resource the panel is scoped to",
        },
    },
)
async def build_demo_panel(surfaceId, resource=None):
    """The Python half of a declarative `kind: "a2ui"` context panel.

    The manifest names this tool as the panel's ``activateTool``; the host calls
    it the first time the panel is shown for a resource, with the surface id it
    resolved from ``surface: "cognia-python-demo:{resourceKey}"``. There is no
    callback and no JavaScript anywhere in the path — the panel body is data
    this function pushes.

    The root component's id must be ``"root"``: that is what the surface is
    created with, and no message changes it.
    """
    kind = (resource or {}).get("kind", "unknown")
    text = await _panel_labels()
    body = f"## {text['panel.heading']}\n\n{text['panel.intro']}\n\n{_PANEL_REFERENCE}"
    await cognia.ctx.a2ui.createSurface(surfaceId, "panel", {"title": text["panel.title"]})
    await cognia.ctx.a2ui.updateComponents(
        surfaceId,
        [
            {"id": "root", "component": "Column", "children": ["outline", "body"], "gap": 12},
            {
                "id": "outline",
                "component": "Tree",
                "action": ACTION_OPEN_SECTION,
                "defaultExpandedDepth": 1,
                "nodes": [
                    {
                        "id": "runtime",
                        "label": text["panel.outline.runtime"],
                        "icon": "cpu",
                        "children": [
                            {
                                "id": "runtime/frames",
                                "label": text["panel.outline.frames"],
                                "icon": "file-text",
                            },
                            {
                                "id": "runtime/venv",
                                "label": text["panel.outline.environments"],
                                "icon": "package",
                            },
                        ],
                    },
                    # The resource kind is data, not chrome: shown as-is.
                    {"id": "resource", "label": kind, "icon": "link"},
                ],
            },
            {
                "id": "body",
                "component": "Markdown",
                "content": body,
            },
        ],
    )
    # Surfaces are created `ready: false`; without this the panel spins forever.
    await cognia.ctx.a2ui.setReady(surfaceId)
    return {"surfaceId": surfaceId, "resourceKind": kind}


@hook("onA2UIAction")
def demo_panel_action(payload):
    """Clicks in the panel arrive here — the return trip, with no JS either.

    A2UI actions are dispatched to every plugin's ``onA2UIAction`` hook, which
    the Python runtime has always supported; the panel class added in ADR-0145
    is what finally gives a Python plugin a surface to receive them from.

    Because it is a broadcast, the hook answers only for surfaces this plugin
    created (``SURFACE_PREFIX``) and actions it named (``ACTION_OPEN_SECTION``);
    everything else passes through untouched.
    """
    if not isinstance(payload, dict):
        return payload
    surface_id = payload.get("surfaceId") or ""
    if not isinstance(surface_id, str) or not surface_id.startswith(SURFACE_PREFIX):
        return payload
    if payload.get("action") == ACTION_OPEN_SECTION:
        data = payload.get("data") or {}
        cognia.log(f"python demo panel: section {data.get('nodeId')}")
    return payload
