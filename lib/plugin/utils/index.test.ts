import * as utils from "./index"

describe("lib/plugin/utils re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "pluginAnalyticsStore",
      "pluginLearningEngine",
      "pluginHealthMonitor",
      "initializeAnalytics",
      "trackPluginEvent",
      "getPluginInsights",
      "getPluginHealth",
      "getPluginRecommendations",
      "PluginI18nLoader",
      "getPluginI18nLoader",
      "resetPluginI18nLoader",
      "PLUGIN_TEMPLATES",
      "scaffoldPlugin",
      "getTemplateById",
      "getTemplatesByType",
      "getTemplatesByCapability",
      "searchTemplates",
    ] as const

    for (const name of expected) {
      expect(utils).toHaveProperty(name)
      expect((utils as Record<string, unknown>)[name]).toBeDefined()
    }
  })
})
