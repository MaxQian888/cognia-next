"""External-agent preset helpers (``external-agent-preset`` capability).

A plugin declaring the ``external-agent-preset`` capability contributes
presets (Claude Code, Codex, Gemini CLI, Cursor, Windsurf, …) that flow into
the host's ``EXTERNAL_AGENT_PRESETS`` registry via the runtime overlay. For a
Python plugin the contribution is declarative — carried in the manifest's
``externalAgentPresets`` array — and the host mirrors it into the overlay
through the Tauri command. This module is the typed author-facing helper: it
builds a validated preset dict and (optionally) records it on a runtime so the
plugin can introspect what it declared.

Lives in the ``cognia_next`` namespace (cognia-next-specific extension) rather
than the core ``cognia`` package, matching the TypeScript SDK's separation of
the cognia-next external-agent surface from the generic plugin API.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Transport kinds the host's external-agent runtime understands.
STDIO = "stdio"
ACP = "acp"

_TRANSPORTS = frozenset({STDIO, ACP})


@dataclass(frozen=True)
class ExternalAgentPreset:
    """A typed external-agent preset (mirrors ``PluginExternalAgentPresetDef``)."""

    id: str
    name: str
    command: str
    args: List[str] = field(default_factory=list)
    env: Dict[str, str] = field(default_factory=dict)
    transport: str = STDIO
    description: str = ""
    cwd: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "command": self.command,
            "transport": self.transport,
        }
        if self.args:
            out["args"] = list(self.args)
        if self.env:
            out["env"] = dict(self.env)
        if self.description:
            out["description"] = self.description
        if self.cwd is not None:
            out["cwd"] = self.cwd
        return out


def define_external_agent_preset(
    id: str,
    name: str,
    command: str,
    *,
    args: Optional[List[str]] = None,
    env: Optional[Dict[str, str]] = None,
    transport: str = STDIO,
    description: str = "",
    cwd: Optional[str] = None,
) -> ExternalAgentPreset:
    """Construct a validated `ExternalAgentPreset`.

    ``id``, ``name``, and ``command`` are required; ``transport`` must be one of
    ``"stdio"`` / ``"acp"``.
    """
    if not id or not id.strip():
        raise ValueError("preset id must be a non-empty string")
    if not name or not name.strip():
        raise ValueError("preset name must be a non-empty string")
    if not command or not command.strip():
        raise ValueError("preset command must be a non-empty string")
    if transport not in _TRANSPORTS:
        raise ValueError(
            f"unknown transport {transport!r}; expected one of {sorted(_TRANSPORTS)}"
        )
    return ExternalAgentPreset(
        id=id,
        name=name,
        command=command,
        args=list(args or []),
        env=dict(env or {}),
        transport=transport,
        description=description,
        cwd=cwd,
    )


def register_external_agent_preset(
    preset: ExternalAgentPreset, runtime: Optional[Any] = None
) -> Dict[str, Any]:
    """Record ``preset`` on a runtime and return its host-facing dict.

    Thin pass-through to the runtime overlay: the host normally collects these
    from the manifest, but recording the typed preset keeps it introspectable
    (e.g. ``runtime.get_external_agent_presets()``) in tests and dev tooling.
    """
    from cognia.runtime import get_active_runtime

    target = runtime or get_active_runtime()
    payload = preset.to_dict()
    target.register_external_agent_preset(payload)
    return payload
