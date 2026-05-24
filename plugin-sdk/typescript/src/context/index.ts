/**
 * Plugin SDK — `context` subpath.
 *
 * Re-exports `PluginContext` plus every per-field API interface a plugin
 * receives during `activate(ctx)`. Source of truth is `types/plugin/plugin.ts`
 * (core APIs) and `types/plugin/plugin-extended.ts` (extended context APIs
 * available through the runtime extension surface).
 *
 * Partitioning rules — see `../manifest/index.ts`. This module owns:
 *  - `PluginContext` itself
 *  - Every `PluginXxxAPI` interface plus its companion option/result types
 *  - The extended-context API (`PluginContextAPI`)
 */

// =============================================================================
// Core PluginContext + per-field APIs (from types/plugin/plugin.ts)
// =============================================================================
export type {
  PluginContext,
  PluginLogger,
  PluginStorage,
  PluginEventEmitter,
  PluginUIAPI,
  PluginNotification,
  PluginDialog,
  PluginInputDialog,
  PluginConfirmDialog,
  PluginStatusBarItem,
  PluginSidebarPanel,
  PluginA2UIAPI,
  PluginAgentAPI,
  PluginSettingsAPI,
  PluginPythonAPI,
  PluginPythonModule,
  PluginNetworkAPI,
  NetworkRequestOptions,
  NetworkResponse,
  DownloadOptions,
  DownloadProgress,
  DownloadResult,
  UploadOptions,
  PluginFileSystemAPI,
  FileEntry,
  FileStat,
  FileWatchEvent,
  PluginClipboardAPI,
  PluginShellAPI,
  ShellOptions,
  ShellResult,
  SpawnOptions,
  ChildProcess,
  PluginDatabaseAPI,
  DatabaseResult,
  DatabaseTransaction,
  TableSchema,
  TableColumn,
  TableIndex,
  PluginShortcutsAPI,
  ShortcutOptions,
  ShortcutRegistration,
  PluginTrayItemInput,
  PluginTrayAPI,
  PluginContextMenuAPI,
  ContextMenuItem,
  ContextMenuContext,
  ContextMenuClickContext,
  PluginWindowAPI,
  WindowOptions,
  PluginWindow,
  PluginSecretsAPI,
  PluginWorkflowAPI,
  PluginDexieAPI,
} from "@/types/plugin/plugin"

// =============================================================================
// Scheduler runtime API (separate file for the manifest types; this is the
// runtime-side façade plugins call via `ctx.scheduler`).
// =============================================================================
export type { PluginSchedulerAPI } from "@/types/plugin/plugin-scheduler"

// =============================================================================
// Extended-context APIs (from types/plugin/plugin-extended.ts).
// These are surfaced through the extended context wrapper; plugin authors
// see them as additional fields on the context object when the host exposes
// the extended surface.
// =============================================================================
export type {
  PluginSessionAPI,
  SessionFilter,
  MessageQueryOptions,
  SendMessageOptions,
  MessageAttachment,
  SessionStats,
  PluginProjectAPI,
  ProjectFilter,
  ProjectFileInput,
  PluginVectorAPI,
  VectorDocument,
  VectorSearchOptions,
  VectorFilter,
  VectorSearchResult,
  CollectionOptions,
  CollectionStats,
  PluginThemeAPI,
  ThemeMode,
  ColorThemePreset,
  ThemeColors,
  CustomTheme,
  ThemeState,
  PluginExportAPI,
  ExportFormat,
  ExportOptions,
  CustomExporter,
  ExportData,
  ExportResult,
  PluginI18nAPI,
  Locale,
  TranslationParams,
  PluginCanvasAPI,
  PluginCanvasDocument,
  CreateCanvasDocumentOptions,
  CanvasSelection,
  PluginArtifactAPI,
  CreateArtifactOptions,
  ArtifactFilter,
  ArtifactRenderer,
  PluginNotificationCenterAPI,
  NotificationOptions,
  NotificationAction,
  Notification,
  PluginStorageAPI,
  PluginAIProviderAPI,
  AIChatMessage,
  AIChatOptions,
  AIChatChunk,
  AIModel,
  AIProviderDefinition,
  PluginExtensionAPI,
  PluginPermissionAPI,
  PluginContextAPI,
} from "@/types/plugin/plugin-extended"
