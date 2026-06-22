import type {
  PluginContext,
  PluginLogger,
  PluginAgentAPI,
  PluginDexieAPI,
  PluginSessionAPI,
  PluginI18nAPI,
  PluginNotificationCenterAPI,
  PluginQuickActionInput,
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
  PluginConnectorsAPI,
  PluginConnectorAdapterInfo,
  PluginConnectorAdapterSupport,
  PluginAdapterInstanceInfo,
  PluginAdapterInstancePatch,
  PluginAdapterInstanceInput,
  PluginConnectorsA2UIBuilder,
  FullPluginContext,
  PluginGitAPI,
  PluginGitCommitOptions,
  PluginGitCreateBranchOptions,
  PluginGitPullOptions,
  PluginGitPushOptions,
  PluginGitStashPushOptions,
  PluginGitConflictResolution,
  PluginGoalAPI,
  PluginGoalCreateInput,
  PluginSubscriptionAPI,
  PluginUsageSnapshot,
  PluginTerminalAPI,
  PluginCommandRule,
  PluginCommandClassification,
  PluginTerminalSpawnOptions,
  PluginTerminalInfo,
  PluginTerminalCommandRecord,
  PluginRunScriptOptions,
  PluginPerfAPI,
  PluginShareAPI,
  PluginBackupAPI,
  PluginBackupCreateOptions,
  PluginBackupRestoreOptions,
  PluginAutomationAPI,
  PluginCompanionAPI,
  CompanionServerStatus,
  PluginMessagePartAPI,
} from "./index"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The context subpath is type-only — there is no runtime export. This test
 * compiles representative shapes from each surface so the SDK contract
 * fails fast if an upstream interface is renamed or removed without an
 * intentional SDK update.
 */
describe("plugin-sdk: context", () => {
  it("re-exports PluginContext with the runtime fields plugins expect", () => {
    const ctx = {
      pluginId: "x",
      pluginPath: "/tmp",
      config: {},
      logger: {} as PluginLogger,
      storage: {} as PluginContext["storage"],
      events: {} as PluginContext["events"],
      ui: {} as PluginContext["ui"],
      a2ui: {} as PluginContext["a2ui"],
      agent: {} as PluginAgentAPI,
      settings: {} as PluginContext["settings"],
      network: {} as PluginContext["network"],
      fs: {} as PluginContext["fs"],
      clipboard: {} as PluginContext["clipboard"],
      shell: {} as PluginContext["shell"],
      db: {} as PluginContext["db"],
      shortcuts: {} as PluginContext["shortcuts"],
      contextMenu: {} as PluginContext["contextMenu"],
      tray: {} as PluginContext["tray"],
      quickActions: {} as PluginContext["quickActions"],
      window: {} as PluginContext["window"],
      secrets: {} as PluginContext["secrets"],
      scheduler: {} as PluginContext["scheduler"],
      workflow: {} as PluginContext["workflow"],
    } satisfies PluginContext
    expect(ctx.pluginId).toBe("x")
  })

  it("re-exports per-field APIs as standalone types", () => {
    const dexieField: PluginDexieAPI | undefined = undefined
    const session: PluginSessionAPI | undefined = undefined
    const i18n: PluginI18nAPI | undefined = undefined
    const notifications: PluginNotificationCenterAPI | undefined = undefined
    const quickAction: PluginQuickActionInput = { id: "search", title: "Search" }
    expect(dexieField).toBeUndefined()
    expect(session).toBeUndefined()
    expect(i18n).toBeUndefined()
    expect(notifications).toBeUndefined()
    expect(quickAction.id).toBe("search")
  })

  it("declares optional runtime API field exports in the public barrel", () => {
    const barrelSource = readFileSync(
      join(process.cwd(), "packages/plugin-sdk/src/context/index.ts"),
      "utf8"
    )
    const optionalRuntimeApiTypes = [
      "PluginQuickActionsAPI",
      "PluginQuickActionInput",
      "PluginOcrAPI",
      "PluginWorkspaceAPI",
      "PluginModalAPI",
      "PluginWebviewAPI",
      "CreateWebviewInput",
      "PluginAuthAPI",
      "PluginAuthProvider",
      "CreateAuthAPIOptions",
      "PluginUriAPI",
      "PluginUriHandlerDef",
      "PluginChatAPI",
      "PluginCapabilitiesAPI",
      "PluginSecretsBackend",
    ]

    for (const apiType of optionalRuntimeApiTypes) {
      expect(barrelSource).toContain(apiType)
    }
  })

  it("re-exports media and connector runtime API companion types", () => {
    type MediaRuntimeTypes = [
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
    ]
    type ConnectorRuntimeTypes = [
      PluginConnectorsAPI,
      PluginConnectorAdapterInfo,
      PluginConnectorAdapterSupport,
      PluginAdapterInstanceInfo,
      PluginAdapterInstancePatch,
      PluginAdapterInstanceInput,
      PluginConnectorsA2UIBuilder,
    ]

    const mediaTypes: MediaRuntimeTypes | undefined = undefined
    const connectorTypes: ConnectorRuntimeTypes | undefined = undefined

    expect(mediaTypes).toBeUndefined()
    expect(connectorTypes).toBeUndefined()
  })

  it("declares media and connector runtime API field exports in the public barrel", () => {
    const barrelSource = readFileSync(
      join(process.cwd(), "packages/plugin-sdk/src/context/index.ts"),
      "utf8"
    )
    const mediaAndConnectorRuntimeApiTypes = [
      "PluginMediaAPI",
      "ImageFilterDefinition",
      "VideoEffectDefinition",
      "VideoTransitionDefinition",
      "ImageProcessingOptions",
      "ImageTransformOptions",
      "ImageAdjustmentOptions",
      "VideoClip",
      "VideoTransition",
      "VideoExportOptions",
      "PluginConnectorsAPI",
      "PluginConnectorAdapterInfo",
      "PluginConnectorAdapterSupport",
      "PluginAdapterInstanceInfo",
      "PluginAdapterInstancePatch",
      "PluginAdapterInstanceInput",
      "PluginConnectorsA2UIBuilder",
    ]

    for (const apiType of mediaAndConnectorRuntimeApiTypes) {
      expect(barrelSource).toContain(apiType)
    }
  })

  it("re-exports full-context runtime namespace API companion types", () => {
    type FullContextNamespaceTypes = [
      FullPluginContext["git"],
      FullPluginContext["goals"],
      FullPluginContext["subscription"],
      FullPluginContext["terminal"],
      FullPluginContext["perf"],
      FullPluginContext["share"],
      FullPluginContext["backup"],
      FullPluginContext["automation"],
      FullPluginContext["companion"],
      FullPluginContext["messagePart"],
      PluginGitAPI,
      PluginGitCommitOptions,
      PluginGitCreateBranchOptions,
      PluginGitPullOptions,
      PluginGitPushOptions,
      PluginGitStashPushOptions,
      PluginGitConflictResolution,
      PluginGoalAPI,
      PluginGoalCreateInput,
      PluginSubscriptionAPI,
      PluginUsageSnapshot,
      PluginTerminalAPI,
      PluginCommandRule,
      PluginCommandClassification,
      PluginTerminalSpawnOptions,
      PluginTerminalInfo,
      PluginTerminalCommandRecord,
      PluginRunScriptOptions,
      PluginPerfAPI,
      PluginShareAPI,
      PluginBackupAPI,
      PluginBackupCreateOptions,
      PluginBackupRestoreOptions,
      PluginAutomationAPI,
      PluginCompanionAPI,
      CompanionServerStatus,
      PluginMessagePartAPI,
    ]

    const namespaceTypes: FullContextNamespaceTypes | undefined = undefined

    expect(namespaceTypes).toBeUndefined()
  })

  it("declares full-context runtime namespace exports in the public barrel", () => {
    const barrelSource = readFileSync(
      join(process.cwd(), "packages/plugin-sdk/src/context/index.ts"),
      "utf8"
    )
    const fullContextRuntimeApiTypes = [
      "FullPluginContext",
      "PluginGitAPI",
      "PluginGitCommitOptions",
      "PluginGitCreateBranchOptions",
      "PluginGitPullOptions",
      "PluginGitPushOptions",
      "PluginGitStashPushOptions",
      "PluginGitConflictResolution",
      "PluginGoalAPI",
      "PluginGoalCreateInput",
      "PluginSubscriptionAPI",
      "PluginUsageSnapshot",
      "PluginTerminalAPI",
      "PluginCommandRule",
      "PluginCommandClassification",
      "PluginTerminalSpawnOptions",
      "PluginTerminalInfo",
      "PluginTerminalCommandRecord",
      "PluginRunScriptOptions",
      "PluginPerfAPI",
      "PluginShareAPI",
      "PluginBackupAPI",
      "PluginBackupCreateOptions",
      "PluginBackupRestoreOptions",
      "PluginAutomationAPI",
      "PluginCompanionAPI",
      "CompanionServerStatus",
      "PluginMessagePartAPI",
    ]

    for (const apiType of fullContextRuntimeApiTypes) {
      expect(barrelSource).toContain(apiType)
    }
  })

  it("declares configuration and import API field exports in the public barrel", () => {
    const barrelSource = readFileSync(
      join(process.cwd(), "packages/plugin-sdk/src/context/index.ts"),
      "utf8"
    )
    const extendedFieldApiTypes = [
      "PluginConfigAPI",
      "PluginImportAPI",
      "CustomImporter",
      "ImportSource",
      "ImportResult",
    ]

    for (const apiType of extendedFieldApiTypes) {
      expect(barrelSource).toContain(apiType)
    }
  })

  it("declares agent API companion types in the public barrel", () => {
    const barrelSource = readFileSync(
      join(process.cwd(), "packages/plugin-sdk/src/context/index.ts"),
      "utf8"
    )
    const agentApiCompanionTypes = [
      "PluginAgentRun",
      "PluginAgentRunOptions",
      "PluginAgentRunResult",
      "PluginDispatchSubagentOptions",
      "PluginSubagentDispatchResult",
      "PluginRunTeamOptions",
      "PluginRunTeamResult",
      "PluginAgentGuardrailsAPI",
      "PluginAgentSessionsAPI",
      "PluginCreateSessionOptions",
      "PluginAgentContextAPI",
      "PluginContextProvider",
      "PluginSharedMemoryReadOptions",
      "PluginTwinMemoryQueryOptions",
    ]

    for (const apiType of agentApiCompanionTypes) {
      expect(barrelSource).toContain(apiType)
    }
  })
})
