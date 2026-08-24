"""``cognia.ctx`` — the host's ``ctx.*`` API surface, reached over RPC.

A Python plugin's process speaks NDJSON over stdio and has no other reach.
``cognia.ctx.agent.run(...)`` therefore writes a ``host_request`` frame; the
host resolves it against the same permission-guarded ``ctx.*`` object a
TypeScript plugin gets, and answers. See ADR-0143.

**The method table is not written here.** It is read from
:data:`API_NAMESPACE_CONTRACTS`, the generated mirror of
``packages/plugin-sdk/contract/catalog.json`` — the same catalog the host, the
Rust linter and the TypeScript validator read. A namespace appears here when,
and only when, its contract entry lists ``python`` among its ``runtimes``.
Copying the table into this file would create a second source of truth to
drift, which is precisely the failure ADR-0087 recorded when the SDK shipped
helpers for capabilities Python could not execute.

Two implementations of this surface exist, deliberately:

* this one, used offline — in unit tests, a REPL, or ``python main.py`` —
  where calls go to a handler you attach with
  ``runtime.set_host_call_handler(...)``;
* the embedded host's, which installs its own ``cognia`` module into
  ``sys.modules`` before importing the plugin and performs the real RPC.

They accept identical call shapes. This one additionally *validates* the
namespace and method against the contract, so a typo fails immediately with a
list of what is available instead of after a host round trip.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Dict, FrozenSet, Optional

from ._generated_contract import API_NAMESPACE_CONTRACTS
from .runtime import HostCallError, Runtime, get_active_runtime

__all__ = [
    "Ctx",
    "HostCallError",
    "HostNamespace",
    "PYTHON_HOST_NAMESPACES",
    "ctx",
    "pack_params",
]


def _python_namespaces() -> Dict[str, FrozenSet[str]]:
    """Namespace -> method names, for every contract entry open to python."""
    return {
        namespace["id"]: frozenset(
            method["name"] for method in namespace.get("methods", [])
        )
        for namespace in API_NAMESPACE_CONTRACTS
        if "python" in (namespace.get("runtimes") or ())
    }


#: The contract's answer to "what can a Python plugin call?". Computed once at
#: import; the catalog is a frozen generated artifact, so it cannot change
#: under a running process.
PYTHON_HOST_NAMESPACES: Dict[str, FrozenSet[str]] = _python_namespaces()


def pack_params(args: tuple, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize a call site onto the wire's single ``params`` object.

    Mirrors ``_pack_params`` in the embedded host, byte for byte in behaviour:
    keywords become the object itself; a lone positional mapping passes
    through; anything else is wrapped as ``{"args": [...]}``.
    """
    if kwargs and not args:
        return dict(kwargs)
    if len(args) == 1 and isinstance(args[0], dict) and not kwargs:
        return dict(args[0])
    params: Dict[str, Any] = {"args": list(args)} if args else {}
    params.update(kwargs)
    return params


class HostNamespace:
    """One ``ctx.<namespace>``, validated against the contract."""

    __slots__ = ("_name", "_methods", "_runtime")

    def __init__(self, name: str, methods: FrozenSet[str], runtime: Runtime) -> None:
        self._name = name
        self._methods = methods
        self._runtime = runtime

    def __getattr__(self, method: str) -> Any:
        if method.startswith("_"):
            raise AttributeError(method)
        if method not in self._methods:
            raise AttributeError(
                f"ctx.{self._name} has no method '{method}'. Available: "
                + ", ".join(sorted(self._methods))
            )
        namespace = self._name
        runtime = self._runtime

        async def call(*args: Any, **kwargs: Any) -> Any:
            return await runtime.host_call(
                f"{namespace}.{method}", pack_params(args, kwargs)
            )

        call.__name__ = method
        call.__qualname__ = f"cognia.ctx.{namespace}.{method}"
        call.__doc__ = f"Host call ``ctx.{namespace}.{method}``. Returns a coroutine."
        return call

    def __dir__(self):
        return sorted(self._methods)

    def __repr__(self) -> str:
        return f"<cognia.ctx.{self._name} ({len(self._methods)} methods)>"


class Ctx:
    """Attribute proxy over every namespace the contract opens to python."""

    __slots__ = ("_runtime",)

    def __init__(self, runtime: Optional[Runtime] = None) -> None:
        self._runtime = runtime

    @property
    def runtime(self) -> Runtime:
        # Resolved per access, not captured: tests swap the active runtime
        # between cases, and a captured reference would keep answering from
        # the runtime that existed when `cognia.ctx` was first imported.
        return self._runtime or get_active_runtime()

    def __getattr__(self, namespace: str) -> HostNamespace:
        if namespace.startswith("_"):
            raise AttributeError(namespace)
        methods = PYTHON_HOST_NAMESPACES.get(namespace)
        if methods is None:
            raise AttributeError(
                f"ctx has no namespace '{namespace}' available to python plugins. "
                "Available: " + ", ".join(sorted(PYTHON_HOST_NAMESPACES))
            )
        return HostNamespace(namespace, methods, self.runtime)

    def __dir__(self):
        return sorted(PYTHON_HOST_NAMESPACES)

    async def call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Escape hatch: invoke ``<namespace>.<method>`` by name, unvalidated.

        For reaching a namespace the contract has not yet opened to python.
        The host still decides — an unavailable namespace comes back as an
        error, not silence.
        """
        return await self.runtime.host_call(method, params)

    def run_sync(
        self, awaitable: Awaitable[Any], timeout: Optional[float] = None
    ) -> Any:
        """Block on a ``ctx.*`` coroutine from synchronous plugin code.

        The embedded host runs sync tools on a worker thread and bridges to its
        event loop here. Offline there is no loop to bridge to, so this simply
        drives the coroutine — and refuses when a loop is already running,
        where blocking would deadlock rather than wait.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise RuntimeError(
                "cognia.ctx.run_sync() cannot be called from a running event loop — "
                "await the coroutine instead"
            )
        if timeout is not None:
            return asyncio.run(asyncio.wait_for(_as_coroutine(awaitable), timeout))
        return asyncio.run(_as_coroutine(awaitable))

    def __repr__(self) -> str:
        return f"<cognia.ctx ({len(PYTHON_HOST_NAMESPACES)} namespaces)>"


async def _as_coroutine(awaitable: Awaitable[Any]) -> Any:
    return await awaitable


#: Module-level singleton mirroring the host shim's ``cognia.ctx``.
ctx = Ctx()
