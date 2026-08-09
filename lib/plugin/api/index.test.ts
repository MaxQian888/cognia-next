/**
 * Barrel smoke test — guards against accidental re-export deletion.
 * Each function-shaped symbol is type-checked + tested for callability;
 * type-only re-exports are exercised by importers elsewhere.
 */

import * as api from "./index"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("lib/plugin/api barrel", () => {
  it.each([
    "createSessionAPI",
    "createContextPanelAPI",
    "createProjectAPI",
    "createVectorAPI",
    "createThemeAPI",
    "createExportAPI",
    "createI18nAPI",
    "createCanvasAPI",
    "createArtifactAPI",
    "createFilesAPI",
    "authorizePluginAttachment",
    "revokePluginFileHandles",
    "createSkillsAPI",
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
    "createOcrAPI",
    "clearOcrProvidersForPlugin",
    "createWorkspaceAPI",
    "clearWorkspaceBackendsForPluginContext",
    "createModalAPI",
    "createWebviewAPI",
    "createAuthAPI",
    "createUriAPI",
    "createChatAPI",
    "clearChatMiddlewaresForPluginContext",
    "createCapabilitiesAPI",
    "createDexieAPI",
    "createTrayAPI",
    "createQuickActionsAPI",
    "createMediaAPI",
    "getMediaRegistry",
    "createStorageAPI",
    "clearPluginStorage",
    "getAllPluginStorageUsage",
    "createConnectorsAPI",
    "createMessagePartAPI",
    "purgeMessagePartRenderersForPlugin",
    "createGitAPI",
    "NoActiveRepoError",
    "createGoalAPI",
    "NoJudgeModelError",
    "createSubscriptionAPI",
    "createTerminalAPI",
    "TerminalAccessError",
    "createPerfAPI",
    "createShareAPI",
    "createBackupAPI",
    "createAutomationAPI",
    "createCompanionAPI",
  ])("exports %s as a function", (name) => {
    const sym = (api as Record<string, unknown>)[name]
    expect(typeof sym).toBe("function")
  })

  it("declares public type exports for every mounted context API family", () => {
    const barrelSource = readFileSync(join(process.cwd(), "lib/plugin/api/index.ts"), "utf8")
    const mountedApiTypes = [
      "PluginOcrAPI",
      "PluginWorkspaceAPI",
      "PluginModalAPI",
      "CreateWebviewInput",
      "PluginWebviewAPI",
      "CreateAuthAPIOptions",
      "PluginAuthAPI",
      "PluginAuthProvider",
      "PluginUriAPI",
      "PluginUriHandlerDef",
      "PluginChatAPI",
      "PluginCapabilitiesAPI",
      "PluginDexieAPI",
      "PluginMediaAPI",
      "PluginConnectorsAPI",
      "PluginMessagePartAPI",
      "PluginGitAPI",
      "PluginGoalAPI",
      "PluginSubscriptionAPI",
      "PluginTerminalAPI",
      "PluginPerfAPI",
      "PluginShareAPI",
      "PluginBackupAPI",
      "PluginAutomationAPI",
      "PluginCompanionAPI",
      "PluginContextPanelAPI",
    ]

    for (const apiType of mountedApiTypes) {
      expect(barrelSource).toContain(apiType)
    }
  })
})
