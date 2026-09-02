import * as sdk from "./index"
import type { PluginManifest } from "./index"

const rootBarrel = sdk as Record<string, unknown>

describe("plugin-sdk root barrel", () => {
  it("re-exports the legacy define helper surface from the package root", () => {
    const helperExports = [
      "defineMcpServerPreset",
      "defineNativeAnthropicTool",
      "defineSkill",
      "defineSubagent",
      "defineAgentTeamTemplate",
      "defineCharacterPack",
      "defineWorkflowTemplate",
      "defineWorkflowNodeGroup",
      "defineWorkflowNodeGroups",
      "defineTemplate",
      "defineTemplatePackage",
      "defineAgentTool",
      "defineTool",
      "defineGuardrail",
      "defineContextProvider",
      "defineA2UIComponent",
      "defineA2UITemplate",
      "defineAiProvider",
      "defineCliTool",
      "defineCommand",
      "defineLspServer",
      "defineMode",
      "defineOcrProvider",
      "definePetAchievement",
      "definePetItem",
      "defineScheduledTask",
      "defineWorkspaceBackend",
      "defineMessageRenderer",
      "defineDensityPreset",
      "defineChatMiddleware",
      "defineModalMount",
      "defineTerminalCompletionProvider",
      "defineRoutingStrategy",
      "defineDeploymentFilter",
      "defineProtocolAdapter",
      "defineToolRoute",
      "defineViewContainer",
      "defineView",
      "defineTreeDataProvider",
      "defineWebview",
      "defineAuthProvider",
      "defineUriHandler",
      "defineTheme",
      "defineThemePack",
      "defineFontContribution",
      "defineWallpaper",
      "defineConnector",
      "defineWorkflowNode",
      "defineWorkflowTrigger",
      "defineExporter",
      "defineImporter",
      "defineConfiguration",
      "defineQuickAction",
      "defineExternalAgentPreset",
      "defineExternalAgentAdapter",
      "defineSessionImporter",
      "defineSharedMemoryAdapter",
      "defineBalanceAdapter",
      "defineLimitsSource",
      "defineImRateSource",
      "defineCompactionStrategy",
      "defineTrayItem",
    ]

    for (const helperExport of helperExports) {
      expect(typeof rootBarrel[helperExport]).toBe("function")
    }
  })

  it("does not publish host auth or PII implementations", () => {
    expect(rootBarrel.runPkceAuthFlow).toBeUndefined()
    expect(rootBarrel.__makeSession).toBeUndefined()
    expect(rootBarrel.createPiiRedactionGate).toBeUndefined()
    expect(rootBarrel.createPiiOutputGuardrail).toBeUndefined()
    expect(rootBarrel.MessageBusConfig).toBeUndefined()
  })

  it("publishes the catalog-backed runtime constants", () => {
    expect(rootBarrel.SystemEvents).toBeDefined()
    expect(rootBarrel.CANONICAL_EXTENSION_POINTS).toBeDefined()
    expect(rootBarrel.PLUGIN_MANIFEST_CONTRIBUTIONS).toBeDefined()
    expect(rootBarrel.PLUGIN_RUNTIME_ENTRY_CONTRACTS).toBeDefined()
  })

  /**
   * A plugin that reads or writes a session's reasoning tier has to compose the
   * host's own vocabulary. A private copy of the level list silently stops
   * offering a tier the host has added, and a hand-written
   * `{ effort, thinkingLevel }` pair is exactly the disagreement
   * `thinkingLevelPatch` exists to make impossible.
   */
  it("publishes the reasoning-tier vocabulary so plugins do not re-declare it", () => {
    expect(rootBarrel.THINKING_LEVELS).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ])
    expect(rootBarrel.resolveThinkingLevel).toBeInstanceOf(Function)
    expect(rootBarrel.thinkingLevelPatch).toBeInstanceOf(Function)
    expect(rootBarrel.thinkingLevelToEffort).toBeInstanceOf(Function)
  })

  /**
   * The vocabulary without the narrowing is a trap: a plugin that maps over
   * `THINKING_LEVELS` offers `max` on a surface that folds it into `high`, and
   * names a depth the request never carries. These three are what let an author
   * narrow to the ladder a provider/model actually honours.
   */
  it("publishes the narrowing helpers alongside the tier vocabulary", () => {
    expect(rootBarrel.availableThinkingLevels).toBeInstanceOf(Function)
    expect(rootBarrel.clampThinkingLevel).toBeInstanceOf(Function)
    expect(rootBarrel.visibleThinkingLevels).toBeInstanceOf(Function)

    // The offered ladder is depths only. `off` is not one, so a plugin that
    // wants it has to add it deliberately rather than find it here.
    expect(rootBarrel.externalAgentThinkingLevels).toBeInstanceOf(Function)

    const offered = rootBarrel.availableThinkingLevels({
      providerId: "openai",
      modelId: "gpt-5",
    })
    expect(offered.length).toBeGreaterThan(0)
    expect(offered).not.toContain("off")
    // `ultracode` IS `xhigh` plus the workflow suite, so it may only appear on
    // a surface where `xhigh` survives to the wire.
    if (offered.includes("ultracode")) expect(offered).toContain("xhigh")

    // A tier the surface cannot honour folds DOWN for display, never echoes back.
    expect(rootBarrel.clampThinkingLevel("max", ["low", "medium", "high"])).toBe("high")
    expect(rootBarrel.visibleThinkingLevels(["low", "medium", "high"], ["medium"])).toEqual([
      "low",
      "high",
    ])
  })

  /**
   * The vocabulary without the composed resolver is what produced every
   * ladder bug in the first plugin to use it. Which tiers to OFFER needs the
   * runtime lane, the app-level model/provider defaults, the reasoning gate and
   * the hidden-tier preference, none of which a session row carries.
   */
  it("publishes the composed effort surface, not just the vocabulary to rebuild it", () => {
    expect(rootBarrel.resolveEffortSurface).toBeInstanceOf(Function)

    // The pure half answers from values alone, so a plugin can reason about a
    // hypothetical surface without touching a store.
    const external = rootBarrel.resolveEffortSurface({ runtime: "external" })
    expect(external.external).toBe(true)
    expect(external.levels).not.toContain("ultracode")
  })

  /**
   * The half that READS the host's stores stays off the root. Publishing it
   * here would mean importing any type from this barrel pulls the settings and
   * agent-runtime stores, both of which construct a store at module scope, into
   * every plugin's module graph.
   */
  it("keeps the store-reading half of the effort surface on its own subpath", async () => {
    expect(rootBarrel).not.toHaveProperty("effortSurfaceForSession")
    expect(rootBarrel).not.toHaveProperty("subscribeEffortSurface")

    const subpath = await import("./api/effort-surface")
    expect(subpath.effortSurfaceForSession).toBeInstanceOf(Function)
    // The snapshot alone is the trap: three of the four inputs never touch the
    // session row, so a plugin needs the wake-up shipped beside it.
    expect(subpath.subscribeEffortSurface).toBeInstanceOf(Function)
  })

  it("does not publish registry-backed host functions from the package root", () => {
    const registryExports = [
      "registerBalanceAdapter",
      "unregisterBalanceAdaptersByPlugin",
      "listBalanceAdapterEntries",
      "registerLimitsSource",
      "unregisterLimitsSourcesByPlugin",
      "listLimitsSourceEntries",
      "registerProviderOperationAdapter",
      "unregisterProviderOperationAdaptersByPlugin",
      "listProviderOperationAdapterEntries",
      "registerImRateSource",
      "unregisterImRateSourcesByPlugin",
      "listImRateSourceEntries",
      "registerCompactionStrategy",
      "unregisterCompactionStrategiesByPlugin",
      "listCompactionStrategyEntries",
      "registerSharedMemoryAdapter",
      "unregisterSharedMemoryAdaptersByPlugin",
      "listSharedMemoryAdapterEntries",
      "registerQuickAction",
      "listQuickActions",
      "dispatchUri",
      "registerUriHandler",
      "registerAuthenticationProvider",
      "getSession",
      "registerMessagePartRenderer",
      "listMessagePartRenderers",
      "registerViewContainer",
      "getViewContainerSnapshot",
      "registerView",
      "listViewsForContainer",
      "registerWebview",
      "postMessageToWebview",
      "registerRoutingStrategy",
      "listRoutingStrategies",
      "registerDeploymentFilter",
      "listDeploymentFilters",
      "registerProtocolAdapter",
      "listProtocolAdapters",
      "registerToolRoutesForPlugin",
      "makeToolRouteId",
      "registerTerminalCompletionProvider",
      "listTerminalCompletionProviders",
      "getTerminalCompletions",
      "registerTerminalCompletionProvidersForPlugin",
      "registerPluginCommandRules",
      "getPluginCommandRulesets",
      "classifyCommandSafety",
      "registerWorkspaceBackendsForPlugin",
      "registerWorkspaceBackend",
      "createWorkspaceAPI",
      "registerModalMountsForPlugin",
      "registerDeclaredModal",
      "createModalAPI",
      "registerTrayItem",
      "listTrayItems",
      "createTrayAPI",
      "registerPluginTheme",
      "listPluginThemes",
      "registerThemePack",
      "listThemePacks",
      "applyPluginFonts",
      "listFonts",
      "applyPluginWallpapers",
      "listPluginWallpapers",
      "registerDensityPreset",
      "applyDensityPresetVars",
      "registerAiProvidersForPlugin",
      "unregisterAiProvidersForPlugin",
      "createAIProviderAPI",
      "getCustomAIProviders",
      "registerOcrProvidersForPlugin",
      "unregisterOcrProvidersForPlugin",
      "createOcrAPI",
      "clearOcrProvidersForPlugin",
      "registerOcrProvider",
      "createOcrRegistry",
      "registerPetAchievement",
      "unregisterPetAchievementById",
      "unregisterPetAchievementsByPlugin",
      "listPetAchievementEntries",
      "buildPluginAchievementId",
      "compilePluginAchievement",
      "listCompiledPluginAchievements",
      "getPluginAchievementDisplay",
      "registerPetItem",
      "unregisterPetItemById",
      "unregisterPetItemsByPlugin",
      "listPetItemEntries",
      "buildPluginItemId",
      "projectPluginItem",
      "listProjectedPluginItems",
      "getProjectedPluginItem",
      "getPluginItemDisplay",
      "registerNodeExecutor",
      "unregisterNodeExecutor",
      "getExecutor",
      "listRegisteredKinds",
      "subscribeNodeRegistry",
      "registerPluginTrigger",
      "unregisterPluginTrigger",
      "getPluginTrigger",
      "listPluginTriggers",
      "startPluginTriggerInstance",
      "subscribePluginTriggerRegistry",
      "setTriggerMuted",
      "isTriggerMuted",
      "subscribeTriggerMuteChanges",
      "createExportAPI",
      "clearCustomExporters",
      "createImportAPI",
      "clearCustomImporters",
      "registerChatMiddlewaresForPlugin",
      "unregisterChatMiddlewaresForPlugin",
      "createChatAPI",
      "clearChatMiddlewaresForPluginContext",
      "registerChatMiddleware",
      "unregisterChatMiddleware",
      "clearChatMiddlewaresForPlugin",
      "listActiveChatMiddlewares",
      "listAllChatMiddlewares",
      "getChatMiddleware",
      "recordMiddlewareFailure",
      "recordMiddlewareSuccess",
      "resetChatMiddlewareBreaker",
      "subscribeChatMiddlewareRegistry",
      "executeCliTool",
      "registerCommand",
      "unregisterCommand",
      "unregisterCommandsByPlugin",
      "getCommand",
      "getCommands",
      "listCommandsByPlugin",
      "executeCommand",
      "subscribeCommandRegistry",
      "registerExternalAgentAdaptersForPlugin",
      "unregisterExternalAgentAdaptersForPlugin",
      "registerPluginProtocolAdapter",
      "unregisterPluginProtocolAdaptersByPlugin",
      "getPluginProtocolAdapterOwner",
      "getPluginProtocolAdapterProtocols",
      "listPluginProtocolAdapters",
      "onProtocolAdapterRegistryChange",
      "registerExternalAgentPreset",
      "unregisterExternalAgentPreset",
      "unregisterExternalAgentPresetsByPlugin",
      "getDynamicExternalAgentPresetEntry",
      "listDynamicExternalAgentPresetEntries",
      "listExternalAgentPresetIds",
      "getExternalAgentPresetConfig",
      "createAgentFromPreset",
      "isFromPreset",
      "configureLspRegistry",
      "registerLspServer",
      "unregisterLspServer",
      "unregisterByOwner",
      "listLspServers",
      "getLspServerForLanguage",
      "registerPluginLspServers",
      "lspServerKey",
      "getAgentMode",
      "getAgentModeByType",
      "toTaskTrigger",
      "registerScheduledTasksForPlugin",
      "unregisterScheduledTasksForPlugin",
      "registerScheduledTaskDefsForPlugin",
      "unregisterScheduledTaskDefsByPlugin",
      "listScheduledTaskDefs",
      "subscribeScheduledTaskDefs",
      "registerPluginTaskHandler",
      "unregisterPluginTaskHandler",
      "getPluginTaskHandler",
      "hasPluginTaskHandler",
      "getPluginTaskHandlerNames",
      "clearPluginTaskHandlers",
    ]

    for (const registryExport of registryExports) {
      expect(rootBarrel[registryExport]).toBeUndefined()
    }
  })

  it("exposes the author manifest contract", () => {
    const assertSdkTypes = <_T extends PluginManifest>(): void => undefined

    expect(assertSdkTypes).toBeDefined()
  })
})
