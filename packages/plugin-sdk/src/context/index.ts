/**
 * Plugin SDK — `context` subpath.
 *
 * Re-exports `PluginContext` / `FullPluginContext` plus every per-field API
 * interface a plugin receives during `activate(ctx)`. Source of truth is
 * `types/plugin/plugin.ts` (core APIs), `types/plugin/plugin.ts`
 * (extended context APIs available through the runtime extension surface), and
 * `lib/plugin/core/context.ts` (the full host-mounted context).
 *
 * Partitioning rules — see `../manifest/index.ts`. This module owns:
 *  - `PluginContext` / `FullPluginContext`
 *  - Every `PluginXxxAPI` interface plus its companion option/result types
 *  - The extended-context API (`PluginContextAPI`)
 */

import type { PluginContext as CtxPluginContext } from "@/types/plugin/plugin"
import type { PluginContextAPI as CtxPluginContextAPI } from "@/types/plugin/plugin"
import type { PluginOcrAPI as CtxPluginOcrAPI } from "@/lib/plugin/api/ocr-api"
import type { PluginWorkspaceAPI as CtxPluginWorkspaceAPI } from "@/lib/plugin/api/workspace-api"
import type { PluginModalAPI as CtxPluginModalAPI } from "@/lib/plugin/api/modal-api"
import type { PluginChatAPI as CtxPluginChatAPI } from "@/lib/plugin/api/chat-api"
import type { PluginCapabilitiesAPI as CtxPluginCapabilitiesAPI } from "@/lib/plugin/api/capabilities-api"
import type { PluginConnectorsAPI as CtxPluginConnectorsAPI } from "@/lib/plugin/api/connectors-api"
import type { PluginGitAPI as CtxPluginGitAPI } from "@/lib/plugin/api/git-api"
import type { PluginGoalAPI as CtxPluginGoalAPI } from "@/lib/plugin/api/goal-api"
import type { PluginSubscriptionAPI as CtxPluginSubscriptionAPI } from "@/lib/plugin/api/subscription-api"
import type { PluginTerminalAPI as CtxPluginTerminalAPI } from "@/lib/plugin/api/terminal-api"
import type { PluginPerfAPI as CtxPluginPerfAPI } from "@/lib/plugin/api/perf-api"
import type { PluginShareAPI as CtxPluginShareAPI } from "@/lib/plugin/api/share-api"
import type { PluginBackupAPI as CtxPluginBackupAPI } from "@/lib/plugin/api/backup-api"
import type { PluginAutomationAPI as CtxPluginAutomationAPI } from "@/lib/plugin/api/automation-api"
import type { PluginCompanionAPI as CtxPluginCompanionAPI } from "@/lib/plugin/api/companion-api"

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
  PluginQuickActionsAPI,
  PluginQuickActionInput,
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
  PluginSecretsBackend,
  PluginWorkflowAPI,
  PluginDexieAPI,
} from "@/types/plugin/plugin"

// =============================================================================
// Agent runtime companion types referenced by PluginAgentAPI.
// =============================================================================
export type {
  PluginAgentRun,
  PluginAgentRunOptions,
  PluginAgentRunResult,
  PluginDispatchSubagentOptions,
  PluginSubagentDispatchResult,
  PluginRunTeamOptions,
  PluginRunTeamResult,
} from "@/types/plugin/plugin-agent-sdk"
export type { PluginAgentGuardrailsAPI } from "@/types/plugin/plugin-agent-guardrails"
export type {
  PluginAgentSessionsAPI,
  PluginCreateSessionOptions,
} from "@/types/plugin/plugin-agent-session"
export type {
  PluginAgentContextAPI,
  PluginContextProvider,
  PluginSharedMemoryReadOptions,
  PluginTwinMemoryQueryOptions,
} from "@/types/plugin/plugin-context-provider"

// =============================================================================
// Optional runtime APIs mounted on PluginContext by feature-specific host
// modules. These are part of the public ctx surface even though their owning
// implementations live under lib/plugin/api.
// =============================================================================
export type { PluginOcrAPI } from "@/lib/plugin/api/ocr-api"
export type { PluginWorkspaceAPI } from "@/lib/plugin/api/workspace-api"
export type { PluginModalAPI } from "@/lib/plugin/api/modal-api"
export type { CreateWebviewInput, PluginWebviewAPI } from "@/lib/plugin/api/webview-api"
export type {
  CreateAuthAPIOptions,
  PluginAuthAPI,
  PluginAuthProvider,
} from "@/lib/plugin/api/auth-api"
export type { PluginUriAPI, PluginUriHandlerDef } from "@/lib/plugin/api/uri-api"
export type { PluginChatAPI } from "@/lib/plugin/api/chat-api"
export type { PluginCapabilitiesAPI } from "@/lib/plugin/api/capabilities-api"
export type {
  PluginMediaAPI,
  ImageProcessingOptions,
  ImageFilterDefinition,
  FilterParameterDefinition,
  ImageTransformOptions,
  ImageAdjustmentOptions,
  VideoClip,
  VideoTransition,
  VideoEffectDefinition,
  VideoTransitionDefinition,
  VideoExportOptions,
  ExportProgress,
  MediaProcessingResult,
} from "@/lib/plugin/api/media-api"
export type {
  PluginConnectorsAPI,
  PluginConnectorAdapterInfo,
  PluginConnectorAdapterSupport,
  PluginAdapterInstanceInfo,
  PluginAdapterInstancePatch,
  PluginAdapterInstanceInput,
  PluginConnectorsA2UIBuilder,
} from "@/lib/plugin/api/connectors-api"
export type {
  PluginGitAPI,
  PluginGitCommitOptions,
  PluginGitCreateBranchOptions,
  PluginGitPullOptions,
  PluginGitPushOptions,
  PluginGitStashPushOptions,
  PluginGitConflictResolution,
} from "@/lib/plugin/api/git-api"
export type { PluginGoalAPI, PluginGoalCreateInput } from "@/lib/plugin/api/goal-api"
export type { PluginSubscriptionAPI, PluginUsageSnapshot } from "@/lib/plugin/api/subscription-api"
export type {
  PluginTerminalAPI,
  PluginCommandRule,
  PluginCommandClassification,
  PluginTerminalSpawnOptions,
  PluginTerminalInfo,
  PluginTerminalCommandRecord,
  PluginRunScriptOptions,
} from "@/lib/plugin/api/terminal-api"
export type { PluginPerfAPI } from "@/lib/plugin/api/perf-api"
export type { PluginShareAPI } from "@/lib/plugin/api/share-api"
export type {
  PluginBackupAPI,
  PluginBackupCreateOptions,
  PluginBackupRestoreOptions,
} from "@/lib/plugin/api/backup-api"
export type { PluginAutomationAPI } from "@/lib/plugin/api/automation-api"
export type { PluginCompanionAPI, CompanionServerStatus } from "@/lib/plugin/api/companion-api"
export type { PluginMessagePartAPI } from "@/lib/plugin/api/message-part-api"

export type FullPluginContext = Omit<CtxPluginContext, "storage"> &
  Omit<CtxPluginContextAPI, "storage"> & {
    storage: CtxPluginContextAPI["storage"]
    ocr: CtxPluginOcrAPI
    workspace: CtxPluginWorkspaceAPI
    modal: CtxPluginModalAPI
    chat: CtxPluginChatAPI
    capabilities: CtxPluginCapabilitiesAPI
    git: CtxPluginGitAPI
    goals: CtxPluginGoalAPI
    subscription: CtxPluginSubscriptionAPI
    terminal: CtxPluginTerminalAPI
    perf: CtxPluginPerfAPI
    connectors: CtxPluginConnectorsAPI
    share: CtxPluginShareAPI
    backup: CtxPluginBackupAPI
    automation: CtxPluginAutomationAPI
    companion: CtxPluginCompanionAPI
  }

// =============================================================================
// Scheduler runtime API (separate file for the manifest types; this is the
// runtime-side façade plugins call via `ctx.scheduler`).
// =============================================================================
export type { PluginSchedulerAPI } from "@/types/plugin/plugin-scheduler"

// =============================================================================
// Extended-context APIs (from types/plugin/plugin.ts).
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
  PluginImportAPI,
  ImportSource,
  ImportResult,
  CustomImporter,
  PluginConfigAPI,
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
} from "@/types/plugin/plugin"
