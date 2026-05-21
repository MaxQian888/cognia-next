/**
 * Barrel smoke test — guards against accidental re-export deletion.
 * Each function-shaped symbol is type-checked + tested for callability;
 * type-only re-exports are exercised by importers elsewhere.
 */

import * as api from "./index"

describe("lib/plugin/api barrel", () => {
  it.each([
    "createSessionAPI",
    "createProjectAPI",
    "createVectorAPI",
    "createThemeAPI",
    "createExportAPI",
    "createI18nAPI",
    "createCanvasAPI",
    "createArtifactAPI",
    "getArtifactRenderers",
    "getBuiltinRenderers",
    "getDefaultArtifactRenderer",
    "getArtifactPreviewComponent",
    "createNotificationCenterAPI",
    "dispatchNotificationAction",
    "setToastDispatcher",
    "createAIProviderAPI",
    "getCustomAIProviders",
    "createExtensionAPI",
    "getExtensionsForPoint",
    "clearPluginExtensions",
    "getPluginExtensionRegistrationCount",
    "getPluginExtensionDiagnostics",
    "clearAllExtensionDiagnostics",
    "subscribeExtensionChanges",
    "getExtensionRevision",
    "createPermissionAPI",
    "initializePluginPermissions",
    "revokePluginPermissions",
    "grantPermission",
    "revokePermission",
    "createMediaAPI",
    "getMediaRegistry",
    "createStorageAPI",
    "clearPluginStorage",
    "getAllPluginStorageUsage",
  ])("exports %s as a function", (name) => {
    const sym = (api as Record<string, unknown>)[name]
    expect(typeof sym).toBe("function")
  })
})
