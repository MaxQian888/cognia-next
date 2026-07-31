"""Tests for cognia.context — the typed context proxy."""

from __future__ import annotations

import cognia
from cognia import Context, Runtime, create_context


def test_context_reads_config_and_reports_progress():
    rt = Runtime()
    rt.push_config({"greeting": "Hi"})
    events = []
    rt.set_event_sink(lambda e, d, c: events.append((e, d, c)))

    ctx = Context(runtime=rt)
    assert ctx.config == {"greeting": "Hi"}
    assert ctx.get_config() == {"greeting": "Hi"}
    ctx.progress(pct=25)
    assert ("progress", {"pct": 25}, None) in events


def test_context_on_config_changed_delegates_to_runtime():
    rt = Runtime()
    ctx = Context(runtime=rt)
    seen = []
    ctx.on_config_changed(lambda cfg: seen.append(cfg))
    rt.push_config({"k": "v"})
    assert seen == [{"k": "v"}]


def test_context_register_tool_and_hook():
    rt = Runtime()
    ctx = Context(runtime=rt)
    ctx.register_tool(lambda a: a, name="echo")
    ctx.register_hook("e", lambda p: p)
    assert rt.has_tool("echo")
    assert rt.get_hooks()[0]["event"] == "e"


def test_context_log_to_stderr(capsys):
    ctx = Context(runtime=Runtime())
    ctx.log("from", "ctx")
    captured = capsys.readouterr()
    assert "from ctx" in captured.err
    assert captured.out == ""


def test_create_context_defaults_to_active_runtime():
    ctx = create_context()
    assert ctx.runtime is cognia.get_active_runtime()
    assert isinstance(ctx, cognia.PluginContext)
