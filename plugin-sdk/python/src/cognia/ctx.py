"""``cognia.ctx`` — the host's ``ctx.*`` API surface, reached over RPC.

A Python plugin's process speaks NDJSON over stdio and has no other reach.
``cognia.ctx.agent.run(...)`` therefore writes a ``host_request`` frame; the
host resolves it against the same permission-guarded ``ctx.*`` object a
TypeScript plugin gets, and answers. See ADR-0145.

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
    "CALLBACK_HOST_METHODS",
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


def _callback_methods() -> Dict[str, FrozenSet[str]]:
    """Namespace -> methods that hand the host a function.

    A namespace is open to python as a whole, but a *method* that registers a
    callback (and hands back a disposer to unregister it) cannot work over
    NDJSON in either direction: the function does not serialize on the way in,
    and neither does the disposer on the way out. The contract already marks
    these — ``resourceEffect.kind == "returned-disposer"`` — so the rule is read
    from the same catalog as everything else rather than kept as a list here.

    Python plugins register through the **manifest** instead, which is the whole
    design: a declared contribution is data the host resolves itself.
    """
    return {
        namespace["id"]: frozenset(
            method["name"]
            for method in namespace.get("methods", [])
            if (method.get("resourceEffect") or {}).get("kind") == "returned-disposer"
        )
        for namespace in API_NAMESPACE_CONTRACTS
        if "python" in (namespace.get("runtimes") or ())
    }


#: The contract's answer to "what can a Python plugin call?". Computed once at
#: import; the catalog is a frozen generated artifact, so it cannot change
#: under a running process.
PYTHON_HOST_NAMESPACES: Dict[str, FrozenSet[str]] = _python_namespaces()

#: Methods inside those namespaces that register a host-side callback. Reachable
#: by name, refused when called — see :func:`_callback_methods`.
CALLBACK_HOST_METHODS: Dict[str, FrozenSet[str]] = _callback_methods()


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
    """One ``ctx.<namespace>``, or a group inside it, validated against the contract.

    The contract spells nested groups as dotted method names — ``sessions.create``
    on the ``agent`` namespace — because that is what the TypeScript surface is:
    ``ctx.agent.sessions.create(...)``. Attribute access walks the same shape, so
    a group resolves to another :class:`HostNamespace` and only a leaf resolves
    to a callable. Without this, every grouped method was reachable *only*
    through :meth:`Ctx.call`, and the author surface silently stopped mirroring
    the TypeScript one at the first dot.
    """

    __slots__ = ("_name", "_methods", "_callbacks", "_runtime", "_prefix")

    def __init__(
        self,
        name: str,
        methods: FrozenSet[str],
        runtime: Runtime,
        callbacks: FrozenSet[str] = frozenset(),
        prefix: str = "",
    ) -> None:
        self._name = name
        self._methods = methods
        self._callbacks = callbacks
        self._runtime = runtime
        self._prefix = prefix

    def _children(self) -> FrozenSet[str]:
        """Immediate attribute names at this level: leaves and group heads."""
        depth = len(self._prefix)
        return frozenset(
            method[depth:].split(".", 1)[0]
            for method in self._methods
            if method.startswith(self._prefix)
        )

    def __getattr__(self, attribute: str) -> Any:
        if attribute.startswith("_"):
            raise AttributeError(attribute)
        path = f"{self._prefix}{attribute}"

        if path not in self._methods:
            if any(method.startswith(f"{path}.") for method in self._methods):
                return HostNamespace(
                    self._name,
                    self._methods,
                    self._runtime,
                    self._callbacks,
                    f"{path}.",
                )
            group = "." + self._prefix.rstrip(".") if self._prefix else ""
            raise AttributeError(
                f"ctx.{self._name}{group} has no member '{attribute}'. Available: "
                + ", ".join(sorted(self._children()))
            )

        if path in self._callbacks:
            # Named rather than hidden: the method *is* on the namespace, and
            # saying why it cannot be called beats an "unknown method" error
            # that sends the author looking for a typo.
            raise AttributeError(
                f"ctx.{self._name}.{path} registers a host-side callback, which "
                "cannot cross the plugin's stdio boundary. Declare the "
                "contribution in plugin.json instead."
            )

        namespace = self._name
        runtime = self._runtime

        async def call(*args: Any, **kwargs: Any) -> Any:
            return await runtime.host_call(
                f"{namespace}.{path}", pack_params(args, kwargs)
            )

        call.__name__ = attribute
        call.__qualname__ = f"cognia.ctx.{namespace}.{path}"
        call.__doc__ = f"Host call ``ctx.{namespace}.{path}``. Returns a coroutine."
        return call

    def __dir__(self):
        return sorted(self._children())

    def __repr__(self) -> str:
        path = f".{self._prefix.rstrip('.')}" if self._prefix else ""
        return f"<cognia.ctx.{self._name}{path} ({len(self._children())} members)>"


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
        return HostNamespace(
            namespace,
            methods,
            self.runtime,
            CALLBACK_HOST_METHODS.get(namespace, frozenset()),
        )

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
