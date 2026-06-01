/**
 * Plugin API Module Index
 *
 * Exports all plugin API implementations for the extended SDK.
 */

export { createSessionAPI } from "./session-api"
export { createProjectAPI } from "./project-api"
export { createVectorAPI } from "./vector-api"
export { createThemeAPI } from "./theme-api"
export { createExportAPI } from "./export-api"
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
export { createMediaAPI, getMediaRegistry } from "./media-api"
export { createStorageAPI, clearPluginStorage, getAllPluginStorageUsage } from "./storage-api"
export type { PluginStorageAPI } from "./storage-api"

// Connectors / IM messaging API (ctx.connectors) — gated read/send/manage plus
// the ungated A2UI rich-content builder. Exported here so SDK authors import
// the surface + its types from the canonical `@/lib/plugin/api` barrel rather
// than deep-importing the implementation module.
export { createConnectorsAPI } from "./connectors-api"
export type {
  PluginConnectorsAPI,
  PluginConnectorAdapterInfo,
  PluginConnectorAdapterSupport,
  PluginAdapterInstanceInfo,
  PluginAdapterInstancePatch,
  PluginAdapterInstanceInput,
  PluginConnectorsA2UIBuilder,
} from "./connectors-api"

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
} from "@/types/plugin/plugin-extended"

// Re-export media API types
export type {
  PluginMediaAPI,
  ImageFilterDefinition,
  VideoEffectDefinition,
  VideoTransitionDefinition,
  ImageProcessingOptions,
  ImageTransformOptions,
  ImageAdjustmentOptions,
  VideoClip,
  VideoTransition,
  VideoExportOptions,
} from "./media-api"
