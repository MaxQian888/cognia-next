/**
 * Plugin Utils - Utility exports
 */

export {
  pluginAnalyticsStore,
  pluginLearningEngine,
  pluginHealthMonitor,
  initializeAnalytics,
  trackPluginEvent,
  getPluginInsights,
  getPluginHealth,
  getPluginRecommendations,
  type PluginUsageEvent,
  type PluginUsageStats,
  type LearningInsight,
  type PluginHealthStatus,
  type PluginRecommendation,
} from "./analytics"

export {
  PluginI18nLoader,
  getPluginI18nLoader,
  resetPluginI18nLoader,
  type PluginLocale,
  type I18nConfig,
  type TranslationOptions,
  type PluginI18nAPI,
} from "./i18n-loader"

export {
  PLUGIN_TEMPLATES,
  scaffoldPlugin,
  getTemplateById,
  getTemplatesByType,
  getTemplatesByCapability,
  searchTemplates,
  type PluginTemplate,
  type PluginScaffoldOptions,
} from "./templates"
