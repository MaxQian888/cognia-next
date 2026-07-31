"""Typed plugin context proxy.

Python plugins do not receive a rich injected ``ctx`` object the way the
TypeScript runtime does — the host exposes config, progress reporting, and
protocol-safe logging through module-level functions. ``Context`` wraps those
same primitives in a typed object so authors who prefer dependency injection
(or who write class-based plugins via ``cognia.Plugin``) get a stable, typed
surface instead of reaching for module globals.

It is the author-facing backing for every capability whose Python SDK entry is
``context.py``: tools, skills, media, canvas, providers, scheduler, etc. all
read config / report progress through this proxy.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from .runtime import Runtime, get_active_runtime
from .types import HookFn, ToolFn


@dataclass
class Context:
    """A typed proxy over one runtime's config, progress, and registration."""

    runtime: Runtime = field(default_factory=get_active_runtime)

    @property
    def config(self) -> Dict[str, Any]:
        """The plugin's persisted ``configSchema`` values."""
        return self.runtime.get_config()

    def get_config(self) -> Dict[str, Any]:
        return self.runtime.get_config()

    def on_config_changed(
        self, fn: Callable[[Dict[str, Any]], None]
    ) -> Callable[[Dict[str, Any]], None]:
        """Register a listener fired whenever the host pushes new config —
        the Python mirror of the TS `ctx.configuration.onChange`."""
        return self.runtime.on_config_changed(fn)

    def progress(self, pct: Optional[float] = None, message: Optional[str] = None) -> None:
        """Report progress for the in-flight call."""
        self.runtime.progress(pct=pct, message=message)

    def log(self, *args: Any) -> None:
        """Protocol-safe logging (writes to stderr, never the RPC channel)."""
        from .runtime import log as _log

        _log(*args)

    def register_tool(
        self,
        fn: ToolFn,
        name: Optional[str] = None,
        description: str = "",
        parameters: Optional[Dict[str, Any]] = None,
    ) -> ToolFn:
        return self.runtime.register_tool(
            fn, name=name, description=description, parameters=parameters
        )

    def register_hook(self, event: str, fn: HookFn) -> HookFn:
        return self.runtime.register_hook(event, fn)


# The host injects the context conceptually through module globals; this alias
# names the same shape the TypeScript SDK calls `PluginContext`.
PluginContext = Context


def create_context(runtime: Optional[Runtime] = None) -> Context:
    """Build a `Context` bound to ``runtime`` (or the active runtime)."""
    return Context(runtime=runtime or get_active_runtime())
