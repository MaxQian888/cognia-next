"""Author-facing decorators — ``@tool`` and ``@hook``.

These mirror the host shim's decorators (`host.py` `_tool` / `_hook`) so a
plugin written against this SDK behaves identically under the embedded host.
Both register into the active runtime (`runtime.get_active_runtime()`).

``@tool`` supports the bare and configured forms::

    @tool
    def greet(name: str): ...

    @tool(name="word_stats", description="...", parameters={...})
    def stats(text): ...

``@hook(event)`` registers a transform-style event handler::

    @hook("onMessageSend")
    def stamp(payload): ...
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from .runtime import get_active_runtime
from .types import HookFn, ToolFn


def tool(
    fn: Optional[ToolFn] = None,
    *,
    name: Optional[str] = None,
    description: str = "",
    parameters: Optional[Dict[str, Any]] = None,
) -> Any:
    """Register a tool on the active runtime (bare or configured form)."""
    if fn is not None and callable(fn):
        return get_active_runtime().register_tool(fn)

    def wrapper(inner: ToolFn) -> ToolFn:
        return get_active_runtime().register_tool(
            inner, name=name, description=description, parameters=parameters
        )

    return wrapper


def hook(event: str) -> Callable[[HookFn], HookFn]:
    """Register an event hook on the active runtime."""

    def wrapper(fn: HookFn) -> HookFn:
        return get_active_runtime().register_hook(event, fn)

    return wrapper
