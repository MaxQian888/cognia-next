"""Tests for cognia.decorators + active-runtime module functions."""

from __future__ import annotations

import cognia
from cognia import get_active_runtime, get_config, hook, log, progress, tool


def test_tool_bare_form_registers_on_active_runtime():
    @tool
    def greet(name: str):
        return f"hi {name}"

    rt = get_active_runtime()
    assert rt.has_tool("greet")
    assert rt.call_tool("greet", {"name": "x"}) == "hi x"


def test_tool_configured_form():
    @tool(name="adder", description="add two")
    def add(a: float, b: float):
        return a + b

    rt = get_active_runtime()
    assert rt.has_tool("adder")
    assert rt.get_tools()[0]["description"] == "add two"


def test_hook_registers_and_dispatches():
    @hook("onMessageSend")
    def stamp(payload):
        payload["seen"] = True
        return payload

    rt = get_active_runtime()
    assert rt.call_hook("onMessageSend", "stamp", {}) == {"seen": True}


def test_module_progress_and_get_config_proxy_active_runtime():
    rt = get_active_runtime()
    events = []
    rt.set_event_sink(lambda e, d, c: events.append((e, d, c)))
    rt.push_config({"greeting": "Yo"})

    assert get_config() == {"greeting": "Yo"}
    progress(pct=10, message="x")
    assert ("progress", {"pct": 10, "message": "x"}, None) in events


def test_set_active_runtime_swaps_target():
    other = cognia.Runtime()
    cognia.set_active_runtime(other)

    @tool
    def t():
        return 1

    assert other.has_tool("t")


def test_log_writes_to_stderr(capsys):
    log("hello", "world")
    captured = capsys.readouterr()
    assert "hello world" in captured.err
    assert captured.out == ""
