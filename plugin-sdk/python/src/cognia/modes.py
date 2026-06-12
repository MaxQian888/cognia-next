"""Typed helpers for the ``modes`` capability.

A plugin contributes chat modes through its manifest's ``modes`` array; each
entry is a ``PluginModeDef`` on the TypeScript side. ``Mode`` mirrors that shape
and ``define_mode`` builds one with validation, emitting the camelCase dict the
host expects.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class Mode:
    """A chat mode contribution (mirrors ``PluginModeDef``)."""

    id: str
    name: str
    description: str = ""
    system_prompt: Optional[str] = None
    icon: Optional[str] = None
    tools: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "name": self.name}
        if self.description:
            out["description"] = self.description
        if self.system_prompt is not None:
            out["systemPrompt"] = self.system_prompt
        if self.icon is not None:
            out["icon"] = self.icon
        if self.tools:
            out["tools"] = list(self.tools)
        return out


def define_mode(
    id: str,
    name: str,
    *,
    description: str = "",
    system_prompt: Optional[str] = None,
    icon: Optional[str] = None,
    tools: Optional[List[str]] = None,
) -> Mode:
    """Construct a validated `Mode`. ``id`` and ``name`` are required."""
    if not id or not id.strip():
        raise ValueError("mode id must be a non-empty string")
    if not name or not name.strip():
        raise ValueError("mode name must be a non-empty string")
    return Mode(
        id=id,
        name=name,
        description=description,
        system_prompt=system_prompt,
        icon=icon,
        tools=list(tools or []),
    )
