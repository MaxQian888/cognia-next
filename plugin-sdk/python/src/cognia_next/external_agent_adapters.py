"""External-agent adapter helpers (``external-agent-adapter`` capability).

Where ``external_agent_presets`` contributes a *configuration* over one of the
built-in protocols, an external-agent *adapter* contributes the protocol
behaviour itself — a ``() -> ProtocolAdapter`` factory shipped as renderer-side
JS and lazy-imported on enable. A pure-Python plugin cannot ship that JS factory
directly; this helper is therefore a manifest-authoring helper for HYBRID
plugins (a Python backend bundled with a frontend JS ``entry``). It builds a
validated ``externalAgentAdapters`` entry the host registers into the
external-agent ``protocolAdapterRegistry`` under ``{plugin_id}:{id}``.

Lives in the ``cognia_next`` namespace (cognia-next-specific extension) rather
than the core ``cognia`` package, matching the TypeScript SDK's separation of
the cognia-next external-agent surface from the generic plugin API.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional


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
    """Record ``adapter`` on a runtime and return its host-facing dict.

    Thin pass-through: the host normally collects adapter contributions from the
    manifest, but recording the typed adapter keeps it introspectable in tests
    and dev tooling.
    """
    from cognia.runtime import get_active_runtime

    target = runtime or get_active_runtime()
    payload = adapter.to_dict()
    target.register_external_agent_adapter(payload)
    return payload
