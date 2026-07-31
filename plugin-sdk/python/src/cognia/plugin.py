"""Class-based plugin authoring — the ``Plugin`` base.

Most reference plugins (e.g. ``plugins/cognia-python-demo/main.py``) use the
module-level ``@tool`` / ``@hook`` decorators. ``Plugin`` is the object-oriented
alternative: subclass it, tag methods with ``@Plugin.tool`` / ``@Plugin.hook``,
and the base registers the *bound* methods into a runtime on construction. This
keeps tool state on the instance (so a plugin can hold connections, caches, or
config-derived fields) instead of module globals.

    class Greeter(Plugin):
        name = "greeter"

        @Plugin.tool(description="Greet someone.")
        def greet(self, who: str):
            return f"{self.context.config.get('greeting', 'Hello')}, {who}!"

        @Plugin.hook("onMessageSend")
        def stamp(self, payload):
            return payload

    plugin = Greeter()              # tools + hooks now registered
    plugin.runtime.call_tool("greet", {"who": "world"})

The ``@Plugin.tool`` / ``@Plugin.hook`` decorators are pure markers — they only
record metadata on the function; registration happens in ``__init__`` once the
methods are bound, so ``self`` resolves correctly.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from .context import Context
from .runtime import Runtime, get_active_runtime
from .types import HookFn, ToolFn

_TOOL_MARKER = "_cognia_tool"
_HOOK_MARKER = "_cognia_hook"


class Plugin:
    """Base class for object-oriented Cognia Python plugins."""

    #: Human-readable plugin name (optional; defaults to the class name).
    name: str = ""

    def __init__(self, runtime: Optional[Runtime] = None) -> None:
        self.runtime: Runtime = runtime or get_active_runtime()
        self.context: Context = Context(runtime=self.runtime)
        self._register_marked()

    # -- marker decorators (pure metadata; no registration) -----------------

    @staticmethod
    def tool(
        fn: Optional[ToolFn] = None,
        *,
        name: Optional[str] = None,
        description: str = "",
        parameters: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Mark a method as a tool (bare or configured form)."""

        def mark(inner: ToolFn) -> ToolFn:
            setattr(
                inner,
                _TOOL_MARKER,
                {"name": name, "description": description, "parameters": parameters},
            )
            return inner

        if fn is not None and callable(fn):
            return mark(fn)
        return mark

    @staticmethod
    def hook(event: str) -> Callable[[HookFn], HookFn]:
        """Mark a method as an event hook for ``event``."""

        def mark(inner: HookFn) -> HookFn:
            setattr(inner, _HOOK_MARKER, {"event": event})
            return inner

        return mark

    # -- registration -------------------------------------------------------

    def _register_marked(self) -> None:
        for attr_name in dir(type(self)):
            if attr_name.startswith("__"):
                continue
            member = getattr(type(self), attr_name, None)
            if member is None or not callable(member):
                continue
            bound = getattr(self, attr_name)
            tool_meta = getattr(member, _TOOL_MARKER, None)
            if tool_meta is not None:
                self.runtime.register_tool(
                    bound,
                    name=tool_meta["name"] or attr_name,
                    description=tool_meta["description"],
                    parameters=tool_meta["parameters"],
                )
            hook_meta = getattr(member, _HOOK_MARKER, None)
            if hook_meta is not None:
                # Bind the event under the method name so call_hook resolves it.
                self.runtime.register_hook(hook_meta["event"], bound)

    # -- lifecycle (override as needed; no-ops by default) ------------------

    def on_startup(self) -> None:  # pragma: no cover - override point
        """Run after the plugin is loaded."""

    def on_config_updated(self, config: Dict[str, Any]) -> None:  # pragma: no cover
        """Run when the host pushes new config."""

    def on_shutdown(self) -> None:  # pragma: no cover - override point
        """Run on graceful shutdown."""

    # -- introspection ------------------------------------------------------

    @property
    def display_name(self) -> str:
        return self.name or type(self).__name__

    def tool_definitions(self) -> List[Dict[str, Any]]:
        """The host-facing definitions of this plugin's tools."""
        return self.runtime.get_tools()
