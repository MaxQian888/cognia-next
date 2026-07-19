/**
 * A2UI Library
 * Agent to UI protocol implementation for Cognia
 */

// Parser
export {
  parseA2UIMessage,
  parseA2UIMessages,
  parseA2UIInput,
  parseA2UIString,
  parseA2UIJsonl,
  detectA2UIContent,
  extractA2UIFromResponse,
  createA2UISurface,
  isCreateSurfaceMessage,
  isUpdateComponentsMessage,
  isUpdateDataModelMessage,
  isDeleteSurfaceMessage,
  isSurfaceReadyMessage,
  type A2UIParseResult,
  type A2UIUnifiedParseResult,
  type A2UIParseInputOptions,
} from "./parser"

// Data Model
export {
  parseJsonPointer,
  createJsonPointer,
  encodeJsonPointerSegment,
  getValueByPath,
  setValueByPath,
  deleteValueByPath,
  isA2UIDataModel,
  isSafeDataModelKey,
  deepClone,
  deepMerge,
  isPathValue,
  resolveStringOrPath,
  resolveNumberOrPath,
  resolveBooleanOrPath,
  resolveArrayOrPath,
  getBindingPath,
  createRelativePathResolver,
  watchPaths,
  extractReferencedPaths,
  resolveComputedFields,
  computedHelpers,
  type PathWatcher,
  type ComputedField,
  type ComputedFieldRegistry,
} from "./data-model"

// Portable app import validation
export {
  A2UI_APP_EXPORT_VERSION,
  A2UI_MAX_IMPORT_BYTES,
  A2UI_MAX_BACKUP_APPS,
  A2UI_MAX_COMPONENTS_PER_APP,
  parseA2UIAppImport,
  parseA2UIBackupImport,
  type A2UIImportErrorCode,
  type A2UIImportError,
  type A2UIImportResult,
  type A2UIImportedAuthor,
  type A2UIImportedStats,
  type A2UIImportedMetadata,
  type A2UIImportedApp,
  type A2UIImportedBackup,
} from "./app-import"

// Component Catalog
export {
  DEFAULT_CATALOG_ID,
  registerComponent,
  registerComponents,
  getComponent,
  hasComponent,
  getRegisteredTypes,
  getRegisteredCatalogIds,
  createCatalog,
  registerCatalog,
  getCatalog,
  unregisterComponent,
  clearRegistry,
  getStandardComponentTypes,
  componentCategories,
  getComponentCategory,
  resolveWidgetDefaults,
  resolveWidgetMetadata,
  validateComponent,
  FALLBACK_COMPONENT_TYPE,
} from "./catalog"

export {
  DEFAULT_A2UI_PERSISTENCE_LIMIT,
  MIN_A2UI_PERSISTENCE_LIMIT,
  MAX_A2UI_PERSISTENCE_LIMIT,
  getA2UIPersistenceLimit,
  resolveA2UICatalogId,
  getA2UIWidgetSettingDefaults,
} from "./runtime-settings"
export type { A2UIRuntimeSettings } from "./runtime-settings"

// Events
export {
  A2UIEventEmitter,
  globalEventEmitter,
  createUserAction,
  createDataModelChange,
  ActionTypes,
  getComponentAction,
  buildActionData,
  formatActionForAI,
  formatDataChangeForAI,
  batchEventsForAI,
  collectFormData,
  validateFormData,
  type A2UIActionHandler,
  type A2UIDataChangeHandler,
  type ValidationResult,
} from "./events"

// App Templates
export {
  appTemplates,
  getTemplateById,
  getTemplatesByCategory,
  searchTemplates,
  getLocalizedTemplates,
  getLocalizedTemplateById,
  getLocalizedTemplatesByCategory,
  searchLocalizedTemplates,
  localizeTemplate,
  formatBuiltInRuntimeMessage,
  createAppFromTemplate,
  generateTemplateId,
  templateCategories,
  todoListTemplate,
  calculatorTemplate,
  surveyFormTemplate,
  dataDashboardTemplate,
  timerTemplate,
  notesTemplate,
  weatherTemplate,
  contactFormTemplate,
  unitConverterTemplate,
  habitTrackerTemplate,
  shoppingListTemplate,
  expenseTrackerTemplate,
  profileCardTemplate,
  type A2UIAppTemplate,
} from "./templates"

// App Generator (AI-powered app generation)
export {
  generateAppFromDescription,
  generateUnitConverterApp,
  generateWeatherApp,
  detectAppType,
  extractAppName,
  appPatterns,
  getLocalizedTexts,
  getStyleConfig,
  type AppGenerationRequest,
  type GeneratedApp,
} from "./app-generator"

// Thumbnail Generation
export {
  generateThumbnail,
  captureSurfaceThumbnail,
  generatePlaceholderThumbnail,
  saveThumbnail,
  getThumbnail,
  deleteThumbnail,
  isThumbnailStale,
  getAllThumbnails,
  clearAllThumbnails,
  syncThumbnailsWithApps,
  type ThumbnailOptions,
  type ThumbnailResult,
} from "./thumbnail"

// Date formatting utilities
export { formatRelativeTime, formatAbsoluteTime } from "./format"

// Animation utilities
export { ANIMATION_VARIANTS, getAnimationVariants, getTransitionConfig } from "./animation"

// Chart constants
export { DEFAULT_CHART_COLORS, CHART_TOOLTIP_STYLE } from "./chart-constants"

// Shared constants
export {
  CATEGORY_KEYS,
  CATEGORY_I18N_MAP,
  surfaceStyles,
  contentStyles,
  ANALYSIS_TYPE_ICONS,
  ANALYSIS_TYPE_I18N_KEYS,
  ANALYSIS_TYPE_VALUES,
} from "./constants"

// List utilities
export { getItemKey, getItemDisplayText } from "./list-utils"

// Academic Templates
export {
  academicTemplates,
  createPaperCardSurface,
  createSearchResultsSurface,
  createAnalysisPanelSurface,
  createPaperComparisonSurface,
  createReadingListSurface,
  type AcademicTemplateType,
} from "./academic-templates"

// Rich output profiles
export {
  RICH_OUTPUT_PROFILES,
  listRichOutputProfiles,
  getRichOutputProfile,
  routeRichOutputProfile,
  type RichOutputRequestCategory,
  type RichOutputType,
  type RichOutputTechnology,
  type RichOutputHostStrategy,
  type RichOutputRolloutTier,
  type RichOutputProfile,
  type RichOutputFeatureFlags,
  type RichOutputRoutingOptions,
  type RichOutputRoutingReason,
  type RichOutputRoutingResult,
} from "./output-profiles"

export {
  richOutputFixtures,
  getRichOutputFixture,
  type RichOutputFixture,
  type RichOutputFixtureKey,
} from "./rich-output-fixtures"
