"""``cognia.ctx`` — the plugin -> host RPC surface (ADR-0143).

The point of these tests is that the surface is *the contract*, not a copy of
it: a namespace exists here exactly when its catalog entry lists ``python``.
"""

from __future__ import annotations

import asyncio

import pytest

import cognia
from cognia._generated_contract import API_NAMESPACE_CONTRACTS
from cognia.ctx import PYTHON_HOST_NAMESPACES, Ctx, pack_params
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
    assert expected >= {"agent", "storage", "secrets", "fs", "git", "ui", "logger"}


def test_methods_are_exactly_the_contracts_methods():
    for namespace in API_NAMESPACE_CONTRACTS:
        if "python" not in (namespace.get("runtimes") or ()):
            continue
        expected = {method["name"] for method in namespace["methods"]}
        assert PYTHON_HOST_NAMESPACES[namespace["id"]] == expected
        assert set(dir(getattr(cognia.ctx, namespace["id"]))) == expected


def test_unknown_namespace_and_method_fail_fast_with_alternatives():
    with pytest.raises(AttributeError) as unknown_namespace:
        cognia.ctx.nope
    assert "no namespace 'nope'" in str(unknown_namespace.value)
    assert "storage" in str(unknown_namespace.value)

    with pytest.raises(AttributeError) as unknown_method:
        cognia.ctx.storage.nope
    assert "has no method 'nope'" in str(unknown_method.value)
    assert "getOrDefault" in str(unknown_method.value)


def test_namespaces_the_contract_withholds_are_not_reachable():
    # contextPanels/chat/workspace exist on the TS context but their consumer
    # surfaces are not python-routable yet. The catalog says so; this proves
    # the SDK honours it rather than exposing them optimistically.
    for withheld in ("contextPanels", "chat", "workspace"):
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
    asyncio.run(cognia.ctx.call("chat.addContextSelection", {"kind": "wiki"}))
    assert seen == [("chat.addContextSelection", {"kind": "wiki"})]


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
