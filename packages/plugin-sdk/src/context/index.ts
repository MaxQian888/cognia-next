/**
 * Plugin SDK — `context` subpath.
 *
 * Re-exports `PluginContext` / `FullPluginContext` plus every per-field API
 * interface a plugin receives during `activate(ctx)`. Source of truth is
 * `types/plugin/plugin.ts` (core APIs), `types/plugin/plugin.ts`
 * (additional callable APIs available through the runtime surface), and
 * `lib/plugin/core/context.ts` (the full host-mounted context).
 *
 * Partitioning rules — see `../manifest/index.ts`. This module owns:
 *  - `PluginContext` / `FullPluginContext`
 *  - Every `PluginXxxAPI` interface plus its companion option/result types
 *  - The complete callable API (`PluginContextAPI`)
 */

import type { PluginContext as CtxPluginContext } from "@/types/plugin/plugin"

// =============================================================================
// Core PluginContext + per-field APIs (from types/plugin/plugin.ts)
// =============================================================================
export type {
  PluginContext,
  PluginLifecycleAPI,
  PluginLifecycleScopeToken,
  PluginChildLifecycleAPI,
  PluginServicesAPI,
  PluginServiceProviderMetadata,
  PluginOptionalServiceChange,
  PluginOptionalServiceListener,
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
  PluginNetworkHttpMethod,
  NetworkDataClassification,
  NetworkEgressPolicyOptions,
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
// Additional runtime APIs mounted on PluginContext by feature-specific host
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
  NativeVideoInfo,
  VideoAnalysisFrame,
  VideoAnalysisManifest,
  VideoAnalysisMode,
  VideoAnalysisOptions,
} from "@/lib/plugin/api/media-api"
export type {
  PluginConnectorsAPI,
  PluginConnectorAdapterInfo,
  PluginConnectorAdapterSupport,
  PluginAdapterInstanceInfo,
  PluginAdapterInstancePatch,
  PluginAdapterInstanceInput,
  PluginConnectorsA2UIBuilder,
  PluginBoundSessionInfo,
  PluginOutboundJobInfo,
  SiblingConversation,
  DispatchRuleHit,
  AtGateDecision,
  BootstrapConversationInput,
  BootstrapConversationResult,
} from "@/lib/plugin/api/connectors-api"
export type { PluginIntegrationsAPI } from "@/types/plugin/plugin-integration"
export type {
  PluginTeamAPI,
  PluginTeamTaskCreateInput,
  PluginTeamTaskPatch,
  PluginTeamTeammateCreateInput,
  PluginTeamTeammatePatch,
  PluginTeamMoveResult,
  PluginTeamRunStatus,
} from "@/lib/plugin/api/team-api"
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
export type {
  PluginMemoryAPI,
  PluginMemoryListFilter,
  PluginMemorySearchOptions,
  PluginMemoryStoreInput,
} from "@/lib/plugin/api/memory-api"
export type {
  PluginPetAPI,
  PluginPetEvent,
  PluginPetInteractionKind,
  PluginPetSummary,
} from "@/lib/plugin/api/pet-api"
export type { PluginMessagePartAPI } from "@/lib/plugin/api/message-part-api"
export type {
  PluginContextPanelAPI,
  PluginContextPanelRegistration,
  PluginContextWorkbenchState,
} from "@/lib/plugin/api/context-panel-api"
export type { PluginTemplatesAPI } from "../templates"

/** @deprecated `PluginContext` is now the complete activated context. */
export type FullPluginContext = CtxPluginContext

// =============================================================================
// Scheduler runtime API (separate file for the manifest types; this is the
// runtime-side façade plugins call via `ctx.scheduler`).
// =============================================================================
export type { PluginSchedulerAPI } from "@/types/plugin/plugin-scheduler"

// =============================================================================
// Additional callable APIs (from types/plugin/plugin.ts). These are merged
// directly into the one public context contract.
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
