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

export type { PluginNodeRuntimeDeclaration } from "@cognia/plugin-contract/types/plugin/plugin-node-runtime"
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
  PluginWebhookVerification,
  PluginWebhookDigest,
  PluginWebhookEncoding,
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
  PluginNetworkAccessRule,
  PluginModeDef,
  PluginManifestCommandDef,
  PluginQuickActionDef,
  PluginQuickActionSurface,
  PluginQuickActionInvocation,
  PluginQuickActionResult,
  PluginSelectionActionSpec,
  PluginSelectionContentType,
  PluginSelectionOrigin,
  PluginSelectionQuickActionContext,
  PluginSelectionReplaceCapability,
  PluginManifestTrayItemDef,
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
} from "@cognia/plugin-contract/types/plugin/plugin"
export type * from "@cognia/plugin-contract/types/plugin/plugin-ide"

export { definePlugin, definePluginManifest } from "../define/define-plugin"
export type { PluginManifestJson } from "../define/define-plugin"

export type { PluginAgentTeamTemplateDef } from "@cognia/plugin-contract/types/plugin/plugin-agent-team-template"
export type { PluginAiProviderDef } from "@cognia/plugin-contract/types/plugin/plugin-ai-provider"
export type { PluginAuthProviderDef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
export type { PluginBalanceAdapterDef } from "@cognia/plugin-contract/types/plugin/plugin-balance-adapter"
export type { PluginCharacterPackDef } from "@cognia/plugin-contract/types/plugin/plugin-character-pack"
export type { PluginChatMiddlewareDef } from "@cognia/plugin-contract/types/plugin/plugin-chat-middleware"
export type { PluginCliToolDef } from "@cognia/plugin-contract/types/plugin/plugin-cli-tool"
export type { PluginCompactionStrategyDef } from "@cognia/plugin-contract/types/plugin/plugin-compaction-strategy"
export type { PluginContextProviderDef } from "@cognia/plugin-contract/types/plugin/plugin-context-provider"
export type {
  PluginContextPanelDef,
  PluginContextPanelIcon,
  PluginContextPanelRenderer,
} from "@cognia/plugin-contract/types/plugin/plugin-context-panel"
export type { PluginDeploymentFilterDef } from "@cognia/plugin-contract/types/plugin/plugin-deployment-filter"
export type { PluginImRateSourceDef } from "@cognia/plugin-contract/types/plugin/plugin-im-rate-source"
export type { PluginIconName } from "@cognia/plugin-contract/types/plugin/plugin-icon"
export type { PluginExtensionDef } from "@cognia/plugin-contract/types/plugin/plugin-extension"
export type {
  PluginGlanceModuleSize,
  PluginGlancePlatform,
  PluginManifestGlanceModuleDef,
} from "@cognia/plugin-contract/types/plugin/plugin-glance"
export type { PluginLimitsSourceDef } from "@cognia/plugin-contract/types/plugin/plugin-limits-source"
export type { PluginMcpServerPresetDef } from "@cognia/plugin-contract/types/plugin/plugin-mcp-preset"
export type { PluginLinkMatcherDef } from "@cognia/plugin-contract/types/plugin/plugin-link-matcher"
export type { PluginMessageRendererDef } from "@cognia/plugin-contract/types/plugin/plugin-message-renderer"
export type { PluginModalMountDef } from "@cognia/plugin-contract/types/plugin/plugin-modal"
export type { PluginNativeAnthropicToolDef } from "@cognia/plugin-contract/types/plugin/plugin-native-tool"
export type { PluginOcrProviderDef } from "@cognia/plugin-contract/types/plugin/plugin-ocr"
export type { PluginDecisionProviderDef } from "@cognia/plugin-contract/types/plugin/plugin-decisions"
export type {
  PluginPetAchievementCondition,
  PluginPetAchievementDef,
  PluginPetItemDef,
} from "@cognia/plugin-contract/types/plugin/plugin-pet"
export type {
  PluginPiPackageDef,
  PluginPiPackageEnvBinding,
  PluginPiPackageEnvSource,
  PluginPiPackageHostedSession,
  PluginPiPackagePrepare,
  PluginPiPackageRef,
} from "@cognia/plugin-contract/types/plugin/plugin-pi-package"
export type { PluginProtocolAdapterDef } from "@cognia/plugin-contract/types/plugin/plugin-protocol-adapter"
export type { PluginRoutingStrategyDef } from "@cognia/plugin-contract/types/plugin/plugin-routing-strategy"
export type { PluginSharedMemoryAdapterDef } from "@cognia/plugin-contract/types/plugin/plugin-shared-memory-adapter"
export type { PluginSkillDef } from "@cognia/plugin-contract/types/plugin/plugin-skill"
export type { PluginSubagentDef } from "@cognia/plugin-contract/types/plugin/plugin-subagent"
export type { PluginTerminalCompletionProviderDef } from "@cognia/plugin-contract/types/plugin/plugin-terminal-completion"
export type { PluginToolRouteDef } from "@cognia/plugin-contract/types/plugin/plugin-tool-route"
export type { PluginViewContainerDef } from "@cognia/plugin-contract/types/plugin/plugin-view-container"
export type { PluginViewDef } from "@cognia/plugin-contract/types/plugin/plugin-view"
export type { PluginWebviewDef } from "@cognia/plugin-contract/types/plugin/plugin-webview"
export type { PluginManifestWorkflowsBlock } from "@cognia/plugin-contract/types/plugin/plugin-workflow"
export type { PluginWorkflowTemplateDef } from "@cognia/plugin-contract/types/plugin/plugin-workflow-template"
export type { PluginWorkspaceBackendDef } from "@cognia/plugin-contract/types/plugin/plugin-workspace-backend"
export type {
  IntegrationActionDef,
  IntegrationAuthStrategy,
  IntegrationEventEnvelope,
  IntegrationInboxProjectionDef,
  PluginIntegrationDef,
} from "@cognia/plugin-contract/types/plugin/plugin-integration"

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
  PluginTaskOverlapPolicy,
  PluginTaskRetryConfig,
  PluginTaskExecutionOptions,
  PluginTaskExecutionPhase,
  PluginTaskExecutionEvent,
  PluginTaskStatistics,
} from "@cognia/plugin-contract/types/plugin/plugin-scheduler"

export type { VsCodeExtensionBlock } from "@cognia/plugin-contract/types/plugin/plugin-vscode"

export type { PluginVerificationSnapshot } from "@cognia/plugin-contract/types/plugin/plugin-verification"

/**
 * Manifest validation — the SAME validator the plugin manager runs at install
 * time. A plugin's own test asserting `validatePluginManifest(manifest).valid`
 * is the cheapest way to catch a contribution that would be rejected on load,
 * and running the host's validator (rather than a hand-rolled shape check) is
 * what makes that assertion mean something.
 */
export {
  parseManifest,
  validatePluginConfig,
  validatePluginManifest,
} from "@/lib/plugin/core/validation"

/**
 * Host-version compatibility — the same check the manager applies before it
 * enables a plugin (`engines.cognia`, `minAppVersion`, `maxAppVersion`). Pure:
 * pass the host version you want to test against.
 */
export { evaluatePluginCompatibility } from "@/lib/plugin/core/compatibility"
export type {
  CompatibilityDiagnostic,
  CompatibilityEvaluation,
  CompatibilityRuntime,
} from "@cognia/plugin-contract/lib/plugin/core/compatibility"

export type {
  ConfigValidationResult,
  ManifestDiagnostic,
  ManifestValidationOptions,
  ValidationError,
  ValidationResult,
} from "@cognia/plugin-contract/lib/plugin/core/validation"

/**
 * Parity between a packaged `plugin.json` and a TypeScript manifest overlay.
 *
 * A plugin that ships both has two manifests, and the module overlay WINS the
 * merge — so a contribution declared only in TS exists nowhere an installed
 * copy can reach, and one declared only in JSON is silently dropped. This is
 * the check that catches the divergence, and it belongs in the plugin's own
 * test rather than in a reviewer's head.
 */
export {
  assertPluginManifestParity,
  findPluginManifestParityIssues,
  PluginManifestParityError,
} from "@/lib/plugin/core/manifest-parity"

export type { PluginManifestParityIssue } from "@cognia/plugin-contract/lib/plugin/core/manifest-parity"

export type {
  PluginLibrarySchema,
  PluginLibraryRisk,
  PluginLibraryMethod,
  PluginLibraryModule,
  PluginLibraryContract,
  PluginLibrariesAPI,
  PluginLibraryModuleInstance,
  PluginLibraryModuleFactory,
} from "@cognia/plugin-contract/types/plugin/plugin-library"
