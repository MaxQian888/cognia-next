"""External-agent preset + adapter helpers.

Two related contributions for the external-agent subsystem:

* An external-agent **preset** (``external-agent-preset`` capability) contributes
  a *configuration* over one of the built-in transports (Claude Code, Codex,
  Gemini CLI, Cursor, Windsurf, …) — carried declaratively in the manifest's
  ``externalAgentPresets`` array and mirrored into the host's
  ``EXTERNAL_AGENT_PRESETS`` registry.
* An external-agent **adapter** (``external-agent-adapter`` capability)
  contributes the *protocol behaviour itself* — a ``() -> ProtocolAdapter``
  factory shipped as renderer-side JS and lazy-imported on enable. A pure-Python
  plugin cannot ship that JS factory directly, so ``define_external_agent_adapter``
  is a manifest-authoring helper for HYBRID plugins (a Python backend bundled
  with a frontend JS ``entry``); the host registers it into the external-agent
  ``protocolAdapterRegistry`` under ``{plugin_id}:{id}``.

Both mirror their TypeScript ``Plugin*Def`` shapes and build the camelCase dict
the host consumes. The ``register_*`` helpers are thin pass-throughs: the host
normally collects these contributions from the manifest, but recording the typed
value on a runtime keeps it introspectable (e.g. ``get_external_agent_presets()``)
in tests and dev tooling.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# Transport kinds the host's external-agent runtime understands.
STDIO = "stdio"
ACP = "acp"

_TRANSPORTS = frozenset({STDIO, ACP})


# -- presets ----------------------------------------------------------------


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
    """Record ``preset`` on a runtime and return its host-facing dict."""
    from .runtime import get_active_runtime

    target = runtime or get_active_runtime()
    payload = preset.to_dict()
    target.register_external_agent_preset(payload)
    return payload


# -- adapters ---------------------------------------------------------------


@dataclass(frozen=True)
class ExternalAgentAdapter:
    """A typed external-agent adapter contribution.

    Mirrors ``PluginExternalAgentAdapterDef``. ``entry``/``export`` point at the
    frontend JS module exporting the ``() -> ProtocolAdapter`` factory.
    """

    id: str
    label: str
    entry: str
    export: str
    description: str = ""

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "entry": self.entry,
            "export": self.export,
        }
        if self.description:
            out["description"] = self.description
        return out


def define_external_agent_adapter(
    id: str,
    label: str,
    entry: str,
    export: str,
    *,
    description: str = "",
) -> ExternalAgentAdapter:
    """Construct a validated ``ExternalAgentAdapter``.

    ``id``, ``label``, ``entry`` and ``export`` are all required — an adapter is
    always code, so the lazy ``entry``/``export`` factory path must be present.
    """
    if not id or not id.strip():
        raise ValueError("adapter id must be a non-empty string")
    if not label or not label.strip():
        raise ValueError("adapter label must be a non-empty string")
    if not entry or not entry.strip():
        raise ValueError("adapter entry must be a non-empty string")
    if not export or not export.strip():
        raise ValueError("adapter export must be a non-empty string")
    return ExternalAgentAdapter(
        id=id,
        label=label,
        entry=entry,
        export=export,
        description=description,
    )


def register_external_agent_adapter(
    adapter: ExternalAgentAdapter, runtime: Optional[Any] = None
) -> Dict[str, Any]:
    """Record ``adapter`` on a runtime and return its host-facing dict."""
    from .runtime import get_active_runtime

    target = runtime or get_active_runtime()
    payload = adapter.to_dict()
    target.register_external_agent_adapter(payload)
    return payload
