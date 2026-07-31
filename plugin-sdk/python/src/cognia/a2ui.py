"""Typed helpers for the ``a2ui`` / ``components`` capabilities.

Plugins contribute A2UI components and templates through their manifest's
``a2uiComponents`` / ``a2uiTemplates`` arrays. ``A2UIComponent`` and
``A2UITemplate`` mirror those shapes and the ``define_*`` helpers build the
camelCase dicts the host's A2UI bridge consumes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class A2UIComponent:
    """An A2UI component contribution (mirrors ``A2UIPluginComponentDef``)."""

    name: str
    schema: Dict[str, Any] = field(default_factory=dict)
    description: str = ""
    category: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"name": self.name, "schema": dict(self.schema)}
        if self.description:
            out["description"] = self.description
        if self.category is not None:
            out["category"] = self.category
        return out


@dataclass(frozen=True)
class A2UITemplate:
    """An A2UI template contribution (mirrors ``A2UITemplateDef``)."""

    id: str
    name: str
    template: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "name": self.name, "template": dict(self.template)}


def define_component(
    name: str,
    *,
    schema: Optional[Dict[str, Any]] = None,
    description: str = "",
    category: Optional[str] = None,
) -> A2UIComponent:
    """Construct a validated `A2UIComponent`."""
    if not name or not name.strip():
        raise ValueError("component name must be a non-empty string")
    return A2UIComponent(
        name=name,
        schema=dict(schema or {}),
        description=description,
        category=category,
    )


def define_template(
    id: str,
    name: str,
    *,
    template: Optional[Dict[str, Any]] = None,
) -> A2UITemplate:
    """Construct a validated `A2UITemplate`."""
    if not id or not id.strip():
        raise ValueError("template id must be a non-empty string")
    if not name or not name.strip():
        raise ValueError("template name must be a non-empty string")
    return A2UITemplate(id=id, name=name, template=dict(template or {}))
