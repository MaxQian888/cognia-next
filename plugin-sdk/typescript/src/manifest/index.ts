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
 *  - Capability def types (e.g. `PluginNativeAnthropicToolDef`,
 *    `PluginSkillDef`, `PluginMcpServerPresetDef`, `PluginNodeDef`,
 *    `PluginTriggerDef`) live under `@cognia/plugin-sdk/api/<cap>`.
 *  - Hook interfaces (`PluginHooks`, event-shape types) live in
 *    `@cognia/plugin-sdk/hooks`.
 *  - Extension-point types live in `@cognia/plugin-sdk/extensions`.
 *  - Runtime API types live in `@cognia/plugin-sdk/context`.
 */

export type {
  PluginManifest,
  PluginManifestDexieBlock,
  PluginDexieTableDef,
  PluginDexieMigrationDef,
  PluginManifestTaskTrigger,
  PluginScheduledTaskDef,
  PluginConfigSchema,
  PluginConfigProperty,
  PluginActivationEvent,
  PluginConnectorDef,
  PluginExternalAgentPresetDef,
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
} from "@/types/plugin/plugin"

export { definePlugin } from "@/types/plugin/plugin"

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
