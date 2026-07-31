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
    CANONICAL_CAPABILITY_CONTRACTS,
    CATALOG_SCHEMA_VERSION,
    MANIFEST_CONTRIBUTIONS,
    MINIMUM_HOST_VERSION,
    PLUGIN_PATH_FIELD_CONTRACTS,
    RUNTIME_ENTRY_CONTRACTS,
    VALID_CAPABILITIES,
    VALID_PERMISSIONS,
    VALID_PLUGIN_TYPES,
    capability_contract_from_dict,
    define_capability_contract,
    validate_capabilities,
)
from .context import Context, PluginContext, create_context
from .decorators import hook, tool
from .external_agent import (
    ACP,
    STDIO,
    ExternalAgentAdapter,
    ExternalAgentPreset,
    define_external_agent_adapter,
    define_external_agent_preset,
    register_external_agent_adapter,
    register_external_agent_preset,
)
from .agent import (
    CHARACTER_PACK_SOFT_LIMIT,
    AgentTeamTemplate,
    CharacterPack,
    Command,
    McpServerPreset,
    NativeAnthropicTool,
    QuickAction,
    Skill,
    Subagent,
    define_agent_team_template,
    define_character_pack,
    define_command,
    define_mcp_server_preset,
    define_native_anthropic_tool,
    define_quick_action,
    define_skill,
    define_subagent,
)
from .providers import (
    AiProvider,
    CliTool,
    Connector,
    LspServer,
    OcrProvider,
    define_ai_provider,
    define_cli_tool,
    define_connector,
    define_lsp_server,
    define_ocr_provider,
)
from .integrations import Integration, define_integration
from .workflow import (
    ConfigSchema,
    ScheduledTask,
    WorkflowTemplate,
    define_configuration,
    define_scheduled_task,
    define_workflow_template,
)
from .appearance import (
    FontContribution,
    Theme,
    ThemePack,
    Wallpaper,
    define_font_contribution,
    define_theme,
    define_theme_pack,
    define_wallpaper,
)
from .pet import (
    PetAchievement,
    PetItem,
    define_pet_achievement,
    define_pet_item,
)
from .modes import Mode, define_mode
from .plugin import Plugin
from .runtime import (
    Runtime,
    contribution,
    emit,
    get_active_runtime,
    get_config,
    log,
    on_config_changed,
    progress,
    reset_active_runtime,
    set_active_runtime,
)
from .types import (
    AuthProviderDef,
    ChatMiddlewareDef,
    CompactionStrategyDef,
    ContextPanelDef,
    ContextProviderDef,
    DensityPresetContribution,
    DeploymentFilterDef,
    HookRegistration,
    MessageRendererDef,
    ToolRendererDef,
    ModalMountDef,
    PluginHook,
    ProtocolAdapterDef,
    RegisteredTool,
    RoutingStrategyDef,
    SessionImporterDef,
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
    "contribution",
    "emit",
    "get_config",
    "log",
    "on_config_changed",
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
    "CANONICAL_CAPABILITY_CONTRACTS",
    "CATALOG_SCHEMA_VERSION",
    "MINIMUM_HOST_VERSION",
    "MANIFEST_CONTRIBUTIONS",
    "RUNTIME_ENTRY_CONTRACTS",
    "VALID_CAPABILITIES",
    "VALID_PERMISSIONS",
    "VALID_PLUGIN_TYPES",
    "PLUGIN_PATH_FIELD_CONTRACTS",
    "define_capability_contract",
    "validate_capabilities",
    "capability_contract_from_dict",
    "SUPPORTED",
    "PARTIAL",
    "EXPERIMENTAL",
    "BLOCKED",
    # external-agent (cognia-next external-agent surface)
    "ExternalAgentPreset",
    "define_external_agent_preset",
    "register_external_agent_preset",
    "ExternalAgentAdapter",
    "define_external_agent_adapter",
    "register_external_agent_adapter",
    "STDIO",
    "ACP",
    # agent / skills / command manifest mirrors
    "Skill",
    "define_skill",
    "Subagent",
    "define_subagent",
    "AgentTeamTemplate",
    "define_agent_team_template",
    "CharacterPack",
    "define_character_pack",
    "CHARACTER_PACK_SOFT_LIMIT",
    "NativeAnthropicTool",
    "define_native_anthropic_tool",
    "McpServerPreset",
    "define_mcp_server_preset",
    "Command",
    "define_command",
    "QuickAction",
    "define_quick_action",
    # provider / language-server manifest mirrors
    "AiProvider",
    "define_ai_provider",
    "OcrProvider",
    "define_ocr_provider",
    "LspServer",
    "define_lsp_server",
    "CliTool",
    "define_cli_tool",
    "Connector",
    "define_connector",
    "Integration",
    "define_integration",
    # workflow / scheduler / configuration manifest mirrors
    "WorkflowTemplate",
    "define_workflow_template",
    "ScheduledTask",
    "define_scheduled_task",
    "ConfigSchema",
    "define_configuration",
    # appearance manifest mirrors
    "Theme",
    "define_theme",
    "ThemePack",
    "define_theme_pack",
    "FontContribution",
    "define_font_contribution",
    "Wallpaper",
    "define_wallpaper",
    # desktop-pet manifest mirrors
    "PetItem",
    "define_pet_item",
    "PetAchievement",
    "define_pet_achievement",
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
    "ToolRendererDef",
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
    "ContextPanelDef",
    "SessionImporterDef",
    "PluginHook",
    "ensure_serializable",
    "infer_parameters",
    "json_type_for",
]
