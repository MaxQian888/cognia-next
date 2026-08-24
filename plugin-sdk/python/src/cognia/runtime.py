"""Reference plugin runtime — a pure-Python mirror of the Tauri Python host.

The embedded host (`src-tauri/src/plugin_api/python/host.py`) registers tools
and hooks into module globals and answers an NDJSON method table
(``ping`` / ``get_tools`` / ``call_tool`` / ``call_hook`` / ``push_config`` /
``get_info``). This module re-implements that registry + dispatch loop as a
real, testable object so plugin authors can exercise their tools standalone
(in unit tests, in a REPL, or when running ``python main.py`` directly) and
get byte-identical behaviour to production — including generator streaming and
JSON-serialisability enforcement.

At runtime inside the Tauri shell the host installs its own ``cognia`` shim
into ``sys.modules`` *before* importing the plugin, so the plugin's
``from cognia import tool`` binds to the host shim, not this package. This
package is the standalone/reference implementation of the identical contract.
"""

from __future__ import annotations

import collections.abc
import inspect
import sys
from typing import Any, Callable, Dict, List, Optional

from ._generated_contract import CONTRACT_VERSION, PROTOCOL_VERSION, SDK_VERSION

from .types import (
    HookRegistration,
    RegisteredTool,
    ToolDefinition,
    ToolFn,
    ensure_serializable,
    infer_parameters,
)

# Notification sink: receives ``(event, data, call_id)`` for progress / chunk /
# chunk_end frames, mirroring the host's event channel.
EventSink = Callable[[str, Any, Optional[int]], None]

# Answers a ``cognia.ctx.*`` call. May be sync or async; the return value is
# whatever the host's ``ctx.<namespace>.<method>`` produced.
HostCallHandler = Callable[[str, Dict[str, Any]], Any]


class HostCallError(RuntimeError):
    """A ``cognia.ctx.*`` call the host refused, or that had no host at all."""


class Runtime:
    """A registry + dispatch engine matching the host protocol."""

    def __init__(self) -> None:
        self._tools: Dict[str, RegisteredTool] = {}
        self._hooks: List[HookRegistration] = []
        self._config: Dict[str, Any] = {}
        self._config_listeners: List[Callable[[Dict[str, Any]], None]] = []
        self._current_call_id: Optional[int] = None
        self._event_sink: Optional[EventSink] = None
        self._host_call_handler: Optional[HostCallHandler] = None
        # External-agent presets contributed via the cognia_next helper; the
        # host normally collects these from the manifest, but recording them
        # here keeps the typed helper introspectable in tests.
        self._external_agent_presets: List[Dict[str, Any]] = []
        # External-agent protocol adapters contributed via the cognia_next
        # helper (the targeted-behaviour twin of presets). Recorded here so the
        # typed helper is introspectable in tests / dev tooling.
        self._external_agent_adapters: List[Dict[str, Any]] = []
        # contribution_id -> {method_name: callable}. Mirrors `_CONTRIBUTIONS`
        # in the embedded host (`crates/cognia-plugin-runtime/src/python/
        # host.py`) so a python-owned module-bridge contribution can be
        # registered, introspected and unit-tested offline.
        self._contributions: Dict[str, Dict[str, Callable[..., Any]]] = {}

    # -- registration -------------------------------------------------------

    def register_contribution(self, contribution_id: str, target: Any) -> Any:
        """Register a python-owned module-bridge contribution.

        `target` is a class (instantiated here) or a ready object; every public
        callable attribute becomes a method the host can dispatch through
        ``__cognia_dispatch_contribution__``.
        """
        if not isinstance(contribution_id, str) or not contribution_id:
            raise ValueError("contribution id must be a non-empty string")
        instance = target() if inspect.isclass(target) else target
        methods: Dict[str, Callable[..., Any]] = {}
        for name in dir(instance):
            if name.startswith("_"):
                continue
            attr = getattr(instance, name, None)
            if callable(attr):
                methods[name] = attr
        if not methods:
            raise ValueError(f"contribution '{contribution_id}' exposes no public methods")
        self._contributions[contribution_id] = methods
        return target

    def dispatch_contribution(
        self,
        contribution_id: str,
        method: str,
        args: Optional[List[Any]] = None,
    ) -> Any:
        """Invoke one contribution method — the offline twin of the host's
        dispatcher, so plugin tests can drive a contribution directly."""
        entry = self._contributions.get(contribution_id)
        if entry is None:
            raise RuntimeError(f"unknown contribution: {contribution_id}")
        fn = entry.get(method)
        if fn is None:
            raise RuntimeError(f"contribution '{contribution_id}' has no method '{method}'")
        return fn(*(args or []))

    def register_tool(
        self,
        fn: ToolFn,
        name: Optional[str] = None,
        description: str = "",
        parameters: Optional[Dict[str, Any]] = None,
    ) -> ToolFn:
        """Register a tool, inferring parameters from the signature by default.

        Mirrors host.py `_register_tool`: an explicit ``description`` wins over
        the docstring, explicit ``parameters`` win over inference.
        """
        import inspect

        tool_name = name or fn.__name__
        self._tools[tool_name] = RegisteredTool(
            definition=ToolDefinition(
                name=tool_name,
                description=description or (inspect.getdoc(fn) or ""),
                parameters=parameters if parameters is not None else infer_parameters(fn),
            ),
            fn=fn,
        )
        return fn

    def register_hook(self, event: str, fn: Callable[[Any], Any]) -> Callable[[Any], Any]:
        """Register an event hook (dispatch is host/runtime-driven)."""
        self._hooks.append(HookRegistration(event=event, name=fn.__name__, fn=fn))
        return fn

    def register_external_agent_preset(self, preset: Dict[str, Any]) -> None:
        self._external_agent_presets.append(preset)

    def register_external_agent_adapter(self, adapter: Dict[str, Any]) -> None:
        self._external_agent_adapters.append(adapter)

    # -- introspection ------------------------------------------------------

    def get_tools(self) -> List[Dict[str, Any]]:
        """The host-facing tool definitions (``get_tools`` reply)."""
        return [entry.definition.to_dict() for entry in self._tools.values()]

    def get_hooks(self) -> List[Dict[str, str]]:
        return [{"event": h.event, "name": h.name} for h in self._hooks]

    def get_external_agent_presets(self) -> List[Dict[str, Any]]:
        return list(self._external_agent_presets)

    def get_external_agent_adapters(self) -> List[Dict[str, Any]]:
        return list(self._external_agent_adapters)

    def get_contributions(self) -> List[Dict[str, Any]]:
        return [
            {"id": cid, "methods": sorted(methods.keys())}
            for cid, methods in self._contributions.items()
        ]

    def get_info(self) -> Dict[str, Any]:
        return {
            "sdk_version": SDK_VERSION,
            "protocol_version": PROTOCOL_VERSION,
            "contract_version": CONTRACT_VERSION,
            "runtime_id": "python",
            "capabilities": [
                "tools",
                "hooks",
                "contributions",
                "config",
                "events",
                "streaming",
            ],
            "legacy_adapter": False,
            "tool_count": len(self._tools),
            "hook_count": len(self._hooks),
            "contribution_count": len(self._contributions),
        }

    def has_tool(self, name: str) -> bool:
        return name in self._tools

    # -- config -------------------------------------------------------------

    def push_config(self, config: Optional[Dict[str, Any]]) -> None:
        self._config = dict(config or {})
        # Notify registered config-change listeners (mirrors the TS host's
        # `ctx.configuration.onChange`). A listener that raises must not stop
        # the others or the host push.
        for listener in list(self._config_listeners):
            try:
                listener(self._config)
            except Exception:  # pragma: no cover - defensive, mirrors TS isolation
                pass

    def get_config(self) -> Dict[str, Any]:
        return self._config

    def on_config_changed(
        self, fn: Callable[[Dict[str, Any]], None]
    ) -> Callable[[Dict[str, Any]], None]:
        """Register a listener fired whenever the host pushes new config."""
        self._config_listeners.append(fn)
        return fn

    # -- events -------------------------------------------------------------

    def set_event_sink(self, sink: Optional[EventSink]) -> None:
        self._event_sink = sink

    def emit_event(self, event: str, data: Any = None, call_id: Optional[int] = None) -> None:
        if self._event_sink is not None:
            self._event_sink(event, data, call_id)

    def emit(self, contribution_id: str, channel: str, payload: Any = None) -> None:
        """``cognia.emit(...)`` — push an unsolicited frame to the host.

        The inbound half of a bidirectional contribution (connector messages,
        watcher events); the renderer picks it up via
        ``subscribePythonContributionPush``.
        """
        self.emit_event(
            "emit",
            {"contributionId": contribution_id, "channel": channel, "payload": payload},
        )

    # -- host calls ---------------------------------------------------------

    def set_host_call_handler(self, handler: Optional["HostCallHandler"]) -> None:
        """Attach the thing that answers ``cognia.ctx.*`` calls.

        In production the embedded host owns this end and this package is not
        even imported — the shim replaces ``cognia`` in ``sys.modules``. Here
        it exists so a plugin that calls the host can be unit-tested offline:
        register a handler and assert on the calls it receives.
        """
        self._host_call_handler = handler

    async def host_call(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Route one ``<namespace>.<method>`` call to the attached handler.

        Raises rather than returning a sentinel when nothing is attached: a
        plugin silently receiving ``None`` from ``ctx.storage.get`` would look
        like a cache miss, which is the kind of bug that survives a test suite.
        """
        if self._host_call_handler is None:
            raise HostCallError(
                f"no host attached: cannot serve '{method}'. In a unit test, call "
                "runtime.set_host_call_handler(...) to stub the host."
            )
        result = self._host_call_handler(method, dict(params or {}))
        if inspect.isawaitable(result):
            result = await result
        return result

    def progress(self, pct: Optional[float] = None, message: Optional[str] = None) -> None:
        """``cognia.progress(...)`` — report progress for the in-flight call."""
        data: Dict[str, Any] = {}
        if pct is not None:
            data["pct"] = pct
        if message is not None:
            data["message"] = message
        self.emit_event("progress", data, self._current_call_id)

    # -- execution ----------------------------------------------------------

    def call_tool(self, name: str, args: Optional[Dict[str, Any]] = None) -> Any:
        """Invoke a tool by name, streaming generator chunks as events.

        Mirrors host.py `_handle_call_tool`: an iterator result streams each
        chunk as a ``chunk`` event, terminates with ``chunk_end``, and collapses
        to a joined string when every chunk is a string (else a list). Plain
        results are JSON-validated before return.
        """
        entry = self._tools.get(name)
        if entry is None:
            raise RuntimeError(f"unknown tool: {name}")
        result = entry.fn(**(args or {}))
        if isinstance(result, collections.abc.Iterator):
            chunks: List[Any] = []
            for chunk in result:
                ensure_serializable(chunk, f"tool '{name}' stream chunk")
                self.emit_event("chunk", chunk, self._current_call_id)
                chunks.append(chunk)
            self.emit_event("chunk_end", None, self._current_call_id)
            if chunks and all(isinstance(c, str) for c in chunks):
                return "".join(chunks)
            return chunks
        return ensure_serializable(result, f"tool '{name}'")

    def call_hook(self, event: str, name: str, payload: Any = None) -> Any:
        """Invoke a named hook for an event (mirrors host `_handle_call_hook`)."""
        for hook in self._hooks:
            if hook.event == event and hook.name == name:
                return ensure_serializable(
                    hook.fn(payload), f"hook '{name}' for '{event}'"
                )
        raise RuntimeError(f"no hook named '{name}' registered for event '{event}'")

    # -- protocol -----------------------------------------------------------

    def dispatch(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Answer one protocol method, matching the host's `_METHODS` table.

        ``call_tool`` / ``call_hook`` set the current call id so any
        ``progress`` / streamed-chunk events emitted during the handler carry
        the correlating id, exactly as the host's serial main loop does.
        """
        params = params or {}
        if method == "ping":
            return "pong"
        if method == "get_tools":
            return self.get_tools()
        if method == "get_info":
            return self.get_info()
        if method == "push_config":
            return self.push_config(params.get("config"))
        if method == "call_tool":
            self._current_call_id = params.get("call_id")
            try:
                return self.call_tool(params["name"], params.get("args") or {})
            finally:
                self._current_call_id = None
        if method == "call_hook":
            self._current_call_id = params.get("call_id")
            try:
                return self.call_hook(
                    params["event"], params["name"], params.get("payload")
                )
            finally:
                self._current_call_id = None
        raise RuntimeError(f"unknown method: {method}")

    def reset(self) -> None:
        """Clear all registrations and config (test isolation helper)."""
        self._tools.clear()
        self._hooks.clear()
        self._config.clear()
        self._external_agent_presets.clear()
        self._external_agent_adapters.clear()
        self._current_call_id = None
        self._event_sink = None
        self._host_call_handler = None


# -- active-runtime singleton ----------------------------------------------
#
# Module-level decorators (`cognia.tool`, `cognia.hook`) register into the
# "active" runtime, matching the host's module-global registry model. Tests
# swap the active runtime for isolation.

_ACTIVE_RUNTIME = Runtime()


def get_active_runtime() -> Runtime:
    return _ACTIVE_RUNTIME


def set_active_runtime(runtime: Runtime) -> Runtime:
    global _ACTIVE_RUNTIME
    _ACTIVE_RUNTIME = runtime
    return _ACTIVE_RUNTIME


def reset_active_runtime() -> Runtime:
    """Reset the active runtime to a fresh instance and return it."""
    return set_active_runtime(Runtime())


# -- module-level convenience (host-shim parity) ----------------------------


def contribution(contribution_id: str) -> Callable[[Any], Any]:
    """``@cognia.contribution("<id>")`` — own a module-bridge contribution.

    Decorates a class (instantiated on registration) or a ready object. Every
    public callable attribute becomes a method the renderer can dispatch::

        @cognia.contribution("tesseract")
        class Tesseract:
            def describe(self):
                return {"label": "Tesseract", "category": "local"}

            def extract(self, image, ctx=None):
                return {"text": ...}

    ``describe()`` supplies the plain-data descriptor a JS factory would have
    returned inline; every other method is behaviour. Returning an iterator
    from a method the host called with a stream id turns it into chunk frames.
    """

    def decorate(target: Any) -> Any:
        return get_active_runtime().register_contribution(contribution_id, target)

    return decorate


def emit(contribution_id: str, channel: str, payload: Any = None) -> None:
    """``cognia.emit(...)`` — push an unsolicited frame to the host."""
    get_active_runtime().emit(contribution_id, channel, payload)


def progress(pct: Optional[float] = None, message: Optional[str] = None) -> None:
    """``from cognia import progress`` — proxy to the active runtime."""
    get_active_runtime().progress(pct=pct, message=message)


def get_config() -> Dict[str, Any]:
    """``from cognia import get_config`` — proxy to the active runtime."""
    return get_active_runtime().get_config()


def on_config_changed(
    fn: Callable[[Dict[str, Any]], None]
) -> Callable[[Dict[str, Any]], None]:
    """``from cognia import on_config_changed`` — register a listener fired when
    the host pushes new config. Module-level proxy to the active runtime, matching
    the host shim's ``cognia.on_config_changed``."""
    return get_active_runtime().on_config_changed(fn)


def log(*args: Any) -> None:
    """Plugin logging that never corrupts the protocol channel.

    The host redirects ``stdout`` to ``stderr`` for exactly this reason; the
    reference runtime writes to ``stderr`` directly.
    """
    print(*args, file=sys.stderr)
