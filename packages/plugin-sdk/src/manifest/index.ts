/**
 * Plugin SDK — `manifest` subpath.
 *
 * Re-exports the manifest schema, capability enum, lifecycle states, and
 * the `definePlugin()` author helper. Source of truth is
 * `types/plugin/plugin.ts`; this module is a stable pass-through so plugin
 * authors can import the contract from `@cognia/plugin-sdk/manifest`.
 *
 * Partitioning:
 *  - Permission types live in `@cognia/plugin-sdk/permissions`.
 *  - Declarative capability types are re-exported here so authors can type
 *    complete `PluginManifest` objects from one import. Only the documented
 *    `/api/tool` and `/api/native-anthropic-tool` compatibility paths exist.
 *  - Hook interfaces (`PluginHooks`, event-shape types) live in
 *    `@cognia/plugin-sdk/hooks`.
 *  - Extension-point types live in `@cognia/plugin-sdk/extensions`.
 *  - Runtime API types live in `@cognia/plugin-sdk/context`.
 */

import type { PluginDefinition } from "@/types/plugin/plugin"

export type {
  PluginManifest,
  PluginManifestDexieBlock,
  PluginDexieTableDef,
  PluginDexieMigrationDef,
  PluginManifestTaskTrigger,
  PluginScheduledTaskDef,
  PluginBinaryRequirement,
  PluginResilienceConfig,
  PluginConfigSchema,
  PluginConfigScope,
  PluginConfigProperty,
  PluginActivationEvent,
  PluginConnectorDef,
  PluginExternalAgentPresetDef,
  PluginExternalAgentAdapterDef,
  PluginManifestThemeColors,
  PluginThemeContribution,
  PluginType,
  PluginCapability,
  PluginStatus,
  PluginSource,
  PluginRuntimeProfile,
  PluginRuntimeAvailability,
  PluginRuntimeCompatibilityTarget,
  PluginRuntimeCompatibilityMap,
  PluginReview,
  PluginInstallRootKind,
  ExtensionOperation,
  ExtensionCompatibilityDiagnostic,
  ExtensionCompatibilitySummary,
  ExtensionInstallRoot,
  ExtensionCanonicalIdentity,
  PluginResolvedIcon,
  ExtensionDescriptor,
  ExtensionCatalogEntry,
  A2UIPluginComponentDef,
  A2UITemplateDef,
  PluginA2UIComponent,
  A2UIPluginComponentProps,
  PluginToolDef,
  PluginTool,
  PluginToolContext,
  PluginModeDef,
  PluginManifestCommandDef,
  PluginQuickActionDef,
  PluginQuickActionSurface,
  PluginA2UIAction,
  PluginA2UIDataChange,
  PluginAgentStep,
  PluginMessage,
  PluginCommand,
  PluginDefinition,
  Plugin,
  PluginStoreState,
  PluginSystemEvent,
  PythonPluginManifest,
  PythonToolDef,
  PythonParamDef,
  PythonHookRegistration,
  PythonIPCMessage,
  PluginThemePackContribution,
  PluginFontContribution,
  PluginWallpaperContribution,
  PluginDensityPresetContribution,
  PluginLspServerDef,
} from "@/types/plugin/plugin"

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}

export type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"
export type { PluginAiProviderDef } from "@/types/plugin/plugin-ai-provider"
export type { PluginAuthProviderDef } from "@/types/plugin/plugin-auth"
export type { PluginBalanceAdapterDef } from "@/types/plugin/plugin-balance-adapter"
export type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"
export type { PluginChatMiddlewareDef } from "@/types/plugin/plugin-chat-middleware"
export type { PluginCliToolDef } from "@/types/plugin/plugin-cli-tool"
export type { PluginCompactionStrategyDef } from "@/types/plugin/plugin-compaction-strategy"
export type { PluginContextProviderDef } from "@/types/plugin/plugin-context-provider"
export type {
  PluginContextPanelDef,
  PluginContextPanelIcon,
  PluginContextPanelRenderer,
} from "@/types/plugin/plugin-context-panel"
export type { PluginDeploymentFilterDef } from "@/types/plugin/plugin-deployment-filter"
export type { PluginImRateSourceDef } from "@/types/plugin/plugin-im-rate-source"
export type { PluginLimitsSourceDef } from "@/types/plugin/plugin-limits-source"
export type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
export type { PluginMessageRendererDef } from "@/types/plugin/plugin-message-renderer"
export type { PluginModalMountDef } from "@/types/plugin/plugin-modal"
export type { PluginNativeAnthropicToolDef } from "@/types/plugin/plugin-native-tool"
export type { PluginOcrProviderDef } from "@/types/plugin/plugin-ocr"
export type {
  PluginPetAchievementCondition,
  PluginPetAchievementDef,
  PluginPetItemDef,
} from "@/types/plugin/plugin-pet"
export type { PluginProtocolAdapterDef } from "@/types/plugin/plugin-protocol-adapter"
export type { PluginRoutingStrategyDef } from "@/types/plugin/plugin-routing-strategy"
export type { PluginSharedMemoryAdapterDef } from "@/types/plugin/plugin-shared-memory-adapter"
export type { PluginSkillDef } from "@/types/plugin/plugin-skill"
export type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
export type { PluginTerminalCompletionProviderDef } from "@/types/plugin/plugin-terminal-completion"
export type { PluginToolRouteDef } from "@/types/plugin/plugin-tool-route"
export type { PluginViewContainerDef } from "@/types/plugin/plugin-view-container"
export type { PluginViewDef } from "@/types/plugin/plugin-view"
export type { PluginWebviewDef } from "@/types/plugin/plugin-webview"
export type { PluginManifestWorkflowsBlock } from "@/types/plugin/plugin-workflow"
export type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"
export type { PluginWorkspaceBackendDef } from "@/types/plugin/plugin-workspace-backend"

export type {
  CronTrigger,
  IntervalTrigger,
  OnceTrigger,
  EventTrigger,
  PluginTaskTrigger,
  PluginTaskStatus,
  PluginTaskExecutionStatus,
  PluginTaskResult,
  PluginTaskContext,
  PluginTaskHandler,
  PluginScheduledTask,
  PluginTaskExecution,
  CreatePluginTaskInput,
  UpdatePluginTaskInput,
  PluginTaskFilter,
} from "@/types/plugin/plugin-scheduler"

export type { VsCodeExtensionBlock } from "@/types/plugin/plugin-vscode"

export type { PluginVerificationSnapshot } from "@/types/plugin/plugin-verification"
