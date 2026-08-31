"""Tests for cognia.runtime — the reference host engine."""

from __future__ import annotations

import pytest

from cognia.runtime import Runtime


def assert_current_handshake(info):
    assert info["sdk_version"] == "0.3.0"
    assert info["protocol_version"] == "2.0.0"
    assert info["contract_version"] == "1.2.0"
    assert info["runtime_id"] == "python"
    assert info["legacy_adapter"] is False
    assert set(info["capabilities"]) >= {"tools", "hooks", "contributions"}


def test_register_and_get_tools_infers_definition():
    rt = Runtime()

    def greet(name: str):
        """Say hi."""
        return f"hi {name}"

    rt.register_tool(greet)
    tools = rt.get_tools()
    assert tools == [
        {
            "name": "greet",
            "description": "Say hi.",
            "parameters": {"name": {"type": "string", "required": True}},
        }
    ]
    assert rt.has_tool("greet")
    info = rt.get_info()
    assert_current_handshake(info)
    assert info["tool_count"] == 1
    assert info["hook_count"] == 0
    assert info["contribution_count"] == 0


def test_register_tool_explicit_overrides_win():
    rt = Runtime()

    def fn(text):
        return text

    rt.register_tool(
        fn,
        name="word_stats",
        description="Count words.",
        parameters={"text": {"type": "string", "required": True}},
    )
    assert rt.get_tools()[0]["name"] == "word_stats"
    assert rt.get_tools()[0]["description"] == "Count words."


def test_call_tool_plain_and_unknown():
    rt = Runtime()
    rt.register_tool(lambda a, b: a + b, name="add")
    assert rt.call_tool("add", {"a": 2, "b": 3}) == 5
    with pytest.raises(RuntimeError, match="unknown tool: nope"):
        rt.call_tool("nope", {})


def test_call_tool_streaming_joins_strings_and_emits_events():
    rt = Runtime()
    events = []
    rt.set_event_sink(lambda event, data, call_id: events.append((event, data, call_id)))

    def countdown():
        for i in range(2, 0, -1):
            yield f"{i}... "
        yield "go"

    rt.register_tool(countdown)
    result = rt.dispatch("call_tool", {"name": "countdown", "call_id": 7})
    assert result == "2... 1... go"
    kinds = [e[0] for e in events]
    assert kinds == ["chunk", "chunk", "chunk", "chunk_end"]
    # Each chunk carries the in-flight call id.
    assert all(e[2] == 7 for e in events)


def test_call_tool_streaming_non_string_returns_list():
    rt = Runtime()

    def nums():
        yield 1
        yield 2

    rt.register_tool(nums)
    assert rt.call_tool("nums", {}) == [1, 2]


def test_call_tool_rejects_non_serializable_result():
    rt = Runtime()
    rt.register_tool(lambda: object(), name="bad")
    with pytest.raises(TypeError, match="non-JSON-serializable"):
        rt.call_tool("bad", {})


def test_hooks_register_call_and_missing():
    rt = Runtime()

    def stamp(payload):
        payload["stamped"] = True
        return payload

    rt.register_hook("onMessageSend", stamp)
    assert rt.get_hooks() == [{"event": "onMessageSend", "name": "stamp"}]
    assert rt.call_hook("onMessageSend", "stamp", {"x": 1}) == {"x": 1, "stamped": True}
    with pytest.raises(RuntimeError, match="no hook named"):
        rt.call_hook("onMessageSend", "absent", {})


def test_config_push_and_get():
    rt = Runtime()
    assert rt.get_config() == {}
    rt.push_config({"greeting": "Yo"})
    assert rt.get_config() == {"greeting": "Yo"}
    rt.push_config(None)
    assert rt.get_config() == {}


def test_module_level_on_config_changed_proxies_active_runtime():
    import cognia

    seen = []
    cognia.on_config_changed(lambda cfg: seen.append(cfg))
    cognia.get_active_runtime().push_config({"a": 1})
    assert seen == [{"a": 1}]


def test_on_config_changed_fires_listeners_on_push():
    rt = Runtime()
    seen = []
    rt.on_config_changed(lambda cfg: seen.append(cfg))
    rt.push_config({"a": 1})
    rt.push_config({"a": 2})
    assert seen == [{"a": 1}, {"a": 2}]


def test_on_config_changed_listener_error_is_isolated():
    rt = Runtime()
    seen = []

    def boom(_cfg):
        raise RuntimeError("nope")

    rt.on_config_changed(boom)
    rt.on_config_changed(lambda cfg: seen.append(cfg))
    rt.push_config({"a": 1})
    assert seen == [{"a": 1}]


def test_progress_emits_with_current_call_id_during_dispatch():
    rt = Runtime()
    events = []
    rt.set_event_sink(lambda event, data, call_id: events.append((event, data, call_id)))

    def work():
        rt.progress(pct=50, message="half")
        return "done"

    rt.register_tool(work)
    assert rt.dispatch("call_tool", {"name": "work", "call_id": 9}) == "done"
    assert ("progress", {"pct": 50, "message": "half"}, 9) in events


def test_dispatch_protocol_methods():
    rt = Runtime()
    rt.register_tool(lambda: "ok", name="t")
    assert rt.dispatch("ping") == "pong"
    assert rt.dispatch("get_tools")[0]["name"] == "t"
    info = rt.dispatch("get_info")
    assert_current_handshake(info)
    assert info["tool_count"] == 1
    assert info["hook_count"] == 0
    assert info["contribution_count"] == 0
    assert rt.dispatch("push_config", {"config": {"a": 1}}) is None
    assert rt.get_config() == {"a": 1}
    with pytest.raises(RuntimeError, match="unknown method"):
        rt.dispatch("frobnicate")


def test_dispatch_call_hook_clears_call_id():
    rt = Runtime()
    rt.register_hook("e", lambda p: p)
    # name resolved from the lambda's __name__ ("<lambda>")
    assert rt.dispatch("call_hook", {"event": "e", "name": "<lambda>", "payload": 1}) == 1
    assert rt._current_call_id is None


def test_reset_clears_everything():
    rt = Runtime()
    rt.register_tool(lambda: 1, name="t")
    rt.register_hook("e", lambda p: p)
    rt.push_config({"a": 1})
    rt.reset()
    assert rt.get_tools() == []
    assert rt.get_hooks() == []
    assert rt.get_config() == {}
