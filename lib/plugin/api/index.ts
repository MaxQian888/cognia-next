/**
 * Plugin API Module Index
 *
 * Exports the host implementations behind the single public plugin context.
 */

export { createSessionAPI } from "./session-api"
export { createProjectAPI } from "./project-api"
export { createVectorAPI } from "./vector-api"
export { createThemeAPI } from "./theme-api"
export { createExportAPI } from "./export-api"
export { createImportAPI } from "./import-api"
export { createConfigAPI, emitPluginConfigChange } from "./config-api"
export { createSecretsAPI, clearPluginSecrets, getSecretsBackendKind } from "./secrets-api"
export { createI18nAPI } from "./i18n-api"
export { createCanvasAPI } from "./canvas-api"
export {
  createArtifactAPI,
  getArtifactRenderers,
  getBuiltinRenderers,
  getDefaultArtifactRenderer,
  getArtifactPreviewComponent,
} from "./artifact-api"
export {
  createNotificationCenterAPI,
  dispatchNotificationAction,
  setToastDispatcher,
} from "./notification-api"
export { createAIProviderAPI, getCustomAIProviders } from "./ai-provider-api"
export {
  createExtensionAPI,
  getExtensionsForPoint,
  clearPluginExtensions,
  getPluginExtensionRegistrationCount,
  getPluginExtensionDiagnostics,
  clearAllExtensionDiagnostics,
  subscribeExtensionChanges,
  getExtensionRevision,
} from "./extension-api"
export {
  createPermissionAPI,
  initializePluginPermissions,
  revokePluginPermissions,
  grantPermission,
  revokePermission,
} from "./permission-api"
export { createOcrAPI, clearOcrProvidersForPlugin } from "./ocr-api"
export { createWorkspaceAPI, clearWorkspaceBackendsForPluginContext } from "./workspace-api"
export { createModalAPI } from "./modal-api"
export { createWebviewAPI } from "./webview-api"
export { createAuthAPI } from "./auth-api"
export { createUriAPI } from "./uri-api"
export { createChatAPI, clearChatMiddlewaresForPluginContext } from "./chat-api"
export { createCapabilitiesAPI } from "./capabilities-api"
export { createDexieAPI } from "./dexie-api"
export { createTrayAPI } from "./tray-api"
export { createQuickActionsAPI } from "./quick-actions-api"
export { createMediaAPI, getMediaRegistry } from "./media-api"
export { createStorageAPI, clearPluginStorage, getAllPluginStorageUsage } from "./storage-api"
export type { PluginStorageAPI } from "./storage-api"

// Connectors / IM messaging API (ctx.connectors) — gated read/send/manage plus
// the ungated A2UI rich-content builder. Exported here so SDK authors import
// the surface + its types from the canonical `@/lib/plugin/api` barrel rather
// than deep-importing the implementation module.
export { createConnectorsAPI } from "./connectors-api"
export { createIntegrationsAPI } from "./integrations-api"
export type {
  PluginConnectorsAPI,
  PluginConnectorAdapterInfo,
  PluginConnectorAdapterSupport,
  PluginAdapterInstanceInfo,
  PluginAdapterInstancePatch,
  PluginAdapterInstanceInput,
  PluginConnectorsA2UIBuilder,
} from "./connectors-api"

export { createMessagePartAPI, purgeMessagePartRenderersForPlugin } from "./message-part-api"
export { createToolResultAPI, purgeToolResultRenderersForPlugin } from "./tool-result-api"
export { createGitAPI, NoActiveRepoError } from "./git-api"
export { createGoalAPI, NoJudgeModelError } from "./goal-api"
export { createMemoryAPI } from "./memory-api"
export { createTeamAPI } from "./team-api"
export { createSubscriptionAPI } from "./subscription-api"
export { createTerminalAPI, TerminalAccessError } from "./terminal-api"
export { createPerfAPI } from "./perf-api"
export { createShareAPI } from "./share-api"
export { createBackupAPI } from "./backup-api"
export { createAutomationAPI } from "./automation-api"
export { createCompanionAPI } from "./companion-api"
export { createContextPanelAPI } from "./context-panel-api"
export { createEditorAPI } from "./editor-api"
export {
  createTemplatesAPI,
  clearTemplatesForPluginContext,
  registerLegacyPluginTemplateCompatibility,
  registerPluginTemplatePackages,
} from "./templates-api"
export type { PluginTemplatesAPI } from "./templates-api"

// Re-export types
export type {
  PluginSessionAPI,
  PluginProjectAPI,
  PluginVectorAPI,
  PluginThemeAPI,
  PluginExportAPI,
  PluginI18nAPI,
  PluginCanvasAPI,
  PluginArtifactAPI,
  PluginNotificationCenterAPI,
  PluginAIProviderAPI,
  PluginExtensionAPI,
  PluginPermissionAPI,
  PluginContextAPI,
} from "@/types/plugin/plugin"

// Re-export mounted context API types.
export type { PluginOcrAPI } from "./ocr-api"
export type { PluginWorkspaceAPI } from "./workspace-api"
export type { PluginModalAPI } from "./modal-api"
export type { CreateWebviewInput, PluginWebviewAPI } from "./webview-api"
export type { CreateAuthAPIOptions, PluginAuthAPI, PluginAuthProvider } from "./auth-api"
export type { PluginUriAPI, PluginUriHandlerDef } from "./uri-api"
export type { PluginChatAPI } from "./chat-api"
export type { PluginCapabilitiesAPI } from "./capabilities-api"
export type { PluginDexieAPI } from "./dexie-api"
export type {
  PluginMediaAPI,
  ImageFilterDefinition,
  FilterParameterDefinition,
  VideoEffectDefinition,
  VideoTransitionDefinition,
  ImageProcessingOptions,
  ImageTransformOptions,
  ImageAdjustmentOptions,
  VideoClip,
  VideoTransition,
  VideoExportOptions,
  ExportProgress,
  MediaProcessingResult,
} from "./media-api"
export type { PluginMessagePartAPI } from "./message-part-api"
export type {
  PluginGitAPI,
  PluginGitCommitOptions,
  PluginGitCreateBranchOptions,
  PluginGitPullOptions,
  PluginGitPushOptions,
  PluginGitStashPushOptions,
  PluginGitConflictResolution,
} from "./git-api"
export type { PluginGoalAPI, PluginGoalCreateInput } from "./goal-api"
export type {
  PluginMemoryAPI,
  PluginMemoryListFilter,
  PluginMemorySearchOptions,
  PluginMemoryStoreInput,
} from "./memory-api"
export type { PluginTeamAPI, PluginTeamMoveResult, PluginTeamTaskCreateInput } from "./team-api"
export type { PluginSubscriptionAPI, PluginUsageSnapshot } from "./subscription-api"
export type {
  PluginTerminalAPI,
  PluginCommandRule,
  PluginCommandClassification,
  PluginTerminalSpawnOptions,
  PluginTerminalInfo,
  PluginTerminalCommandRecord,
  PluginRunScriptOptions,
} from "./terminal-api"
export type { PluginPerfAPI } from "./perf-api"
export type { PluginShareAPI } from "./share-api"
export type {
  PluginBackupAPI,
  PluginBackupCreateOptions,
  PluginBackupRestoreOptions,
} from "./backup-api"
export type { PluginAutomationAPI } from "./automation-api"
export type { PluginCompanionAPI, CompanionServerStatus } from "./companion-api"
export type {
  PluginContextPanelAPI,
  PluginContextPanelRegistration,
  PluginContextWorkbenchState,
} from "./context-panel-api"
