"""Tests for cognia.plugin — the class-based Plugin base."""

from __future__ import annotations

from cognia import Plugin, Runtime


class Greeter(Plugin):
    name = "greeter"

    @Plugin.tool(description="Greet someone.")
    def greet(self, who: str):
        return f"{self.context.config.get('greeting', 'Hello')}, {who}!"

    @Plugin.tool(name="adder")
    def add(self, a: float, b: float):
        return a + b

    @Plugin.hook("onMessageSend")
    def stamp(self, payload):
        payload["greeter"] = True
        return payload

    def helper(self, x):  # not a tool — must NOT be registered
        return x


def test_plugin_registers_bound_tools_and_hooks():
    rt = Runtime()
    plugin = Greeter(runtime=rt)

    names = {definition["name"] for definition in plugin.tool_definitions()}
    assert names == {"greet", "adder"}
    assert rt.get_hooks() == [{"event": "onMessageSend", "name": "stamp"}]


def test_plugin_tools_call_with_instance_state():
    rt = Runtime()
    rt.push_config({"greeting": "Yo"})
    Greeter(runtime=rt)

    assert rt.call_tool("greet", {"who": "world"}) == "Yo, world!"
    assert rt.call_tool("adder", {"a": 2, "b": 5}) == 7


def test_plugin_hook_dispatch():
    rt = Runtime()
    Greeter(runtime=rt)
    assert rt.call_hook("onMessageSend", "stamp", {}) == {"greeter": True}


def test_plugin_tool_signature_excludes_self():
    rt = Runtime()
    Greeter(runtime=rt)
    greet_def = next(d for d in rt.get_tools() if d["name"] == "greet")
    assert "self" not in greet_def["parameters"]
    assert greet_def["parameters"]["who"] == {"type": "string", "required": True}


def test_plugin_display_name_falls_back_to_class():
    class Unnamed(Plugin):
        pass

    assert Unnamed(runtime=Runtime()).display_name == "Unnamed"
    assert Greeter(runtime=Runtime()).display_name == "greeter"


def test_plugin_defaults_to_active_runtime():
    import cognia

    plugin = Greeter()
    assert plugin.runtime is cognia.get_active_runtime()


def test_plugin_bare_tool_marker_uses_method_name():
    class Bare(Plugin):
        @Plugin.tool
        def ping(self):
            return "pong"

    rt = Runtime()
    Bare(runtime=rt)
    assert rt.has_tool("ping")
    assert rt.call_tool("ping", {}) == "pong"
