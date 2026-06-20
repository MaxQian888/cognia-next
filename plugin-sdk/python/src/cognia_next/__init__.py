"""``cognia_next`` — cognia-next-specific Python plugin extensions.

Houses author-facing surfaces that are specific to the cognia-next host rather
than the generic plugin contract in the core ``cognia`` package — currently the
external-agent preset and adapter helpers.
"""

from __future__ import annotations

from .external_agent_adapters import (
    ExternalAgentAdapter,
    define_external_agent_adapter,
    register_external_agent_adapter,
)
from .external_agent_presets import (
    ACP,
    STDIO,
    ExternalAgentPreset,
    define_external_agent_preset,
    register_external_agent_preset,
)

__all__ = [
    "ExternalAgentPreset",
    "define_external_agent_preset",
    "register_external_agent_preset",
    "ExternalAgentAdapter",
    "define_external_agent_adapter",
    "register_external_agent_adapter",
    "STDIO",
    "ACP",
]
