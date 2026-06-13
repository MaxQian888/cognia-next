"""Typed data models for the Cognia Python plugin SDK.

These dataclasses mirror the shapes the Tauri Python host exchanges over its
NDJSON stdio protocol (`src-tauri/src/plugin_api/python/host.py` +
`protocol.rs`). They are the author-facing, type-checked surface — the host
serialises the same shapes as plain dicts at runtime.

Stdlib only, written for Python >= 3.9 (`from __future__ import annotations`
defers every annotation so newer typing syntax stays import-safe).
"""

from __future__ import annotations

import inspect
import json
import typing
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Mapping, Optional

# A tool function maps keyword args to a JSON-serialisable result (or an
# iterator of chunks for streaming tools).
ToolFn = Callable[..., Any]
# A hook receives one JSON payload and returns a (possibly transformed) one.
HookFn = Callable[[Any], Any]

# The JSON schema type tags the host understands, keyed by Python type. Mirrors
# host.py `_TYPE_MAP` exactly so inference here matches what the host infers.
PYTHON_TO_JSON_TYPE: Dict[type, str] = {
    str: "string",
    int: "number",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


def json_type_for(annotation: Any) -> str:
    """Map a parameter annotation to the host's JSON type tag.

    Mirrors host.py `_json_type_for`: bare/empty → ``"any"``, a known concrete
    type → its tag, a parameterised generic (``list[int]``) → its origin's tag,
    everything else → ``"any"``.
    """
    if annotation is inspect.Parameter.empty or annotation is None:
        return "any"
    if annotation in PYTHON_TO_JSON_TYPE:
        return PYTHON_TO_JSON_TYPE[annotation]
    origin = getattr(annotation, "__origin__", None)
    if origin in PYTHON_TO_JSON_TYPE:
        return PYTHON_TO_JSON_TYPE[origin]
    return "any"


def infer_parameters(fn: ToolFn) -> Dict[str, Dict[str, Any]]:
    """Build a parameters dict from a callable's signature.

    Mirrors host.py `_infer_parameters`: ``*args``/``**kwargs`` are skipped, a
    parameter without a default is ``required: True``, and a JSON-serialisable
    default is echoed back under ``default``.
    """
    try:
        hints = _resolve_hints(fn)
    except Exception:  # pragma: no cover - mirrors host's defensive fallback
        hints = getattr(fn, "__annotations__", {}) or {}
    params: Dict[str, Dict[str, Any]] = {}
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return params
    for param_name, param in signature.parameters.items():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        entry: Dict[str, Any] = {
            "type": json_type_for(hints.get(param_name, param.annotation))
        }
        if param.default is inspect.Parameter.empty:
            entry["required"] = True
        else:
            entry["required"] = False
            try:
                json.dumps(param.default)
                entry["default"] = param.default
            except (TypeError, ValueError):
                pass
        params[param_name] = entry
    return params


def _resolve_hints(fn: ToolFn) -> Dict[str, Any]:
    # `typing.get_type_hints` resolves string annotations (PEP 563 /
    # `from __future__ import annotations`) back to real types, so inference
    # works whether or not the plugin defers its annotations.
    try:
        return typing.get_type_hints(fn)
    except Exception:
        return getattr(fn, "__annotations__", {}) or {}


@dataclass(frozen=True)
class ToolParameter:
    """One typed tool parameter, mirroring the host's parameter entry shape."""

    type: str = "any"
    required: bool = False
    description: Optional[str] = None
    default: Any = None
    has_default: bool = False

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"type": self.type, "required": self.required}
        if self.description is not None:
            out["description"] = self.description
        if self.has_default:
            out["default"] = self.default
        return out

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ToolParameter":
        has_default = "default" in raw
        return cls(
            type=str(raw.get("type", "any")),
            required=bool(raw.get("required", False)),
            description=raw.get("description"),
            default=raw.get("default") if has_default else None,
            has_default=has_default,
        )


@dataclass(frozen=True)
class ToolDefinition:
    """A tool's host-facing definition (``get_tools`` payload entry)."""

    name: str
    description: str = ""
    parameters: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }


@dataclass
class RegisteredTool:
    """A tool definition paired with its live callable."""

    definition: ToolDefinition
    fn: ToolFn


@dataclass(frozen=True)
class HookRegistration:
    """An event hook registration (event name + callable)."""

    event: str
    name: str
    fn: HookFn


@dataclass(frozen=True)
class ViewContainerDef:
    """A custom view container (B1), mirroring the host's
    ``PluginViewContainerDef``. Declared in ``manifest.viewsContainers``; the
    host renders a rail icon that swaps the middle column to the container's
    panel. ``location`` is ``"rail"`` (default) or ``"panel"``.
    """

    id: str
    title: str
    icon: Optional[str] = None
    location: Optional[str] = None
    order: Optional[int] = None
    when: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "title": self.title}
        if self.icon is not None:
            out["icon"] = self.icon
        if self.location is not None:
            out["location"] = self.location
        if self.order is not None:
            out["order"] = self.order
        if self.when is not None:
            out["when"] = self.when
        return out


@dataclass(frozen=True)
class TreeNode:
    """One node in a plugin tree view (B2), mirroring ``PluginTreeNode``."""

    id: str
    label: str
    icon: Optional[str] = None
    expandable: bool = False
    collapsed: bool = False
    command: Optional[str] = None
    context_value: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "label": self.label}
        if self.icon is not None:
            out["icon"] = self.icon
        if self.expandable:
            out["expandable"] = True
        if self.collapsed:
            out["collapsed"] = True
        if self.command is not None:
            out["command"] = self.command
        if self.context_value is not None:
            out["contextValue"] = self.context_value
        return out


@dataclass(frozen=True)
class ViewDef:
    """A view contribution (B2), mirroring the host's ``PluginViewDef``.
    Declared in ``manifest.views``; ``type`` is ``"tree"`` or ``"react"``.
    Dynamic ``getChildren`` providers run host-side (JS); the Python SDK ships
    the manifest mirror so hybrid plugins can declare views statically.
    """

    id: str
    container_id: str
    type: str
    entry: str
    export: str
    title: Optional[str] = None
    when: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "containerId": self.container_id,
            "type": self.type,
            "entry": self.entry,
            "export": self.export,
        }
        if self.title is not None:
            out["title"] = self.title
        if self.when is not None:
            out["when"] = self.when
        return out


@dataclass(frozen=True)
class WebviewDef:
    """A sandboxed webview contribution (B3), mirroring ``PluginWebviewDef``.
    ``html`` is inline; or ``entry``+``export`` resolve an HTML string host-side.
    ``surface`` is ``"panel"`` (default) or ``"window"``.
    """

    id: str
    container_id: str
    html: Optional[str] = None
    entry: Optional[str] = None
    export: Optional[str] = None
    title: Optional[str] = None
    surface: Optional[str] = None
    when: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "containerId": self.container_id}
        if self.html is not None:
            out["html"] = self.html
        if self.entry is not None:
            out["entry"] = self.entry
        if self.export is not None:
            out["export"] = self.export
        if self.title is not None:
            out["title"] = self.title
        if self.surface is not None:
            out["surface"] = self.surface
        if self.when is not None:
            out["when"] = self.when
        return out


def ensure_serializable(value: Any, context: str) -> Any:
    """Raise if ``value`` is not JSON-serialisable (mirrors host policy).

    The host rejects non-JSON results so a tool can never silently return a
    value the protocol cannot carry. Re-implemented here so standalone /
    test execution enforces the same contract.
    """
    try:
        json.dumps(value)
    except (TypeError, ValueError) as exc:
        raise TypeError(
            f"{context} returned a non-JSON-serializable value of type "
            f"{type(value).__name__}"
        ) from exc
    return value
