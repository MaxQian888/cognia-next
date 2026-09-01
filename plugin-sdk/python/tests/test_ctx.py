"""``cognia.ctx`` — the plugin -> host RPC surface (ADR-0145).

The point of these tests is that the surface is *the contract*, not a copy of
it: a namespace exists here exactly when its catalog entry lists ``python``.
"""

from __future__ import annotations

import asyncio

import pytest

import cognia
from cognia._generated_contract import API_NAMESPACE_CONTRACTS
from cognia.ctx import CALLBACK_HOST_METHODS, PYTHON_HOST_NAMESPACES, Ctx, pack_params
from cognia.runtime import HostCallError, Runtime, reset_active_runtime


@pytest.fixture(autouse=True)
def fresh_runtime():
    yield reset_active_runtime()
    reset_active_runtime()


def _record_calls(runtime: Runtime, result=None):
    seen = []

    def handler(method, params):
        seen.append((method, params))
        return result

    runtime.set_host_call_handler(handler)
    return seen


# -- the surface is the contract -------------------------------------------


def test_namespaces_are_exactly_the_contracts_python_entries():
    expected = {
        namespace["id"]
        for namespace in API_NAMESPACE_CONTRACTS
        if "python" in (namespace.get("runtimes") or ())
    }
    assert set(PYTHON_HOST_NAMESPACES) == expected
    # Guards the direction that matters: someone dropping "python" from the
    # catalog silently removes a capability plugins already depend on.
    assert expected >= {
        "a2ui",
        "agent",
        "chat",
        "contextPanels",
        "fs",
        "git",
        "logger",
        "secrets",
        "storage",
        "ui",
        "workspace",
    }


def test_methods_are_exactly_the_contracts_methods():
    for namespace in API_NAMESPACE_CONTRACTS:
        if "python" not in (namespace.get("runtimes") or ()):
            continue
        expected = {method["name"] for method in namespace["methods"]}
        assert PYTHON_HOST_NAMESPACES[namespace["id"]] == expected
        # `dir()` lists what attribute access resolves at THIS level, so a
        # grouped method contributes its group head (`sessions`) rather than
        # the dotted name — the same shape as the TypeScript object.
        assert set(dir(getattr(cognia.ctx, namespace["id"]))) == {
            name.split(".", 1)[0] for name in expected
        }


def test_grouped_methods_are_reachable_the_way_typescript_spells_them(fresh_runtime):
    # `ctx.agent.sessions.create(...)`, not `ctx.call("agent.sessions.create")`.
    seen = _record_calls(fresh_runtime, result={"id": "s1"})
    assert asyncio.run(cognia.ctx.agent.sessions.create(title="Wiki Q&A")) == {"id": "s1"}
    assert seen == [("agent.sessions.create", {"title": "Wiki Q&A"})]

    group = cognia.ctx.agent.sessions
    assert "create" in dir(group)
    assert "agent.sessions" in repr(group)

    with pytest.raises(AttributeError) as unknown:
        cognia.ctx.agent.sessions.nope
    assert "ctx.agent.sessions has no member 'nope'" in str(unknown.value)


def test_callback_methods_are_named_but_refused():
    # A namespace is open to python as a whole; a method that hands the host a
    # function is not, in either direction. Refusing by name beats a confusing
    # host-side failure after a round trip.
    assert CALLBACK_HOST_METHODS["chat"] == {"use"}
    assert CALLBACK_HOST_METHODS["a2ui"] == {"registerComponent", "registerTemplate"}
    assert "register" in CALLBACK_HOST_METHODS["contextPanels"]

    with pytest.raises(AttributeError) as excinfo:
        cognia.ctx.chat.use
    assert "registers a host-side callback" in str(excinfo.value)
    assert "plugin.json" in str(excinfo.value)


def test_callback_methods_are_derived_from_the_contract_not_a_local_list():
    for namespace in API_NAMESPACE_CONTRACTS:
        if "python" not in (namespace.get("runtimes") or ()):
            continue
        expected = {
            method["name"]
            for method in namespace["methods"]
            if (method.get("resourceEffect") or {}).get("kind") == "returned-disposer"
        }
        assert CALLBACK_HOST_METHODS[namespace["id"]] == expected


def test_the_declarative_panel_surface_is_callable_from_python(fresh_runtime):
    # The half of `contextPanels` / `a2ui` that carries only data is what makes
    # a `kind: "a2ui"` panel work from a Python plugin. If either of these
    # regressed to "namespace withheld", that panel class would be dormant.
    seen = _record_calls(fresh_runtime, result=None)
    asyncio.run(cognia.ctx.a2ui.createSurface(surfaceId="wiki", surfaceType="panel"))
    asyncio.run(cognia.ctx.a2ui.updateComponents(surfaceId="wiki", components=[]))
    asyncio.run(cognia.ctx.contextPanels.reveal(panelId="reader"))
    asyncio.run(cognia.ctx.chat.addContextSelection(title="Overview", snapshot="..."))
    assert [method for method, _ in seen] == [
        "a2ui.createSurface",
        "a2ui.updateComponents",
        "contextPanels.reveal",
        "chat.addContextSelection",
    ]


def test_unknown_namespace_and_method_fail_fast_with_alternatives():
    with pytest.raises(AttributeError) as unknown_namespace:
        cognia.ctx.nope
    assert "no namespace 'nope'" in str(unknown_namespace.value)
    assert "storage" in str(unknown_namespace.value)

    with pytest.raises(AttributeError) as unknown_method:
        cognia.ctx.storage.nope
    assert "has no member 'nope'" in str(unknown_method.value)
    assert "getOrDefault" in str(unknown_method.value)


def test_namespaces_the_contract_withholds_are_not_reachable():
    # `ai` and `db` exist on the TS context but have no python-routable surface.
    # The catalog says so; this proves the SDK honours it rather than exposing
    # them optimistically.
    for withheld in ("ai", "db"):
        assert withheld not in PYTHON_HOST_NAMESPACES
        with pytest.raises(AttributeError):
            getattr(cognia.ctx, withheld)


# -- call shapes ------------------------------------------------------------


def test_pack_params_mirrors_the_host_packing():
    assert pack_params((), {"prompt": "hi"}) == {"prompt": "hi"}
    assert pack_params(("a", 2), {}) == {"args": ["a", 2]}
    assert pack_params(({"prompt": "hi"},), {}) == {"prompt": "hi"}
    assert pack_params((), {}) == {}
    assert pack_params(("a",), {"b": 1}) == {"args": ["a"], "b": 1}


def test_keyword_and_positional_calls_reach_the_handler(fresh_runtime):
    seen = _record_calls(fresh_runtime, result={"text": "ok"})

    assert asyncio.run(cognia.ctx.agent.run(prompt="hi")) == {"text": "ok"}
    assert asyncio.run(cognia.ctx.logger.info("line")) == {"text": "ok"}

    assert seen == [
        ("agent.run", {"prompt": "hi"}),
        ("logger.info", {"args": ["line"]}),
    ]


def test_async_handlers_are_awaited(fresh_runtime):
    async def handler(method, params):
        await asyncio.sleep(0)
        return f"{method}:{params.get('key')}"

    fresh_runtime.set_host_call_handler(handler)
    assert asyncio.run(cognia.ctx.storage.get(key="k")) == "storage.get:k"


def test_run_sync_drives_the_coroutine_off_the_loop(fresh_runtime):
    _record_calls(fresh_runtime, result="done")
    assert cognia.ctx.run_sync(cognia.ctx.ui.showToast(message="hi")) == "done"


def test_run_sync_refuses_inside_a_running_loop(fresh_runtime):
    _record_calls(fresh_runtime, result="done")

    async def main():
        pending = cognia.ctx.ui.showToast(message="hi")
        try:
            with pytest.raises(RuntimeError) as excinfo:
                cognia.ctx.run_sync(pending)
            assert "cannot be called from a running event loop" in str(excinfo.value)
        finally:
            # run_sync raised before awaiting it; closing keeps the suite free
            # of "never awaited" warnings that would mask a real leak later.
            pending.close()

    asyncio.run(main())


def test_call_escape_hatch_bypasses_validation(fresh_runtime):
    seen = _record_calls(fresh_runtime, result=None)
    asyncio.run(cognia.ctx.call("ai.generateText", {"prompt": "hi"}))
    assert seen == [("ai.generateText", {"prompt": "hi"})]


# -- no host attached -------------------------------------------------------


def test_without_a_host_the_call_raises_rather_than_returning_none(fresh_runtime):
    # A silent None from ctx.storage.get reads as a cache miss; that bug
    # survives a test suite. Refusing loudly does not.
    with pytest.raises(HostCallError) as excinfo:
        asyncio.run(cognia.ctx.storage.get(key="k"))
    assert "no host attached" in str(excinfo.value)
    assert "set_host_call_handler" in str(excinfo.value)


def test_context_ctx_is_pinned_to_its_own_runtime():
    own = Runtime()
    seen = _record_calls(own, result="from-own")
    context = cognia.create_context(runtime=own)

    # The active runtime has no handler at all; if `Context.ctx` resolved the
    # active runtime instead of its own, this would raise.
    assert asyncio.run(context.ctx.logger.info("x")) == "from-own"
    assert seen == [("logger.info", {"args": ["x"]})]


def test_module_level_ctx_follows_the_active_runtime():
    first = reset_active_runtime()
    _record_calls(first, result="first")
    assert asyncio.run(cognia.ctx.logger.info("x")) == "first"

    second = reset_active_runtime()
    _record_calls(second, result="second")
    assert asyncio.run(cognia.ctx.logger.info("x")) == "second"


def test_ctx_repr_and_dir_are_useful():
    assert "7 namespaces" in repr(cognia.ctx) or "namespaces" in repr(cognia.ctx)
    assert "storage" in dir(cognia.ctx)
    assert isinstance(Ctx(), Ctx)


def test_team_namespace_is_open_to_python():
    """``ctx.team`` was frontend/hybrid only, so a Python plugin could START a
    Squad through ``ctx.agent.runTeam`` and could not READ one, which inverts
    the safety story ``lib/plugin/api/team-api.ts`` tells about itself."""
    assert "team" in PYTHON_HOST_NAMESPACES


def test_team_carries_reads_writes_and_run_control():
    methods = PYTHON_HOST_NAMESPACES["team"]
    for name in ("listTeams", "listTasks", "moveTask", "instantiateTemplate"):
        assert name in methods, name
    # Run control shipped with this namespace rather than staying only on
    # ``ctx.agent``, so a plugin holding ``ctx.team`` can act on what it reads.
    for name in ("start", "pause", "resume", "stop"):
        assert name in methods, name
