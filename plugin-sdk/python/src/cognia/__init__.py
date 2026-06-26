"""``cognia`` — the Python plugin SDK for Cognia.

Author-facing surface for Python plugins. The recommended imports::

    from cognia import tool, hook, progress, get_config   # module-style
    from cognia import Plugin, Context                     # class-style
    from cognia import define_mode, define_component       # typed helpers

At runtime inside the Tauri shell the embedded host installs a ``cognia`` shim
into ``sys.modules`` before importing the plugin, so these same imports resolve
to the host's registry. This package is the standalone reference implementation
of that identical contract — used for unit tests, IDE typing, and running a
plugin's tools directly with ``python``.
"""

from __future__ import annotations

from . import types
from .a2ui import A2UIComponent, A2UITemplate, define_component, define_template
from .capability_contract import (
    BLOCKED,
    EXPERIMENTAL,
    PARTIAL,
    SUPPORTED,
    CapabilityContract,
    CapabilityDiagnostic,
    CapabilityValidationOutcome,
    capability_contract_from_dict,
    define_capability_contract,
    validate_capabilities,
)
from .context import Context, PluginContext, create_context
from .decorators import hook, tool
from .modes import Mode, define_mode
from .plugin import Plugin
from .runtime import (
    Runtime,
    get_active_runtime,
    get_config,
    log,
    progress,
    reset_active_runtime,
    set_active_runtime,
)
from .types import (
    AuthProviderDef,
    ChatMiddlewareDef,
    CompactionStrategyDef,
    ContextProviderDef,
    DensityPresetContribution,
    DeploymentFilterDef,
    HookRegistration,
    MessageRendererDef,
    ModalMountDef,
    PluginHook,
    ProtocolAdapterDef,
    RegisteredTool,
    RoutingStrategyDef,
    TerminalCompletionProviderDef,
    ToolRouteDef,
    ToolDefinition,
    ToolParameter,
    TreeNode,
    ViewContainerDef,
    ViewDef,
    WebviewDef,
    WorkspaceBackendDef,
    ensure_serializable,
    infer_parameters,
    json_type_for,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # decorators / runtime entrypoints
    "tool",
    "hook",
    "progress",
    "get_config",
    "log",
    # runtime
    "Runtime",
    "get_active_runtime",
    "set_active_runtime",
    "reset_active_runtime",
    # context
    "Context",
    "PluginContext",
    "create_context",
    # class-based authoring
    "Plugin",
    # typed helpers
    "Mode",
    "define_mode",
    "A2UIComponent",
    "A2UITemplate",
    "define_component",
    "define_template",
    # capability contracts
    "CapabilityContract",
    "CapabilityDiagnostic",
    "CapabilityValidationOutcome",
    "define_capability_contract",
    "validate_capabilities",
    "capability_contract_from_dict",
    "SUPPORTED",
    "PARTIAL",
    "EXPERIMENTAL",
    "BLOCKED",
    # types
    "types",
    "ToolDefinition",
    "ToolParameter",
    "RegisteredTool",
    "HookRegistration",
    "ViewContainerDef",
    "TreeNode",
    "ViewDef",
    "WebviewDef",
    "AuthProviderDef",
    "WorkspaceBackendDef",
    "MessageRendererDef",
    "DensityPresetContribution",
    "ChatMiddlewareDef",
    "ModalMountDef",
    "TerminalCompletionProviderDef",
    "RoutingStrategyDef",
    "CompactionStrategyDef",
    "DeploymentFilterDef",
    "ProtocolAdapterDef",
    "ToolRouteDef",
    "ContextProviderDef",
    "PluginHook",
    "ensure_serializable",
    "infer_parameters",
    "json_type_for",
]
