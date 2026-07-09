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
  type PluginI18nLoaderAPI,
} from "./i18n-loader"

export {
  PLUGIN_TEMPLATES,
  scaffoldPlugin,
  scaffoldPluginChecked,
  getTemplateById,
  getTemplatesByType,
  getTemplatesByCapability,
  searchTemplates,
  type PluginTemplate,
  type PluginScaffoldOptions,
  type ScaffoldResult,
} from "./templates"

export {
  healthcheckScaffold,
  type ScaffoldHealthIssue,
  type ScaffoldHealthReport,
} from "./scaffold-healthcheck"
