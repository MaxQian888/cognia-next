import type {
  PluginContext,
  PluginLogger,
  PluginAgentAPI,
  PluginDexieAPI,
  PluginSessionAPI,
  PluginI18nAPI,
  PluginNotificationCenterAPI,
} from "./index"

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
    expect(dexieField).toBeUndefined()
    expect(session).toBeUndefined()
    expect(i18n).toBeUndefined()
    expect(notifications).toBeUndefined()
  })
})
