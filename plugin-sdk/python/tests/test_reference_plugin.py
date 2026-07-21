"""End-to-end: a module-style plugin built on the SDK behaves like the host.

Mirrors the patterns in ``plugins/cognia-python-demo/main.py`` (config-driven
tool, streaming generator with progress, transform hook) but runs entirely on
the SDK's reference runtime, proving the drop-in contract.
"""

from __future__ import annotations

import cognia
from cognia import get_config, hook, progress, tool


def _build_demo():
    @tool(description="Greet someone using the configured greeting.")
    def greet(name: str):
        config = get_config()
        greeting = config.get("greeting") or "Hello"
        message = f"{greeting}, {name}!"
        return message.upper() if config.get("shout") else message

    @tool(description="Stream a countdown with progress.")
    def countdown(start: int = 3):
        start = max(1, min(int(start), 10))
        for index in range(start, 0, -1):
            progress(pct=round((start - index + 1) / start * 100), message=f"counting {index}")
            yield f"{index}... "
        yield "liftoff!"

    @hook("onMessageSend")
    def stamp_outgoing(payload):
        if isinstance(payload, dict):
            payload.setdefault("metadata", {})["pythonDemo"] = True
        return payload


def test_reference_plugin_full_protocol_roundtrip():
    _build_demo()
    rt = cognia.get_active_runtime()
    events = []
    rt.set_event_sink(lambda e, d, c: events.append((e, d, c)))

    # get_tools / get_info
    tool_names = {t["name"] for t in rt.dispatch("get_tools")}
    assert tool_names == {"greet", "countdown"}
    assert rt.dispatch("get_info") == {"tool_count": 2, "hook_count": 1, "contribution_count": 0}

    # config-driven tool
    rt.dispatch("push_config", {"config": {"greeting": "Yo", "shout": True}})
    assert rt.dispatch("call_tool", {"name": "greet", "args": {"name": "world"}}) == "YO, WORLD!"

    # streaming tool emits chunk + progress events and joins to a string
    result = rt.dispatch("call_tool", {"name": "countdown", "args": {"start": 2}, "call_id": 1})
    assert result == "2... 1... liftoff!"
    assert any(e[0] == "progress" for e in events)
    assert any(e[0] == "chunk_end" for e in events)

    # transform hook
    out = rt.dispatch(
        "call_hook",
        {"event": "onMessageSend", "name": "stamp_outgoing", "payload": {"text": "hi"}},
    )
    assert out["metadata"]["pythonDemo"] is True
