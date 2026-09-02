"""``ctx.commands`` from a python plugin, end to end on the reference runtime.

A python plugin registers its slash commands declaratively in ``plugin.json``
(``manifest.commands``) and answers them from ``@hook("onCommand")``. The
host's commands bridge hands that hook ONE invocation dict::

    {"command": "hello", "args": ["a", "b"], "sessionId": "s1"}

and reads back ``True`` / ``False`` / ``{"handled": bool, "message": str}``.
Inside the handler the plugin may reach the host's command registry through
``cognia.ctx.commands`` now that the contract opens the namespace to python.
The methods that hand the host a callback (``registerSlashCommand``) stay
refused by name: a python plugin registers commands in the manifest instead.
"""

from __future__ import annotations

import asyncio

import pytest

import cognia
from cognia import hook
from cognia._generated_contract import API_NAMESPACE_CONTRACTS
from cognia.ctx import CALLBACK_HOST_METHODS, PYTHON_HOST_NAMESPACES


def _namespace(namespace_id):
    return next(ns for ns in API_NAMESPACE_CONTRACTS if ns["id"] == namespace_id)


def _build_commands_plugin():
    """The example plugin: one command that lists what the host knows."""

    @hook("onCommand")
    async def on_command(invocation):
        if not isinstance(invocation, dict):
            return {"handled": False}
        if invocation.get("command") != "hello":
            return {"handled": False}
        registered = await cognia.ctx.commands.listSlashCommands()
        names = ", ".join(sorted(entry["name"] for entry in registered))
        who = invocation.get("sessionId") or "nowhere"
        return {
            "handled": True,
            "message": f"hello from python ({len(registered)} commands: {names}) in {who}",
            "payload": {"args": list(invocation.get("args") or [])},
        }

    return on_command


# -- the contract opens the namespace ---------------------------------------


def test_commands_and_templates_are_open_to_python():
    for namespace_id in ("commands", "templates"):
        assert "python" in _namespace(namespace_id)["runtimes"]
        assert namespace_id in PYTHON_HOST_NAMESPACES


def test_commands_reads_and_custom_command_crud_are_callable():
    assert PYTHON_HOST_NAMESPACES["commands"] >= {
        "unregisterSlashCommand",
        "listSlashCommands",
        "listCustomCommands",
        "getCustomCommand",
        "saveCustomCommand",
        "deleteCustomCommand",
    }
    for name in ("listSlashCommands", "saveCustomCommand", "unregisterSlashCommand"):
        assert callable(getattr(cognia.ctx.commands, name))


def test_register_slash_command_is_refused_by_name_because_it_takes_a_handler():
    assert CALLBACK_HOST_METHODS["commands"] == {"registerSlashCommand"}
    with pytest.raises(AttributeError) as excinfo:
        cognia.ctx.commands.registerSlashCommand
    assert "plugin.json" in str(excinfo.value)


def test_templates_callbacks_are_refused_and_the_rest_is_callable():
    assert CALLBACK_HOST_METHODS["templates"] == {"register", "registerMany", "subscribe"}
    for name in ("query", "get", "list", "createDraft", "preflight", "instantiate"):
        assert callable(getattr(cognia.ctx.templates, name))
    with pytest.raises(AttributeError):
        cognia.ctx.templates.subscribe


# -- the example plugin round trip -----------------------------------------


def _attach_host(runtime, registry):
    seen = []

    async def host(method, params):
        seen.append((method, params))
        if method == "commands.listSlashCommands":
            return registry
        raise AssertionError(f"unexpected host call {method}")

    runtime.set_host_call_handler(host)
    return seen


def test_command_hook_lists_commands_through_ctx_and_answers_structured(fresh_runtime):
    _build_commands_plugin()
    seen = _attach_host(
        fresh_runtime,
        [
            {"id": "py.hello", "name": "hello", "source": "plugin"},
            {"id": "py.stats", "name": "stats", "source": "plugin"},
        ],
    )
    assert fresh_runtime.dispatch("get_info")["hook_count"] == 1
    assert fresh_runtime.get_hooks() == [{"event": "onCommand", "name": "on_command"}]

    result = fresh_runtime.dispatch(
        "call_hook",
        {
            "event": "onCommand",
            "name": "on_command",
            "payload": {"command": "hello", "args": ["a", "b"], "sessionId": "s1"},
        },
    )

    assert result == {
        "handled": True,
        "message": "hello from python (2 commands: hello, stats) in s1",
        "payload": {"args": ["a", "b"]},
    }
    assert seen == [("commands.listSlashCommands", {})]


def test_command_hook_declines_a_command_it_does_not_own(fresh_runtime):
    _build_commands_plugin()
    seen = _attach_host(fresh_runtime, [])
    result = fresh_runtime.dispatch(
        "call_hook",
        {"event": "onCommand", "name": "on_command", "payload": {"command": "other", "args": []}},
    )
    assert result == {"handled": False}
    assert seen == []


def test_command_hook_survives_the_legacy_positional_payload(fresh_runtime):
    # A host without the commands bridge packs `[command, argv, context]`.
    # The example declines rather than crashing on the list shape.
    _build_commands_plugin()
    _attach_host(fresh_runtime, [])
    result = fresh_runtime.dispatch(
        "call_hook",
        {"event": "onCommand", "name": "on_command", "payload": ["hello", [], None]},
    )
    assert result == {"handled": False}


def test_async_hook_is_awaited_like_the_embedded_host_does(fresh_runtime):
    @hook("onMessageSend")
    async def stamp(payload):
        await asyncio.sleep(0)
        return {**payload, "stamped": True}

    result = fresh_runtime.dispatch(
        "call_hook", {"event": "onMessageSend", "name": "stamp", "payload": {"text": "hi"}}
    )
    assert result == {"text": "hi", "stamped": True}


def test_ctx_commands_call_without_a_host_fails_loudly(fresh_runtime):
    with pytest.raises(cognia.runtime.HostCallError):
        asyncio.run(cognia.ctx.commands.listSlashCommands())
