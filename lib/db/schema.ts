// IndexedDB schema (via Dexie) for cognia-next — the single `CogniaDB`
// instance backing chat, plugins, connectors, workflows, twin, and more.
//
// The schema is declared as ONE current version (`CURRENT_SCHEMA` below), not
// as an append-only chain of historical deltas. Dexie parses index specs
// eagerly and `Version.stores()` re-walks every version declared so far, so a
// 200-block chain cost ~4.7s of pure index parsing per fresh connection.
//
// HARD RULE: a database whose `storageLayout` marker does not match is NOT
// upgraded in place — `lib/db/boot.ts` refuses it and routes the user to an
// explicit reset. Never edit `CURRENT_SCHEMA` without bumping
// `CURRENT_SCHEMA_VERSION`: IndexedDB runs an upgrade only when the version
// increases, so an un-bumped edit is silently ignored on every existing
// database. See `lib/db/CONVENTIONS.md` for the data layer's ID / timestamp /
// error-handling / type-location conventions.
//
// Row types co-locate with their CRUD module (or a `*-types.ts` file) and are
// re-exported below so `@/lib/db/schema` stays the stable import surface.

import Dexie, { type Table } from "dexie"
import type {
  AppSettings,
  Character,
  ChatSession,
  McpCapabilityCacheRow,
  McpServer,
  McpServerSummary,
  McpSyncJob,
  SessionFolder,
  Skill,
  SkillResource,
  StoredMessage,
  SystemPromptPreset,
  Team,
} from "@cognia/agent-config-types"
import type { Project } from "@/types"
import type { ProjectChunk } from "@/types/project-knowledge"
import type {
  RetrievalActivePointerRow,
  RetrievalEncryptedContentRow,
  RetrievalGenerationRow,
  RetrievalJobRow,
  RetrievalMigrationJournalRow,
  RetrievalProfileRow,
  RetrievalRuntimeStateRow,
  RetrievalTombstoneRow,
  RetrievalTraceRow,
} from "./retrieval-control-types"
import type {
  KnowledgeBase,
  KnowledgeBaseChunk,
  KnowledgeBaseIngestJob,
  KnowledgeBaseSource,
} from "@/types/knowledge-base"
import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"
import type { TrustedWorkspace } from "./trusted-workspaces"
import type {
  DeploymentProfile,
  ProviderProfile,
  TransportProfile,
} from "@cognia/provider-types/provider-profile"
import type {
  ProviderBalanceSnapshot,
  ProviderDiagnosticJob,
  ProviderDiagnosticSample,
  ProviderDiagnosticsRefreshState,
  ProviderEndpointChange,
} from "@cognia/provider-types/provider-diagnostics"
import type { ProfileStoreMetaRow } from "./provider-profiles"
import type { AgentCompatibilityRecordRow } from "./agent-compatibility"
import type { BackupHistoryRow } from "./backup-history"
import type {
  ExternalIdentity,
  Org,
  OrgMembership,
  User,
  WorkspaceMembership,
} from "@/types/identity"
import type { NotificationRecord } from "@/types/notifications"
import type { SandboxConnectionRow } from "./sandbox-connections"
import type {
  CanvasDocumentRow,
  CanvasVersionRow,
  CanvasCommentRow,
  CanvasSessionRow,
} from "./canvas-types"
import type { ArtifactRow, ArtifactVersionRow } from "./artifact-types"
import type { A2UIAppRow, A2UISurfaceRow, A2UITemplateRow, A2UIEventHistoryRow } from "./a2ui-types"
import { dispatchDbUpgradeBlocked } from "./upgrade-blocked-signal"
import { createDiagnostic } from "@cognia/diagnostics"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import type { Twin, TwinSource, TwinChunk, TwinProfile, TwinDraft, TwinJob } from "@/types/twin"
import type { MobileOutboundJobRow } from "./mobile-outbound-types"
import type {
  PluginRow,
  PluginPermissionRow,
  PluginReviewRow,
  PluginAnalyticsRow,
  PluginMarketplaceSourceRow,
  PluginDexieMeta,
} from "./plugin-types"
import type {
  WikiArticle,
  WikiSection,
  WikiManifest,
  McpAuditLogRow,
  WikiCorpus,
  WikiCorpusManifest,
  WikiBuildJob,
  WikiStagedArticle,
  WikiStagedSection,
} from "@/types/wiki"
import type {
  ProviderLimitsRow,
  SubscriptionBalanceRow,
  SubscriptionUsageRow,
} from "@/types/subscription"
import type {
  AdapterInstanceRow,
  PlatformIdentityRow,
  InboundLedgerRow,
  OutboundJobRow,
  ConversationOverrideRow,
  ConnectorAuditRow,
  ConnectorDraftRow,
  ConnectorAttachmentRow,
  ConnectorCleanupJobRow,
  ConnectorCallbackBindingRow,
  ConnectorHeartbeatRow,
  ConnectorConversationStateRow,
  ConnectorInboundJobRow,
  WorkflowFanoutSubscriptionRow,
  FeishuTenantRow,
  FeishuPrincipalRow,
  FeishuPrincipalBindRequestRow,
  LarkEntryContextRow,
  LarkChatSurfaceRow,
  LarkMessageImportRow,
  LarkWebSessionRow,
} from "./connector-types"
import type {
  ConversationLabelRow,
  ConversationAssignmentEventRow,
  CannedResponseRow,
} from "./crm-types"
import type { LabelRow } from "@/types/labels"
import type { Issue, IssueCounter, IssueEvent, IssueProject, IssueRun } from "@/types/issues"
import type { CollabIssueMirrorRow } from "./collab-issue-mirror-types"
import type { CollabWorkspaceMirrorRow } from "./collab-workspace-mirror-types"
import type { CollabPlanMirrorRow } from "./collab-plan-mirror-types"
import type { CollabRunMirrorRow } from "./collab-run-mirror-types"
import type {
  CollabChatApprovalMirrorRow,
  CollabChatAttachmentMirrorRow,
  CollabChatEventMirrorRow,
  CollabChatInviteMirrorRow,
  CollabChatMembershipMirrorRow,
  CollabChatSessionMirrorRow,
  CollabChatSyncStateRow,
} from "./collab-chat-mirror-types"
import type { BrowserSubmissionRow } from "./browser-submissions-types"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import type { GithubIssueMirrorRow } from "./github-issue-mirror-types"
import type {
  WorkflowRow,
  WorkflowRunRow,
  WorkflowRunEventRow,
  WorkflowTriggerRow,
} from "@/types/workflow/visual"
import type { WorkflowWaitEvent, WorkflowWaitpoint } from "@/types/workflow/waitpoint"
import type {
  WorkflowHumanInputFileRow,
  WorkflowHumanInputRequest,
  WorkflowHumanInputSubmissionRow,
} from "@/types/workflow/human-input"
import type { WorkflowApp, WorkflowAppRelease } from "@/types/workflow/app"
import type { WorkflowBatchJob, WorkflowBatchRow } from "@/types/workflow/batch"
import type { WorkflowKnowledgeArtifactRow } from "@/types/workflow/knowledge-pipeline"
import type {
  WorkflowConversation,
  WorkflowConversationMessage,
  WorkflowConversationReleaseEvent,
  WorkflowConversationSummary,
} from "@/types/workflow/conversation"
import type {
  WorkflowDeployment,
  WorkflowInvocation,
  WorkflowVersion,
} from "@/types/workflow/deployment"
import type { WorkflowFolder } from "@/types/workflow/folder"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { MobileStepReceiptRow } from "@/types/mobile/mobile-step-receipt"
import type { SessionUsageRow } from "./session-usage"
import type { ChatDraftRow } from "./chat-drafts"
import type { SessionAttachmentUploadRow } from "./session-attachment-uploads"
import type { CapabilityGrant, OpenApiImportRow, ServiceConnection } from "@/types/external-service"
import type { ChatInputHistoryRow } from "./chat-input-history"
import type { Goal, GoalEvent, GoalTemplate } from "@/types/goal"
import type { Loop, LoopEvent } from "@/types/loop"
import type { AgentPlan, PlanEvent } from "@/types/agent/plan"
import type { WebhookAuditEntry } from "@/types/webhooks"
import type { OcrResultRow } from "./ocr-results"
import type { PluginSkillUsageRow } from "./plugin-skill-usage"
import type { WorkflowProposalHistoryRow } from "@/lib/workflow/editor/proposal-history"
import type { InboxTelemetryEventRow } from "./inbox-telemetry-types"
import type { SyncCursorRow, SyncTombstoneRow, SyncableTable } from "@/lib/sync/types"
import type {
  HostStateActionRow,
  HostStateChannelRow,
  HostStateMetaRow,
} from "@/lib/sync/host-state-store"
import type {
  ExecutionContextBundleRow,
  WorkInputBatchRow,
  WorkSubmissionRow,
} from "./work-submissions"
import type { SharedLinkRow } from "./shared-links"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { PetModelRow, PetModelFileRow } from "./pet-models"
import type { TerminalHistoryRow } from "./terminal-history"
import type { ProviderCostDailyRow } from "./provider-cost-daily"
import type { UnattendedExecAuditRow } from "./terminal-audit"
import type { BehaviorEventRow } from "./behavior-event-types"
import type {
  IntegrationAccountRow,
  IntegrationActionJobRow,
  IntegrationAuditRow,
  IntegrationEventRow,
  IntegrationSubscriptionRow,
} from "./integration-types"
import type {
  ExecutionRun,
  ExecutionRunBinding,
  ExecutionRunInterrupt,
  RunEvent,
} from "@/types/execution/run"
// Row types relocated out of this file but still wired into the table
// declarations below and re-exported at the bottom for `@/lib/db/schema`
// import-site stability. See `lib/db/CONVENTIONS.md`.
import type { ModelsDevCatalogRow } from "./models-dev-catalog"
import type {
  ProviderCatalogAliasRow,
  ProviderCatalogModelRow,
  ProviderCatalogOfferingRow,
  ProviderCatalogProviderRow,
  ProviderCatalogRevisionRow,
  ProviderCatalogStateRow,
  ProviderConnectionInventoryRow,
} from "./provider-catalog"
import type { OpenRouterCatalogRow } from "./openrouter-catalog"
import type { SessionStateRow } from "./session-state"
import type { SkillRecordingRow } from "./skill-recordings"
import type { TrustedPublisherRow } from "./trusted-publishers"
import type { TtsProviderKeyRow } from "@cognia/tts/types"
import type {
  OpenVsxCacheRow,
  VscodeExtensionRuntimeRow,
} from "@/types/plugin/vscode-extension-cache"
import type { ApprovedBinaryRow } from "@/types/plugin/approved-binary"
import type { AutomationAuditLogRow } from "@/lib/automation/audit"
import type { WorkflowViewportBookmarkRow } from "@/lib/workflow/editor/viewport-bookmarks-db"
import type { EvalCase, EvalDataset } from "@/types/eval/eval"
import type { EvalRunRow } from "./eval-runs"
import type { TraceAnnotationRow } from "./trace-annotations"
import type { EvalDatasetVersion } from "@/types/eval/version"
import type { EvalRunCaseRow } from "./eval-run-cases"
import type {
  EvalAdjudicationRow,
  EvalAssetRow,
  EvalConfigurationApplyRow,
  EvalExperimentRow,
  EvalProjectRow,
  EvalRecommendationRow,
  EvalReviewBatchRow,
  EvalReviewVoteRow,
  EvalSampleRow,
  EvalScoreRow,
  EvalTaskRow,
} from "./eval-lab"
import type {
  EvalObservationRow,
  EvalOnlineBudgetRow,
  EvalOnlinePolicyRow,
  EvalOnlineQueueRow,
} from "./eval-online-types"
import type { CalibrationItemRow } from "./calibration-items"
import type { CalibrationRunRow } from "./calibration-runs"
import type { BackgroundTaskJournalRow } from "./background-tasks"
import type { ContextCommentRow } from "@/types/context-comment"
import type { WorkflowReview, WorkflowReviewSuggestion } from "@/types/workflow/review"
import type {
  WorkflowAnnotationSet,
  WorkflowAnnotationSetRevision,
  WorkflowFeedbackCandidate,
} from "@/types/workflow/quality"
import type { WorkflowAppApiKey } from "@/types/workflow/api-key"
import type { TeamPrObservationRow } from "./team-pr-observations"
import type { AgentTeamBoardRow } from "./agent-team-board"
import type {
  TemplateDefinitionRow,
  TemplateDeviceBindingRecord,
  TemplateInstanceRecord,
  TemplateMigrationJournalRecord,
  TemplatePackageRow,
} from "./template-platform"
import type { WasmGrantLedgerRow } from "./wasm-grant-ledger"
import type { RunRecordRow } from "./run-records"
import type {
  SiteArtifactRow,
  SiteBuildLogRow,
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"
import type { Memory } from "@/types/memory/memory"
import type { MemoryAuditEvent, MemoryEvidence, MemoryJob } from "@/types/memory/governance"
import type {
  PetProfile,
  PetActivityRow,
  PetCharacterBinding,
  PetAchievementRecord,
  PetConversationRow,
  PetInventoryRow,
} from "@/types/pet"
import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import { encryptedRuntimeTargetDatabaseName } from "@/lib/runtime/target-registry"
import { rootsFromLegacy } from "@/lib/workspace/roots"
import { isTauri } from "@/lib/platform/detect"
import { createEncryptedContentMiddleware } from "./encrypted-content-middleware"
import { activateAccountContentCipher } from "@/lib/accounts/content-cipher"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import type { ChatTemplateRow } from "./chat-templates"
import type {
  ExternalAgentConfigHeadRow,
  ExternalAgentConfigRevisionRow,
} from "@/types/agent/external-agent-config-store"

/**
 * Idempotently backfill `roots` on a project row from the legacy
 * rootDir/additionalDirs mirrors. Used by the v66 upgrade and unit-tested
 * directly (the upgrade only fires on a live version transition).
 */
export function backfillRootsForRow(row: Project): Project {
  if (row.roots) return row
  row.roots = rootsFromLegacy(row.rootDir, row.additionalDirs)
  return row
}

/** Mark pre-control-plane memory rows without fabricating evidence. */
export function backfillMemoryGovernanceV118(memory: Memory): Memory {
  memory.evidenceState ??= "legacy"
  memory.reviewStatus ??= "unreviewed"
  memory.contaminationState ??= "unknown"
  memory.sensitivity ??= "normal"
  return memory
}

/** v164 makes legacy uncertainty and procedural review state explicit. */
export function backfillMemoryGovernanceV164(memory: Memory): Memory {
  memory.confidence ??= null
  memory.expiresAt ??= null
  memory.staleness ??= "unknown"
  if (memory.evidenceState === "legacy" && memory.sensitivity === "normal") {
    memory.sensitivity = "unknown"
  } else {
    memory.sensitivity ??= "unknown"
  }
  if (memory.type === "procedural" && memory.reviewStatus !== "verified") {
    memory.reviewStatus = "pending_instruction"
  }
  return memory
}

/** Translate the v118 four-state job model without losing retry history. */
export function backfillMemoryJobV164(job: MemoryJob): MemoryJob {
  const legacyStatus = job.status as MemoryJob["status"] | "completed"
  if (legacyStatus === "completed") job.status = "succeeded"
  else if (legacyStatus === "queued" && job.retryCount > 0 && job.nextAttemptAt !== undefined) {
    job.status = "retry_wait"
  }
  job.attempt ??= job.retryCount + (job.startedAt === undefined ? 0 : 1)
  job.maxAttempts ??= 4
  if (job.status === "succeeded") job.resultCode ??= "legacy_completed"
  return job
}

export const LEGACY_COGNIA_DB_NAME = "cognia-claude"

/** Bump when CURRENT_SCHEMA changes. IndexedDB only runs an upgrade when this
 * number INCREASES, so editing CURRENT_SCHEMA without bumping leaves every
 * existing database on its old store set with no error of any kind. */
export const CURRENT_SCHEMA_VERSION = 215

/**
 * The complete current Dexie schema, declared as ONE version.
 *
 * This object is GENERATED, not hand-written: it is the exact cumulative
 * merge of the historical version chain that used to live in this file (200
 * `version(N).stores()` blocks, v1 through v212), produced by the same
 * `Object.assign` fold Dexie itself performs. Regenerate it rather than
 * editing a table by hand when a bulk change is needed.
 *
 * Two entries are deliberately `null`. That is Dexie's "drop this table"
 * spelling, and `_parseStoresSpec` skips them, so the store is absent from the
 * database exactly as it was after the historical delete. They must stay:
 * removing the key would be indistinguishable from never having declared the
 * table, which is fine for a fresh database but silently wrong for one that
 * still carries the old store.
 *
 * ADDING A TABLE: add the key here and bump CURRENT_SCHEMA_VERSION.
 * REMOVING A TABLE: set its value to `null` and bump. Never delete the key.
 */
export const CURRENT_SCHEMA: Record<string, string | null> = {
  // Must stay first: `lib/db/storage-layout.ts` refuses any database that
  // lacks this store, which is how a pre-collapse database is kept from being
  // opened and silently misread.
  storageLayout: "id",
  sessions:
    "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId, platformConversationKey, projectId, [projectId+updatedAt], [projectId+createdAt+id], surfaceBindingKey, squadId",
  messages:
    "id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id], projectId, [projectId+createdAt], turnKey, [sessionId+turnKey]",
  settings: "id",
  promptPresets: "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
  mcpServers: "id, name, enabled",
  characters: "id, name, updatedAt, isBuiltIn",
  skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
  teams: "id, name, updatedAt, isBuiltIn",
  sessionState: "sessionId, lastReadAt",
  trustedWorkspaces: "path, trustedAt",
  skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
  tts_provider_keys: "id",
  backupHistory: "id, completedAt, type, success",
  canvasDocuments:
    "id, title, language, type, updatedAt, createdAt, projectId, [projectId+updatedAt]",
  canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave, projectId",
  canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt, projectId",
  canvasSessions: "id, documentId, ownerId, createdAt, projectId",
  a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
  a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
  a2uiTemplates: "id, name, category, updatedAt, source",
  a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
  twinSources:
    "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status], [twinId+fingerprint]",
  twinChunks:
    "&id, twinId, sourceId, vectorDocId, generationId, [twinId+sourceId], [twinId+generationId], [twinId+createdAt]",
  twinProfile: "&id, twinId",
  twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
  twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
  plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
  pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
  pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
  pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
  pluginScheduledJobs: null,
  wikiArticles:
    "&id, slug, corpusId, scope, module, pageRank, generatedAt, [scope+module], &[corpusId+slug], [corpusId+module]",
  wikiSections: "&id, articleId, corpusId, [articleId+sectionIndex]",
  wikiManifest: "&scope, lastBuildAt",
  mcpAuditLog: "&id, ts, tool, allowed, [tool+ts]",
  adapterInstances: "id, type, enabled, displayName, [type+enabled], createdAt, updatedAt",
  platformIdentities:
    "&id, [platform+remoteUserId], [adapterId+remoteUserId], remoteUserId, platform, lastSeenAt",
  inboundLedger: "&id, [adapterId+namespace+platformMessageId], adapterId, receivedAt, namespace",
  outboundQueue:
    "&id, conversationKey, [conversationKey+createdAt], [conversationKey+orderSeq], status, nextAttemptAt, idempotencyKey, [adapterId+status], createdAt, [status+nextAttemptAt], [status+claimedAt], projectId, [projectId+status], updatedAt",
  conversationOverrides:
    "&id, &conversationKey, sessionId, pinned, archived, updatedAt, status, [status+updatedAt], *labelIds, nextResponseDueAt, assigneeKind, projectId",
  connectorAudit:
    "&id, adapterId, kind, at, [adapterId+at], [adapterId+kind+at], projectId, [projectId+at]",
  connectorDrafts:
    "&id, conversationKey, sessionId, [conversationKey+createdAt], status, expiresAt, projectId, updatedAt",
  connectorAttachments:
    "&id, [adapterId+remoteRef], adapterId, cacheKey, mimeType, fetchedAt, lastAccessedAt, expiresAt",
  subscriptionUsage: "++localId, fetchedAt, status, source, [source+fetchedAt]",
  workflows:
    "&id, name, updatedAt, createdAt, isBuiltIn, isTemplate, *tags, schemaVersion, folderId",
  workflowRuns:
    "&id, workflowId, status, startedAt, completedAt, [workflowId+startedAt], [workflowId+status], projectId, [projectId+startedAt], triggeredBySource, [triggeredBySource+startedAt], triggerKind",
  workflowRunEvents:
    "&id, runId, [runId+ts], [runId+sequence], stepId, [runId+stepId], type, projectId",
  workflowTriggers: "&id, workflowId, kind, enabled, [workflowId+enabled], cron, nextFireAt",
  pairedDevices: "&deviceId, lastSeenAt, revokedAt, platform",
  sessionUsage:
    "&messageId, sessionId, [sessionId+at], at, model, characterId, surface, providerId, projectId, [projectId+at], runId",
  mobileOutboundQueue: "&id, status, [status+nextAttemptAt], createdAt, command",
  chatDrafts: "&sessionId, updatedAt",
  pluginDexieMeta: "&pluginId, appliedAt",
  automationAuditLog: "&id, ts, surface, decision, command, conversationKey",
  trustedPublishers: "&publicKey, fingerprint, firstTrustedAt",
  chatGoals:
    "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt, projectId, [projectId+createdAt]",
  chatGoalEvents: "&id, goalId, [goalId+ts], kind, ts, projectId",
  openVsxCache: "&extensionId, fetchedAt",
  vscodeExtensionRuntime: "&extensionId, lastActivatedAt, lastError, sidecarPid",
  twins: "&id, updatedAt, archived, createdAt",
  workflowViewportBookmarks: "&id, workflowId, [workflowId+createdAt]",
  ocrResults: "&id, providerId, createdAt, fileSha",
  pluginSkillUsage: "&pluginSkillId, lastUsedAt, pluginId",
  connectorCallbackBindings:
    "&id, [adapterId+actionId], adapterId, kind, surfaceId, conversationKey, createdAt, expiresAt",
  workflowProposalHistory: "&id, workflowId, createdAt, [workflowId+createdAt]",
  syncCursors: null,
  inboxTelemetryEvents: "&id, kind, at, adapterId, conversationKey",
  connectorHeartbeats: "&id, adapterId, [adapterId+at], at",
  workflowFolders: "&id, name, parentFolderId, [parentFolderId+name], updatedAt, createdAt",
  goalTemplates: "&id, builtin, isFavorite, sortOrder, updatedAt, createdAt",
  sharedLinks: "&id, &code, kind, createdAt, expiresAt",
  agentTraces:
    "&id, startTime, sessionId, [sessionId+startTime], traceId, [traceId+startTime], parentSpanId, surface, projectId, [projectId+startTime], runId, status",
  workflowFanoutSubscriptions:
    "&id, workflowId, [workflowId+enabled], enabled, adapterId, conversationKey, createdAt",
  sandboxConnections: "&id, name, provider, state, createdAt, updatedAt",
  pluginMarketplaceSources: "&id, repoRef, addedAt",
  modelsDevCatalog: "&id, fetchedAt",
  syncTombstones: "[table+id], table, deletedAt",
  projects: "&id, lastAccessedAt",
  evalDatasets: "&id, capability, updatedAt, createdAt",
  evalCases: "&id, datasetId, [datasetId+createdAt], capability, failureMode, sourceTraceId",
  evalRuns: "&runId, datasetId, [datasetId+createdAt], createdAt, reproducibility",
  traceAnnotations: "&id, &traceId, sessionId, failureMode, createdAt",
  memories:
    "&id, scope, type, characterId, projectId, agentId, status, reviewStatus, staleness, expiresAt, updatedAt, lastAccessedAt, vectorDocId, sourceSessionId, sourceMessageId, pinned, projectMemoryKind, trustState, [scope+type], [scope+status], [type+status], [projectId+status], [agentId+status], [projectId+projectMemoryKind]",
  petProfile: "&id",
  petCharacterBindings: "&characterId, updatedAt",
  petActivityLog: "++id, kind, ts, [kind+ts]",
  petAchievements: "&id, unlockedAt",
  notifications:
    "&id, createdAt, updatedAt, source, level, readState, dedupeKey, groupKey, snoozedUntil, expiresAt, [readState+createdAt], [source+createdAt]",
  evalDatasetVersions: "&id, datasetId, [datasetId+version], tag, createdAt",
  evalRunCaseResults: "&id, runId, [runId+caseId], caseId",
  subscriptionBalance: "++localId, fetchedAt, accountId, [providerKey+accountId]",
  agentPlans:
    "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt, projectId, [projectId+createdAt]",
  agentPlanEvents: "&id, planId, [planId+ts], kind, ts, projectId",
  remoteControlAudit: "id, at, direction, kind, runId",
  petModels: "&id, name, createdAt, source",
  petModelFiles: "&id, modelId, [modelId+path]",
  terminalHistory: "&id, ts, command, [projectId+command]",
  unattendedExecAudit: "&id, ts, runId",
  providerCostDaily: "&id, day, providerId, [providerId+day], updatedAt",
  toolRoutes: "&id, refId, kind, enabled, pluginId",
  petConversation: "++id, at",
  loops:
    "&id, sessionId, [sessionId+status], status, mode, scheduledTaskId, createdAt, projectId, [projectId+createdAt]",
  loopEvents: "&id, loopId, [loopId+ts], kind, ts, projectId",
  chatInputHistory: "++id, sessionId, [sessionId+createdAt]",
  calibrationItems:
    "id, setId, criterion, [setId+createdAt], sourceTraceId, sourceCaseId, createdAt",
  calibrationRuns: "runId, setId, [setId+createdAt], createdAt",
  conversationLabels: "&id, name, builtin, sortOrder, updatedAt",
  conversationAssignmentEvents: "&id, conversationKey, [conversationKey+at], kind, at",
  cannedResponses: "&id, title, category, isBuiltIn, sortOrder, updatedAt, *labelIds",
  providerLimits: "++localId, fetchedAt, provider, accountId, [provider+accountId]",
  backgroundTasks:
    "&runId, kind, subagentId, sessionId, host, status, startedAt, settledAt, [host+status], [sessionId+startedAt]",
  wasmGrantLedger: "&id, pluginId, preopen, source, grantedAt",
  runRecords: "[sessionId+runId], sessionId, [sessionId+startedAt], startedAt, status",
  sessionFolders: "id, projectId, [projectId+order], name, createdAt, updatedAt",
  remoteControlRunStatus: "&runId, target, status, startedAt, updatedAt",
  openrouterCatalog: "&id, fetchedAt",
  petInventory: "&id",
  wikiLintResults: "&scope, lastRunAt",
  radarReports: "&id, generatedAt, [scope+generatedAt]",
  capturedItems: "&id, capturedAt, kind, sourceApp, fingerprint",
  inboundDrafts: "&id, kind, status, createdAt, canonicalHash, [status+createdAt]",
  gatewayRequestLog: "&id, at, status, model, keyId",
  projectChunks:
    "&id, projectId, fileId, vectorDocId, generationId, [projectId+fileId], [projectId+generationId], [projectId+createdAt]",
  opticalArchives: "&id, sessionId, createdAt, [sessionId+createdAt]",
  teamPrObservations: "&id, teamId, [teamId+updatedAt], runId, derivedStatus",
  agentTeamBoard: "&id, teamId, [teamId+updatedAt], updatedAt, kind, status",
  fleetSessions: "&id, [agent+sessionId], startedAt, endedAt, agent, outcome",
  codeAdoptionTurns: "&id, runId, sessionId, workspaceRoot, ts, [sessionId+ts]",
  approvedBinaries: "&[pluginId+binaryPath], pluginId, sha256, approvedAt",
  browserRecordings: "&id, baseUrl, updatedAt, [baseUrl+updatedAt]",
  browserAnnotations: "&id, sessionId, baseUrl, status, createdAt, [baseUrl+status]",
  behaviorEvents: "&id, eventName, at, sessionId, [eventName+at]",
  executionRuns:
    "&id, kind, sourceId, status, sessionId, projectId, updatedAt, [kind+sourceId], parentRunId, [parentRunId+status]",
  executionRunEvents: "&id, runId, [runId+seq], type, ts, projectId",
  executionRunBindings:
    "&id, runId, adapterId, conversationKey, status, [runId+conversationKey], projectId",
  executionRunInterrupts: "&id, runId, status, expiresAt, [runId+status], projectId",
  contextComments:
    "&id, resourceKind, resourceId, [resourceKind+resourceId], [resourceKind+resourceId+createdAt], parentId, resolvedAt, projectId",
  siteProjects:
    "&id, projectId, updatedAt, lifecycle, executionTargetKey, &[projectId+sourceRoot+sourceSubpath+executionTargetKey]",
  siteVersions: "&id, siteId, &[siteId+sequence], status, createdAt, artifactDigest",
  siteArtifacts: "&digest, createdAt",
  siteEnvironmentRevisions: "&id, siteId, &[siteId+sequence], createdAt",
  siteDeployments: "&id, siteId, versionId, status, updatedAt, [siteId+updatedAt]",
  siteOperations:
    "&id, siteId, &idempotencyKey, executionTargetKey, status, createdAt, [executionTargetKey+status]",
  siteOperationEvents: "&id, operationId, &[operationId+sequence], createdAt",
  siteResources:
    "&id, siteId, provider, kind, ownership, status, [provider+kind+providerResourceId]",
  browserProfiles: "&id, workspaceId, [workspaceId+updatedAt], name",
  browserDomainGrants: "&id, workspaceId, &[workspaceId+domain], updatedAt",
  memoryEvidence:
    "&id, memoryId, kind, sessionId, messageId, validationState, createdAt, [memoryId+createdAt], [sessionId+messageId]",
  memoryJobs:
    "&id, dedupeKey, status, kind, sessionId, projectId, queuedAt, nextAttemptAt, leaseExpiresAt, heartbeatAt, [status+queuedAt]",
  memoryAuditEvents: "&id, memoryId, sessionId, action, createdAt, [memoryId+createdAt]",
  petSpritePacks: "&id, displayName, createdAt",
  connectorConversationStates:
    "&conversationKey, adapterId, activationStatus, expiresAt, updatedAt",
  connectorInboundJobs:
    "&id, &[adapterId+platformMessageId], [conversationKey+status+receivedAt], adapterId, conversationKey, status, leaseExpiresAt, executionRunId, receivedAt, [status+updatedAt]",
  providerProfiles: "&id",
  deploymentProfiles: "&id, providerRef, legacyProviderId",
  transportProfiles: "&id",
  profileStoreMeta: "&id",
  agentCompatibilityRecords: "&keyId, bundleId, deploymentRef",
  agentCanonicalSessions: "&canonicalSessionId, sourceRuntime, nativeSessionId, updatedAt",
  feishuTenants: "&id, &[tenantKey+appId], status, updatedAt",
  feishuPrincipals:
    "&id, &[tenantKey+appId+openId], [tenantKey+appId], cogniaUserId, platformIdentityId, status, updatedAt",
  feishuPrincipalBindRequests: "&id, openId, adapterId, status, requestedAt, expiresAt",
  larkEntryContexts: "&id, adapterId, principalId, accountId, entryType, expiresAt",
  larkChatSurfaces: "&[adapterId+chatId+surfaceType], adapterId, status, nextAttemptAt",
  larkMessageImports: "&id, &sourceHash, [adapterId+chatId], sessionId, createdAt",
  larkWebSessions: "&id, adapterId, principalId, expiresAt",
  integrationAccounts:
    "&id, pluginId, &[pluginId+integrationId+remoteAccountId], [pluginId+integrationId], providerId, enabled, health, updatedAt",
  integrationSubscriptions:
    "&id, pluginId, [pluginId+integrationId], accountId, [accountId+enabled], ingressRouteId, updatedAt",
  integrationEvents:
    "&id, &[accountId+deliveryId], [pluginId+integrationId], accountId, subscriptionId, eventType, occurredAt, receivedAt",
  integrationActionJobs:
    "&id, &[accountId+idempotencyKey], [pluginId+integrationId], accountId, status, nextAttemptAt, updatedAt",
  integrationAudit:
    "&id, [pluginId+integrationId], accountId, kind, createdAt, [accountId+createdAt]",
  messageMedia: "&hash, createdAt, lastUsedAt",
  hostSyncCursors: "&[serverKey+table], table, lastSyncAt, since",
  templateDefinitions:
    "&storageKey, id, domain, status, version, updatedAt, [id+status], workspaceId, [workspaceId+updatedAt]",
  templatePackages: "&key, id, version, trust, importedAt",
  templateInstances:
    "&id, source.definitionId, source.version, updatedAt, projectId, [projectId+updatedAt]",
  templateDeviceBindings: "&id, definitionId, slotId, kind, [definitionId+slotId], updatedAt",
  templateMigrationJournal: "&id, domain, sourceKey, status, updatedAt",
  chatSearchText:
    "&messageId, sessionId, [sessionId+createdAt], [createdAt+messageId], projectId, [projectId+createdAt]",
  chatSearchState: "id",
  providerCatalogRevisions: "&id, status, generatedAt, integrity",
  providerCatalogProviders: "&[revisionId+id], revisionId, id, tier, *modalities",
  providerCatalogModels: "&[revisionId+id], revisionId, id, creator, family, lifecycle",
  providerCatalogOfferings:
    "&[revisionId+id], revisionId, id, [revisionId+providerRef], [revisionId+modelRef], providerRef, modelRef, lifecycle, available",
  providerCatalogAliases: "&[revisionId+id], revisionId, id, kind",
  providerCatalogState: "&id",
  providerConnectionInventory:
    "&id, &deploymentRef, providerRef, status, checkedAt, *availableUpstreamIds",
  evalProjects: "&id, mode, updatedAt, createdAt",
  evalExperiments: "&id, projectId, state, [projectId+createdAt], updatedAt",
  evalTasks:
    "&id, experimentId, [experimentId+state], [state+nextAttemptAt], variantId, caseId, providerId",
  evalSamples: "&id, experimentId, taskId, [experimentId+caseId], variantId, createdAt, expiresAt",
  evalScores: "&id, experimentId, sampleId, scorerId, [experimentId+scorerId], createdAt",
  evalReviewBatches: "&id, experimentId, status, createdAt",
  evalReviewVotes: "&id, batchId, experimentId, pairId, reviewerId, [batchId+pairId]",
  evalAdjudications: "&id, batchId, pairId, adjudicatorId, [batchId+pairId]",
  evalRecommendations: "&id, &experimentId, createdAt",
  evalConfigurationApplies: "&id, experimentId, targetType, targetId, appliedAt, rolledBackAt",
  evalAssets: "&digest, mediaType, createdAt, expiresAt, referenceCount",
  actionReviewReceipts:
    "&id, decidedAt, expiresAt, outcome, authority, tier, channel, sessionId, runId, projectId, [channel+decidedAt], [sessionId+decidedAt], *surfaceIds",
  providerDiagnosticJobs: "&id, providerId, status, startedAt, [providerId+startedAt]",
  providerDiagnosticSamples:
    "&id, jobId, targetId, providerId, modelId, status, startedAt, [providerId+startedAt], [targetId+startedAt]",
  providerBalanceSnapshots:
    "&id, providerId, sourceId, accountId, fetchedAt, [providerId+fetchedAt], [sourceId+fetchedAt]",
  providerDiagnosticsRefreshState:
    "&sourceId, providerId, status, nextDueAt, [providerId+nextDueAt]",
  providerEndpointChanges: "&id, providerId, appliedAt, rolledBackAt, [providerId+appliedAt]",
  skillRecordings: "&id, skillId, status, updatedAt, [skillId+createdAt]",
  wikiCorpora: "&id, kind, enabled, createdAt",
  wikiCorpusManifest: "&corpusId, scope, lastBuildAt",
  wikiBuildJobs: "&id, corpusId, status, queuedAt, [corpusId+queuedAt], [corpusId+status]",
  wikiArticlesStaging: "&id, buildId, corpusId, [buildId+slug], [buildId+module]",
  wikiSectionsStaging: "&id, buildId, articleId, [articleId+sectionIndex]",
  inboundMaterializations: "&draftId, status, kind, queuedAt, [status+queuedAt]",
  knowledgeNotes: "&id, createdAt, sourceDraftId, *tags",
  projectEnvironments: "&id, projectId, isEnabled, updatedAt, [projectId+updatedAt]",
  cdpGrants:
    "&id, sessionId, browserSessionId, origin, expiresAt, revokedAt, [sessionId+expiresAt]",
  cdpAuditEvents:
    "&id, grantId, sessionId, browserSessionId, origin, outcome, createdAt, [sessionId+createdAt]",
  agentTeamRuns: "&id, teamId, projectId, status, priority, updatedAt, [teamId+updatedAt]",
  // v215 — Squad DEFINITIONS. The runtime half above has been here since v145;
  // these three were the last of the subsystem still in a localStorage blob,
  // which is why `AgentTeam.projectId` was a filter rather than a boundary.
  agentTeams: "&id, projectId, status, createdAt, updatedAt, [projectId+createdAt]",
  agentTeammates: "&id, teamId, role, updatedAt, [teamId+createdAt]",
  agentTeamTasks: "&id, teamId, status, assignedTo, updatedAt, [teamId+order]",
  agentTeamChildRuns:
    "&id, runId, teamId, teammateId, taskId, repositoryId, status, sessionId, updatedAt, [runId+updatedAt]",
  agentTeamTrajectory:
    "&id, runId, childRunId, sequence, kind, createdAt, [runId+sequence], [childRunId+sequence]",
  agentTeamCheckpoints:
    "&id, runId, childRunId, createdAt, [runId+createdAt], [childRunId+createdAt]",
  agentTeamDecisions: "&id, runId, version, status, createdAt, [runId+version]",
  agentTeamSteeringReceipts: "&id, runId, childRunId, status, updatedAt, [childRunId+updatedAt]",
  agentTeamEvidence:
    "&id, runId, childRunId, taskId, kind, createdAt, [runId+createdAt], [taskId+createdAt]",
  agentTeamDeliveryGraphs: "&id, runId, status, updatedAt",
  agentTeamDeliveryNodes:
    "&id, graphId, runId, repositoryId, order, status, updatedAt, [graphId+order]",
  agentTeamRetrospectives: "&id, runId, status, createdAt, updatedAt",
  agentTeamContentObjects: "&hash, mimeType, byteLength, createdAt",
  projectEnvironmentVersions:
    "&id, environmentId, projectId, version, createdAt, [environmentId+version]",
  knowledgeBases: "&id, name, updatedAt",
  knowledgeBaseSources:
    "&id, knowledgeBaseId, status, fingerprint, updatedAt, [knowledgeBaseId+updatedAt], &[knowledgeBaseId+fingerprint]",
  knowledgeBaseChunks:
    "&id, knowledgeBaseId, sourceId, vectorDocId, generationId, [knowledgeBaseId+sourceId], [knowledgeBaseId+generationId], [knowledgeBaseId+createdAt]",
  knowledgeBaseIngestJobs:
    "&id, knowledgeBaseId, sourceId, status, updatedAt, [knowledgeBaseId+status], [knowledgeBaseId+updatedAt]",
  agentTasks:
    "&id, agentId, projectId, status, priority, scheduledFor, updatedAt, [agentId+status], [agentId+updatedAt]",
  agentTaskAttempts:
    "&id, taskId, agentId, status, attemptNo, schedulerExecutionId, updatedAt, [taskId+attemptNo], [taskId+updatedAt]",
  workflowVersions: "&id, workflowId, [workflowId+sequence], digest, createdAt",
  workflowDeployments:
    "&id, &[accountId+workflowId+environment], workflowId, environment, versionId, status, updatedAt",
  workflowInvocations:
    "&id, &[accountId+entrypoint+deploymentId+caller+idempotencyKey], deploymentId, versionId, runId, status, createdAt",
  mcpSyncJobs: "&id, status, nextAttemptAt, updatedAt",
  mcpCapabilityCache: "&id, serverId, expiresAt, updatedAt",
  mcpServerSummaries: "&id, updatedAt, trustState",
  messageMediaRefs: "[messageId+hash], sessionId, messageId, hash, [sessionId+hash]",
  chatTurnSummaries:
    "[sessionId+turnKey], sessionId, turnKey, [sessionId+order], revision, updatedAt",
  chatTranscriptIndexState: "sessionId, revision, updatedAt",
  sessionPeerMessages:
    "&id, senderSessionId, receiverSessionId, status, expiresAt, [receiverSessionId+status], [senderSessionId+createdAt], [receiverSessionId+createdAt]",
  workflowWaitpoints:
    "&id, status, kind, runId, workflowId, stepId, key, expiresAt, [kind+status], [key+status], [runId+status]",
  workflowWaitEvents:
    "&id, key, correlationId, emittedAt, expiresAt, consumedByWaitpointId, [key+emittedAt]",
  governanceDecisions:
    "&id, mode, kind, state, recordedAt, subjectKey, projectId, runId, sessionId, [kind+recordedAt], [runId+recordedAt]",
  governanceDecisionEvents:
    "&id, decisionId, &[decisionId+sequence], type, at, runId, [decisionId+at]",
  governanceEvidence:
    "&id, kind, sourceKey, observedAt, projectId, [kind+observedAt], [projectId+observedAt]",
  governanceLineage:
    "&id, fromKey, toKey, relation, recordedAt, *evidenceRefs, [fromKey+relation], [toKey+relation]",
  governanceConflicts:
    "&id, status, risk, subjectKey, predicateKey, createdAt, projectId, resolutionDecisionRef, [status+createdAt]",
  governanceProvenance:
    "&eventId, eventType, source, occurredAt, subjectKey, runId, projectId, *decisionRefs, *evidenceRefs, [eventType+occurredAt]",
  runRetrospectives:
    "&id, &runKey, runId, status, analysisVersion, createdAt, updatedAt, [runId+analysisVersion]",
  runLearningProposals:
    "&id, retrospectiveId, runId, status, targetKind, createdAt, updatedAt, [retrospectiveId+status], [runId+status]",
  performanceCaptures:
    "&id, status, startedAt, updatedAt, stoppedAt, pinned, sourceKind, sourceId, targetId, trustState, importedAt",
  performanceCaptureChunks:
    "&id, &[captureId+ordinal], captureId, [captureId+firstSequence], [captureId+lastSequence]",
  performanceCaptureAttachments: "&id, &[captureId+ordinal], captureId",
  performanceCaptureGaps: "&id, &[captureId+ordinal], captureId, reason",
  matrixPendingEncryptedEvents:
    "&id, &[adapterId+eventId], [adapterId+state+nextAttemptAt], adapterId, roomId, state, firstSeenAt, updatedAt",
  retrievalProfiles: "&id, &fingerprint, active, updatedAt",
  retrievalGenerations:
    "&id, corpusId, domain, status, profileFingerprint, createdAt, [corpusId+status], [corpusId+profileFingerprint]",
  retrievalActivePointers: "&corpusId, generationId, domain, profileFingerprint, updatedAt",
  retrievalJobs:
    "&id, dedupeKey, kind, corpusId, generationId, status, queuedAt, nextAttemptAt, leaseExpiresAt, [status+queuedAt], [corpusId+status]",
  retrievalTraces:
    "&traceId, corpusId, domain, generationId, profileFingerprint, createdAt, expiresAt, [corpusId+createdAt]",
  retrievalEncryptedContent:
    "&id, entityType, entityId, corpusId, generationId, kind, updatedAt, [entityType+entityId], [corpusId+generationId]",
  retrievalTombstones:
    "&id, entityType, entityId, corpusId, createdAt, eligiblePurgeAt, [entityType+entityId]",
  retrievalMigrationJournal: "&id, phase, status, updatedAt, [phase+status]",
  retrievalRuntimeState: "&id, killSwitchEngaged, changedAt",
  hostStateChannels: "&channel, hostGeneration, hostSeq, revision, updatedAt",
  hostStateActions:
    "&[hostGeneration+actionId], channel, hostSeq, outcome, dispatchState, broadcastState, createdAt, updatedAt",
  hostStateMeta: "&id, hostGeneration, leaseExpiresAt, migrationStage, updatedAt",
  workSubmissions:
    "&id, accountId, &[accountId+idempotencyKey], runId, sessionId, projectId, sourceKind, dispatchState, [dispatchState+nextAttemptAt], leaseExpiresAt, createdAt, updatedAt",
  workInputBatches: "&id, &submissionId, digest, expiresAt",
  executionContextBundles: "&id, &submissionId, projectId, digest, expiresAt",
  issues:
    "&id, projectId, issueProjectId, status, statusCategory, assigneeKind, assigneeId, [assigneeKind+assigneeId], [issueProjectId+status], &identifier, updatedAt, createdAt, *labelIds",
  issueProjects: "&id, projectId, &key, status, updatedAt",
  issueEvents: "&id, issueId, [issueId+ts], kind, ts",
  issueCounters: "&scopeId",
  labels: "&id, scope, [scope+name], name, builtin, sortOrder, updatedAt",
  githubIssueMirror:
    "&id, repoFullName, &[repoFullName+number], issueProjectId, state, updatedAt, syncedAt",
  issueRuns:
    "&id, issueId, [issueId+status], projectId, [projectId+status], adapterId, kind, targetId, status, startedAt, updatedAt",
  hostDispatchQueue:
    "&id, accountId, domain, targetRef, status, [status+nextAttemptAt], [accountId+status], runId, &idempotencyKey, createdAt",
  connectorCleanupJobs: "&id, adapterId, reason, nextAttemptAt, createdAt",
  sessionAttachmentUploads: "&uploadId, sessionId, deviceId, expiresAt, [sessionId+deviceId]",
  serviceConnections:
    "&id, pluginId, serviceId, providerId, runtimeTargetId, status, [pluginId+serviceId], [serviceId+status], updatedAt",
  capabilityGrants:
    "&id, connectionId, providerFingerprint, accountId, workflowId, sessionId, expiresAt, [connectionId+providerFingerprint]",
  openApiImports: "&id, pluginId, serviceId, providerId, trust, sourceKind, updatedAt",
  workflowHumanInputRequests:
    "&id, waitpointId, status, runId, workflowId, stepId, expiresAt, [workflowId+status], [runId+status]",
  workflowHumanInputSubmissions:
    "&id, requestId, responderId, actionId, submittedAt, sensitiveExpiresAt, &[requestId+responderId]",
  mobileStepReceipts: "&requestId, deviceId, status, [deviceId+status], updatedAt, expiresAt",
  workflowHumanInputFiles:
    "&id, accountId, requestId, responderId, fieldId, expiresAt, [requestId+responderId]",
  workflowApps:
    "&id, accountId, workflowId, slug, &[accountId+slug], [accountId+workflowId], currentReleaseId, updatedAt",
  workflowAppReleases:
    "&id, appId, accountId, workflowId, versionId, sequence, createdAt, &[appId+sequence]",
  workflowConversations:
    "&id, accountId, appId, appReleaseId, versionId, status, updatedAt, expiresAt, [appId+status], [accountId+status]",
  workflowConversationMessages:
    "&id, accountId, conversationId, sequence, role, idempotencyKey, runId, createdAt, expiresAt, &[conversationId+sequence], &[conversationId+idempotencyKey]",
  workflowConversationSummaries:
    "&id, accountId, conversationId, revision, throughSequence, createdAt, &[conversationId+revision]",
  workflowConversationReleaseEvents:
    "&id, accountId, conversationId, fromReleaseId, toReleaseId, at",
  workflowBatchJobs:
    "&id, accountId, appId, appReleaseId, status, updatedAt, expiresAt, [appId+status], [accountId+status]",
  workflowBatchRows:
    "&id, accountId, jobId, rowNumber, status, runId, updatedAt, expiresAt, &[jobId+rowNumber], [jobId+status]",
  workflowKnowledgeArtifacts: "&id, accountId, runId, stepId, stage, expiresAt, [runId+stage]",
  workflowReviews:
    "&id, accountId, workflowId, versionId, status, updatedAt, [accountId+workflowId], [versionId+status]",
  workflowReviewSuggestions:
    "&id, accountId, workflowId, reviewId, baseVersionId, status, updatedAt, [reviewId+status]",
  workflowFeedbackCandidates:
    "&id, accountId, appId, appReleaseId, status, rating, fingerprint, expiresAt, [accountId+fingerprint], [appId+status]",
  workflowAnnotationSets: "&id, accountId, appId, updatedAt, [accountId+appId]",
  workflowAnnotationSetRevisions:
    "&id, accountId, appId, setId, sequence, createdAt, &[setId+sequence]",
  workflowAppApiKeys:
    "&id, accountId, appId, &secretHash, expiresAt, revokedAt, updatedAt, [appId+revokedAt]",
  chatTemplates: "&id, name, updatedAt, lastUsedAt",
  users: "&id, email, updatedAt",
  orgs: "&id, logtoOrganizationId, updatedAt",
  orgMemberships: "&id, orgId, userId, updatedAt",
  workspaceMemberships: "&id, workspaceId, userId, orgId, [userId+orgId], updatedAt",
  externalIdentities: "&id, userId, provider, subject, linkedAt",
  collabIssues:
    "&id, orgId, workspaceId, issueProjectId, [orgId+workspaceId], updatedAt, fetchedAt",
  collabWorkspaces: "&id, orgId, name, updatedAt, fetchedAt",
  collabPlans: "&id, orgId, workspaceId, status, updatedAt, fetchedAt",
  collabRuns: "&id, orgId, workspaceId, issueId, planId, status, startedAt, fetchedAt",
  browserSubmissions: "&submissionId, deviceId, sessionId, submittedAt, [deviceId+submittedAt]",
  threadHandoffTickets:
    "&[ticketId+role], ticketId, role, state, expiresAt, source.sessionId, target.hostRef",
  externalAgentConfigHeads: "&configId, tombstonedAt, updatedAt",
  externalAgentConfigRevisions: "&revisionId, configId, [configId+seq], createdAt, *leaseRuns",
  siteBuildLogs: "&id, versionId, siteId, operationId, [versionId+phase], createdAt",
  chatResultIndex:
    "&resultId, messageId, sessionId, [sessionId+createdAt], [createdAt+resultId], projectId, [projectId+createdAt], kind, toolName",
  chatResultIndexState: "id",
  mentionLinks:
    "&linkId, messageId, sessionId, [refKind+refId], [refKind+refId+createdAt], projectId, createdAt",
  mentionLinkState: "id",
  artifacts:
    "&id, sessionId, projectId, messageId, type, updatedAt, [sessionId+updatedAt], [projectId+updatedAt]",
  artifactVersions: "&id, artifactId, projectId, [artifactId+version], createdAt",
  collabChatSessions: "&id, orgId, workspaceId, [orgId+workspaceId], status, updatedAt, fetchedAt",
  collabChatMemberships:
    "&[sessionId+userId], sessionId, userId, orgId, role, updatedAt, fetchedAt",
  collabChatEvents: "&id, sessionId, orgId, [sessionId+sequence], sequence, fetchedAt",
  collabChatInvites: "&id, sessionId, orgId, status, expiresAt, fetchedAt",
  collabChatApprovals: "&id, sessionId, orgId, runId, status, expiresAt, fetchedAt",
  collabChatSyncStates: "&sessionId, orgId, updatedAt",
  accountContentMigrations: "&id, accountId, status, updatedAt",
  collabChatAttachments: "&id, sessionId, orgId, status, updatedAt, fetchedAt",
  evalObservations:
    "&id, origin, evaluatorVersionId, scope.runId, scope.experimentId, scope.caseId, scope.traceId, createdAt, [origin+createdAt], [scope.traceId+origin]",
  evalOnlinePolicies: "&id, workspaceId, enabledFlag, updatedAt, [workspaceId+enabledFlag]",
  evalOnlineQueue:
    "&id, &dedupeKey, policyId, policyVersionId, traceId, state, enqueuedAt, [state+enqueuedAt], [policyId+state]",
  evalOnlineBudget: "&id, policyId, day, [policyId+day]",
  projectMiningRuns: "&id, projectId, status, createdAt, [projectId+status]",
}

let databaseConnectionSequence = 0

/** Historical table shape retained only so old databases remain readable. */
interface LegacyRemoteControlRunStatusRow {
  runId: string
  target: string
  status: string
  detail?: string
  correlationId?: string
  startedAt: number
  updatedAt: number
}

export class CogniaDB extends Dexie {
  readonly connectionOwner: string
  readonly connectionId: string
  private readonly connectionCreatedAt: number
  sessions!: Table<ChatSession, string>
  messages!: Table<StoredMessage, string>
  // v155 — independent-session messages and their durable delivery receipts.
  sessionPeerMessages!: Table<import("./session-peer-messages").SessionPeerMessageRow, string>
  storageLayout!: Table<import("./storage-layout").StorageLayoutMarker, "singleton">
  settings!: Table<AppSettings, "singleton">
  promptPresets!: Table<SystemPromptPreset, string>
  mcpServers!: Table<McpServer, string>
  // v151 — MCP control-plane governance and durable runtime metadata.
  mcpSyncJobs!: Table<McpSyncJob, string>
  mcpCapabilityCache!: Table<McpCapabilityCacheRow, string>
  mcpServerSummaries!: Table<McpServerSummary, string>
  // v184 — unified external-service connections, scoped grants, and OpenAPI imports.
  serviceConnections!: Table<ServiceConnection, string>
  capabilityGrants!: Table<CapabilityGrant, string>
  openApiImports!: Table<OpenApiImportRow, string>
  characters!: Table<Character, string>
  skills!: Table<Skill, string>
  skillResources!: Table<SkillResource, string>
  teams!: Table<Team, string>
  trustedWorkspaces!: Table<TrustedWorkspace, string>
  backupHistory!: Table<BackupHistoryRow, string>
  // v114 — unified semantic execution journal and IM presentation state.
  executionRuns!: Table<ExecutionRun, string>
  executionRunEvents!: Table<RunEvent, string>
  executionRunBindings!: Table<ExecutionRunBinding, string>
  executionRunInterrupts!: Table<ExecutionRunInterrupt, string>
  notifications!: Table<NotificationRecord, string>
  // v116 — Cognia Sites immutable lifecycle and recoverable provider operations.
  siteProjects!: Table<SiteProjectRow, string>
  siteVersions!: Table<SiteVersionRow, string>
  siteArtifacts!: Table<SiteArtifactRow, string>
  siteEnvironmentRevisions!: Table<SiteEnvironmentRevisionRow, string>
  siteDeployments!: Table<SiteDeploymentRow, string>
  siteOperations!: Table<SiteOperationRow, string>
  siteOperationEvents!: Table<SiteOperationEventRow, string>
  siteResources!: Table<SiteResourceRow, string>
  // v203 — captured build output. See `lib/sites/build-log.ts`.
  siteBuildLogs!: Table<SiteBuildLogRow, string>
  canvasDocuments!: Table<CanvasDocumentRow, string>
  canvasVersions!: Table<CanvasVersionRow, string>
  canvasComments!: Table<CanvasCommentRow, string>
  contextComments!: Table<ContextCommentRow, string>
  canvasSessions!: Table<CanvasSessionRow, string>
  a2uiApps!: Table<A2UIAppRow, string>
  a2uiSurfaces!: Table<A2UISurfaceRow, string>
  a2uiTemplates!: Table<A2UITemplateRow, string>
  a2uiEventHistory!: Table<A2UIEventHistoryRow, string>
  twins!: Table<Twin, string>
  twinSources!: Table<TwinSource, string>
  twinChunks!: Table<TwinChunk, string>
  twinProfile!: Table<TwinProfile, string>
  twinDrafts!: Table<TwinDraft, string>
  twinJobs!: Table<TwinJob, string>
  // v146 — reusable Knowledge Bases independent of Project and Twin ownership.
  knowledgeBases!: Table<KnowledgeBase, string>
  knowledgeBaseSources!: Table<KnowledgeBaseSource, string>
  knowledgeBaseChunks!: Table<KnowledgeBaseChunk, string>
  knowledgeBaseIngestJobs!: Table<KnowledgeBaseIngestJob, string>
  // v147 — portable single-Agent board metadata and immutable run attempts.
  agentTasks!: Table<import("@/types/agent/agent-task").AgentTask, string>
  agentTaskAttempts!: Table<import("@/types/agent/agent-task").AgentTaskAttempt, string>
  // §A-Schema (v15) — plugin tables. Indexed columns are declared in the v15
  // .stores block below; the per-row types live in `./plugin-types.ts`.
  plugins!: Table<PluginRow, string>
  pluginPermissions!: Table<PluginPermissionRow, [string, string]>
  pluginReviews!: Table<PluginReviewRow, [string, string]>
  pluginAnalytics!: Table<PluginAnalyticsRow, [string, string]>
  // v17 — External Bridge (LLM Wiki) tables. Wiki articles are addressed by
  // slug (unique within scope); the manifest is keyed by `scope` so each
  // (scope, build) pair is one row. The audit log is capped at 5000 newest
  // rows by `lib/db/mcp-audit-log.ts`.
  wikiArticles!: Table<WikiArticle, string>
  wikiSections!: Table<WikiSection, string>
  // LEGACY, scope-keyed. Superseded by `wikiCorpusManifest` in v142 — a scope
  // primary key cannot express "many user repos", and Dexie cannot repoint a
  // primary key in place. Kept (not dropped) so a v142 rollback still finds
  // its rows; nothing writes to it after v142.
  wikiManifest!: Table<WikiManifest, string>
  mcpAuditLog!: Table<McpAuditLogRow, string>
  // v142 — corpus model (ADR-0008 Phase 3). See `lib/db/wiki-corpora.ts`,
  // `lib/db/wiki-build-jobs.ts`, and `lib/db/wiki-corpus-manifest.ts`.
  wikiCorpora!: Table<WikiCorpus, string>
  wikiCorpusManifest!: Table<WikiCorpusManifest, string>
  wikiBuildJobs!: Table<WikiBuildJob, string>
  // Staging rows for an in-flight build, keyed by `buildId`. Promoted to the
  // live tables in one transaction on success; never read by search.
  wikiArticlesStaging!: Table<WikiStagedArticle, string>
  wikiSectionsStaging!: Table<WikiStagedSection, string>
  // v18 — Platform Connectors tables. Indexed columns are declared in the v18
  // .stores block below; the per-row types live in `./connector-types.ts`.
  adapterInstances!: Table<AdapterInstanceRow, string>
  platformIdentities!: Table<PlatformIdentityRow, string>
  inboundLedger!: Table<InboundLedgerRow, string>
  outboundQueue!: Table<OutboundJobRow, string>
  conversationOverrides!: Table<ConversationOverrideRow, string>
  connectorAudit!: Table<ConnectorAuditRow, string>
  connectorDrafts!: Table<ConnectorDraftRow, string>
  // v83 — Connector CRM (Chatwoot-style). Row types in `./crm-types.ts`.
  // SUPERSEDED at v170 by the shared `labels` table below; retained per the
  // append-only rule and no longer written to. See `lib/db/labels.ts`.
  conversationLabels!: Table<ConversationLabelRow, string>
  conversationAssignmentEvents!: Table<ConversationAssignmentEventRow, string>
  cannedResponses!: Table<CannedResponseRow, string>
  connectorAttachments!: Table<ConnectorAttachmentRow, string>
  // v178 — pending encrypted-blob deletions that Rust has not confirmed.
  // See `lib/db/connector-cleanup-jobs.ts`.
  connectorCleanupJobs!: Table<ConnectorCleanupJobRow, string>
  connectorCallbackBindings!: Table<ConnectorCallbackBindingRow, string>
  // v51 — Heartbeats split out of `connectorAudit`. Capped per-adapter by
  // the heartbeat sweep (`lib/connectors/health/heartbeat.ts`), not by the
  // audit writer, so heartbeat churn no longer evicts real audit events.
  connectorHeartbeats!: Table<ConnectorHeartbeatRow, string>
  // v120 — topic-scoped activation/delivery state and durable inbound execution jobs.
  connectorConversationStates!: Table<ConnectorConversationStateRow, string>
  connectorInboundJobs!: Table<ConnectorInboundJobRow, string>
  // v125 — Feishu unified identity registry (plan 2026-07-24 Phase 1). The
  // authentication authority for Lark events when `larkPrincipalRegistry` is
  // on; `platformIdentities` stays a display directory. CRUD in
  // `lib/db/feishu-principals.ts`.
  feishuTenants!: Table<FeishuTenantRow, string>
  feishuPrincipals!: Table<FeishuPrincipalRow, string>
  feishuPrincipalBindRequests!: Table<FeishuPrincipalBindRequestRow, string>
  // v126 — Lark entry surfaces (plan 2026-07-24 Phases 3-5): entry-token
  // ledger, Chat Tab / group-menu reconcile state, message-shortcut import
  // idempotency, and the web-session audit ledger. CRUD in
  // `lib/db/lark-entry.ts`, `lib/db/lark-chat-surfaces.ts`,
  // `lib/db/lark-message-imports.ts`.
  larkEntryContexts!: Table<LarkEntryContextRow, string>
  larkChatSurfaces!: Table<LarkChatSurfaceRow, [string, string, string]>
  larkMessageImports!: Table<LarkMessageImportRow, string>
  larkWebSessions!: Table<LarkWebSessionRow, string>
  // v123 — Certification projection (ADR-0090 Phase 5). See `lib/db/agent-compatibility.ts`.
  agentCompatibilityRecords!: Table<AgentCompatibilityRecordRow, string>
  // v124 — Canonical-session header projection (ADR-0090 Phase 8). See
  // `lib/db/agent-canonical-sessions.ts`.
  agentCanonicalSessions!: Table<
    import("./agent-canonical-sessions").AgentCanonicalSessionRow,
    string
  >
  // v127 — Marketplace Integration control plane.
  integrationAccounts!: Table<IntegrationAccountRow, string>
  integrationSubscriptions!: Table<IntegrationSubscriptionRow, string>
  integrationEvents!: Table<IntegrationEventRow, string>
  integrationActionJobs!: Table<IntegrationActionJobRow, string>
  integrationAudit!: Table<IntegrationAuditRow, string>
  // v128 — Content-addressed chat image store. See `lib/db/message-media.ts`.
  messageMedia!: Table<import("./message-media").MessageMediaRow, string>
  // v152 — Message-to-media authorization and lifecycle ledger.
  messageMediaRefs!: Table<import("./message-media-refs").MessageMediaRefRow, [string, string]>
  // v153 — lazily materialized transcript summaries and resumable watermark.
  chatTurnSummaries!: Table<import("./chat-transcript-index").ChatTurnSummaryRow, [string, string]>
  chatTranscriptIndexState!: Table<
    import("./chat-transcript-index").ChatTranscriptIndexStateRow,
    string
  >
  // v134 — chat-history search projections + backfill watermark (ADR-0099).
  // See `lib/db/chat-search-text.ts`.
  chatSearchText!: Table<import("./chat-search-text").ChatSearchTextRow, string>
  chatSearchState!: Table<import("./chat-search-text").ChatSearchStateRow, "singleton">
  // v135 — normalized provider/model catalog + deployment-local availability.
  providerCatalogRevisions!: Table<ProviderCatalogRevisionRow, string>
  providerCatalogProviders!: Table<ProviderCatalogProviderRow, [string, string]>
  providerCatalogModels!: Table<ProviderCatalogModelRow, [string, string]>
  providerCatalogOfferings!: Table<ProviderCatalogOfferingRow, [string, string]>
  providerCatalogAliases!: Table<ProviderCatalogAliasRow, [string, string]>
  providerCatalogState!: Table<ProviderCatalogStateRow, "singleton">
  providerConnectionInventory!: Table<ProviderConnectionInventoryRow, string>
  // v121 — Provider Profile Store (ADR-0090 Phase 1). See `lib/db/provider-profiles.ts`.
  providerProfiles!: Table<ProviderProfile, string>
  deploymentProfiles!: Table<DeploymentProfile, string>
  transportProfiles!: Table<TransportProfile, string>
  profileStoreMeta!: Table<ProfileStoreMetaRow, "singleton">
  // v20 — Claude subscription usage table. One row per `anthropic-ratelimit-
  // unified-*` header snapshot; capped at 1 000 rows newest-first by
  // `lib/anthropic-subscription/usage-collector.ts`.
  subscriptionUsage!: Table<SubscriptionUsageRow, number>
  // v70 — Subscription balance snapshots (ADR-0025 Phase 3). Capped at 500
  // newest-first by `lib/subscription/balance/store.ts`.
  subscriptionBalance!: Table<SubscriptionBalanceRow, number>
  // v84 — Unified provider limits/usage snapshots (ADR-0025 follow-up). One
  // row per `ProviderLimits` reading across every subscription provider
  // (Anthropic windows, Codex windows, credit balances). Capped at 500
  // newest-first by `lib/subscription/limits/store.ts`.
  providerLimits!: Table<ProviderLimitsRow, number>
  // v22 — Visual workflows subsystem (n8n-style). The `workflows` table holds
  // user-authored definitions; `workflowRuns` is one row per execution with
  // a frozen snapshot of the def at run start; `workflowRunEvents` is the
  // durable per-step event log live-queried by the editor + Runs UI;
  // `workflowTriggers` holds registered triggers (cron, webhook, inbound,
  // chat-message, ...) that wake workflows. Run-state mirroring for crash
  // recovery happens in a separate SQLite DB managed by Rust — Dexie is the
  // source of truth for definitions and the event log.
  workflows!: Table<WorkflowRow, string>
  workflowRuns!: Table<WorkflowRunRow, string>
  workflowRunEvents!: Table<WorkflowRunEventRow, string>
  workflowTriggers!: Table<WorkflowTriggerRow, string>
  // v148 — Immutable workflow publication control plane.
  workflowVersions!: Table<WorkflowVersion, string>
  workflowDeployments!: Table<WorkflowDeployment, string>
  workflowInvocations!: Table<WorkflowInvocation, string>
  // v156 — Durable workflow pause/resume state and persist-before-match events.
  workflowWaitpoints!: Table<WorkflowWaitpoint, string>
  workflowWaitEvents!: Table<WorkflowWaitEvent, string>
  // v192 — Workflow App platform tables (Human Input, publication, Chatflow,
  // batch, knowledge, review, feedback, API keys, and mobile receipts).
  workflowHumanInputRequests!: Table<WorkflowHumanInputRequest, string>
  workflowHumanInputSubmissions!: Table<WorkflowHumanInputSubmissionRow, string>
  workflowHumanInputFiles!: Table<WorkflowHumanInputFileRow, string>
  workflowApps!: Table<WorkflowApp, string>
  workflowAppReleases!: Table<WorkflowAppRelease, string>
  workflowBatchJobs!: Table<WorkflowBatchJob, string>
  workflowBatchRows!: Table<WorkflowBatchRow, string>
  workflowKnowledgeArtifacts!: Table<WorkflowKnowledgeArtifactRow, string>
  workflowReviews!: Table<WorkflowReview, string>
  workflowReviewSuggestions!: Table<WorkflowReviewSuggestion, string>
  workflowFeedbackCandidates!: Table<WorkflowFeedbackCandidate, string>
  workflowAnnotationSets!: Table<WorkflowAnnotationSet, string>
  workflowAnnotationSetRevisions!: Table<WorkflowAnnotationSetRevision, string>
  workflowAppApiKeys!: Table<WorkflowAppApiKey, string>
  workflowConversations!: Table<WorkflowConversation, string>
  workflowConversationMessages!: Table<WorkflowConversationMessage, string>
  workflowConversationSummaries!: Table<WorkflowConversationSummary, string>
  workflowConversationReleaseEvents!: Table<WorkflowConversationReleaseEvent, string>
  mobileStepReceipts!: Table<MobileStepReceiptRow, string>
  // v52 — Workflow library folders (ADR-0011 library upgrade). See
  // `types/workflow/folder.ts`.
  workflowFolders!: Table<WorkflowFolder, string>
  // v55 — Workflow run fan-out subscriptions (im-a2ui-abstract-anchor
  // Phase 7). Operator-configured "every run of workflow X mirrors
  // progress to channel Y". See `connector-types.ts` for the row shape.
  workflowFanoutSubscriptions!: Table<WorkflowFanoutSubscriptionRow, string>
  // v23 — Mobile companion paired devices (ADR 0012 → M2). One row per phone
  // that completed the QR pairing flow (POST /api/v1/auth/pair, M2.3). The
  // owner can soft-delete (revoke) any row from the desktop's "Mobile
  // companion" settings tab; the JWT verifier middleware (M2.4) keeps an
  // in-memory deny-list mirror of revoked rows. Per-row types live in
  // `@/types/mobile/paired-device.ts`; CRUD helpers in `./paired-devices.ts`.
  pairedDevices!: Table<PairedDeviceRow, string>
  // v24 — Per-message usage + cost rows captured by the SDK adapter on each
  // `result` event. Primary key `messageId` is the Anthropic assistant
  // message id, which is unique across all sessions, so the writer is
  // naturally idempotent. Aggregation helpers + UI consumers live in
  // `./session-usage.ts` and `components/settings/agent-runtime/tabs/sessions-tab.tsx`.
  sessionUsage!: Table<SessionUsageRow, string>
  // v25 — Mobile outbound queue (Wave 2.1, ADR-0015 §Wave 2). One row per
  // write op enqueued from the phone (chat send, draft approval, workflow
  // trigger, twin ingest, backup export). The runner in
  // `lib/queue/outbound-queue.ts` drains pending rows when the network is
  // online; failed rows back off exponentially and deadletter at 5 attempts.
  mobileOutboundQueue!: Table<MobileOutboundJobRow, string>
  // v168 — AHP-inspired, Host-authoritative shared-session state. Existing
  // session/message/draft repositories remain the business-data owners; these
  // rows hold the rebuildable channel projection, semantic action receipts,
  // and the fencing generation used by every attached client.
  hostStateChannels!: Table<HostStateChannelRow, string>
  hostStateActions!: Table<HostStateActionRow, [number, string]>
  hostStateMeta!: Table<HostStateMetaRow, "singleton">
  // v169 — durable work submission (ADR-0123). `workSubmissions` owns dispatch
  // responsibility only; `ExecutionRun.status` stays the user-visible lifecycle
  // authority. The two payload stores hold the frozen input and execution
  // context a retry must replay verbatim, encrypted at rest and never synced.
  // See `lib/db/work-submissions.ts`.
  workSubmissions!: Table<WorkSubmissionRow, string>
  workInputBatches!: Table<WorkInputBatchRow, string>
  executionContextBundles!: Table<ExecutionContextBundleRow, string>
  // v26 — Per-session unsent composer text (chat drafts). Pure additive, no
  // upgrade hook. Primary key `sessionId` makes upserts trivial; `updatedAt`
  // is indexed so debug surfaces can sort newest-first.
  chatDrafts!: Table<ChatDraftRow, string>
  // v180 — Host-side staging for attachments a remote device uploads into a
  // session (ADR-0005 §4.5). `[sessionId+deviceId]` is the per-caller staging
  // area, `deviceId` powers revoke cleanup, and `expiresAt` powers the
  // collector. See `lib/db/session-attachment-uploads.ts`.
  sessionAttachmentUploads!: Table<SessionAttachmentUploadRow, string>
  // v80 — Per-session sent-message history for ↑/↓ recall in the composer.
  // Auto-increment id; compound `[sessionId+createdAt]` powers newest-first
  // listing; capped per session by `lib/db/chat-input-history.ts`.
  chatInputHistory!: Table<ChatInputHistoryRow, number>
  // v27 — plugin Dexie table registry (M0 platform feature).
  pluginDexieMeta!: Table<PluginDexieMeta, string>
  // v28 — UI automation audit log. One row per Tauri command call that
  // passes through the Rust permission gate. Capped at 5000 newest by
  // `lib/automation/audit.ts`. Indexed by `ts` for newest-first listings,
  // `surface` so the Settings → Automation → Audit tab can filter, and
  // `decision` for the deny-only view.
  automationAuditLog!: Table<AutomationAuditLogRow, string>
  // v29 — WASM plugin author keys the user has trusted (Ed25519 public keys
  // from manifest.author.publicKey, base64). First install of a signed
  // plugin from HTTP/Git prompts the user with the key fingerprint; on
  // accept a row is inserted here so future updates from the same author
  // auto-trust. Pure additive table.
  trustedPublishers!: Table<TrustedPublisherRow, string>
  // v30 — `/goal` command subsystem (ADR-0013). `chatGoals` is one row per
  // goal, session-scoped (one active per session enforced by writer); status
  // transitions are append-only and immutable past terminal. `chatGoalEvents`
  // is the lifecycle audit trail driving the Activity tab + History view.
  chatGoals!: Table<Goal, string>
  chatGoalEvents!: Table<GoalEvent, string>
  // v79 — /loop command (recurring prompts). Mirrors the goal pair: `loops`
  // is one row per loop, session-scoped; `loopEvents` is the audit trail.
  loops!: Table<Loop, string>
  loopEvents!: Table<LoopEvent, string>
  // v53 — reusable goal templates (ADR-0019 Phase 2). Built-ins seeded on
  // access; booleans (builtin/isFavorite) are filtered in-memory by the CRUD
  // layer since IndexedDB doesn't index booleans reliably.
  goalTemplates!: Table<GoalTemplate, string>
  // v71 — Unified Plan Execution Hub (ADR-0045). `agentPlans` is one row per
  // plan, session-scoped (one "open" plan per session enforced by the writer
  // in `lib/db/plans.ts`); `agentPlanEvents` is the append-only lifecycle log
  // driving the tracker panel + audit trail (capped per-plan).
  agentPlans!: Table<AgentPlan, string>
  agentPlanEvents!: Table<PlanEvent, string>
  /**
   * v35 — Visual workflow editor viewport bookmarks. One row per saved view,
   * scoped to a workflow. The `[workflowId+createdAt]` compound index drives
   * the "Views" dropdown's newest-first listing. Pure additive; no upgrade
   * hook needed.
   */
  workflowViewportBookmarks!: Table<WorkflowViewportBookmarkRow, string>
  /**
   * v36 — OCR result cache (ADR-0024). Primary key is the canonical
   * `${sha256(file)}|${providerId}|${sortedLangs.join(",")}` id built by
   * `buildOcrCacheId()`. Indexed by `providerId` so the settings page can
   * purge per-provider, and by `createdAt` for TTL-based cleanup. Pure
   * additive; no upgrade hook needed.
   */
  ocrResults!: Table<OcrResultRow, string>
  /**
   * v37 — Plugin-skill usage telemetry. One row per plugin-contributed
   * skill id. Written by `lib/db/plugin-skill-usage.ts:recordPluginSkillUsage`
   * on each chat send that resolves the plugin skill; read by plugin
   * telemetry surfaces. Pure additive; no upgrade hook needed.
   */
  pluginSkillUsage!: Table<PluginSkillUsageRow, string>
  /**
   * v42 — Workflow proposal history. One row per terminal (applied /
   * discarded) proposal so the Changelog tab can render a timeline.
   * Capped at 50 rows per workflow by `pruneOldProposalHistory()` in
   * `lib/workflow/editor/proposal-history.ts`. Pure additive table; no
   * upgrade hook needed.
   */
  workflowProposalHistory!: Table<WorkflowProposalHistoryRow, string>
  /**
   * v54 — Cloudflare-hosted public share links (zero-knowledge). One row per
   * link the owner created, so the "My Shares" panel can list / re-copy /
   * revoke. The URL embeds the decryption key, which lives only on this device.
   * Per-row type + CRUD live in `./shared-links.ts`. Pure additive table.
   */
  sharedLinks!: Table<SharedLinkRow, string>
  /**
   * v55 — Agent-trace span rows (ADR pending). One row per finished span
   * emitted by `lib/agent-trace/emitter.ts:endSpan` and persisted by
   * `lib/logging/transports/agent-trace-transport.ts`. Indexed by
   * `[sessionId+startTime]` for newest-first chat-side queries, by `traceId`
   * for trace-timeline rendering, by `[traceId+startTime]` so trace views
   * can sort without a second pass, and by `parentSpanId` for child-span
   * lookup. Per-row type lives in `@/types/agent-trace/span.ts`; CRUD +
   * aggregation helpers in `./agent-traces.ts`.
   */
  agentTraces!: Table<AgentTraceSpan, string>
  /**
   * v64 — Agent evaluation subsystem. `evalDatasets` holds versioned,
   * capability-scoped collections; `evalCases` holds the per-dataset test
   * items; `evalRuns` holds one {@link EvalReport} per executed run (the
   * dashboard's trend source); `traceAnnotations` records error-analysis
   * labels on real `agentTraces` (open/axial coding + "save as eval case").
   * Per-row types + CRUD live in `./eval-datasets.ts`, `./eval-runs.ts`,
   * `./trace-annotations.ts`. The current architecture is recorded in
   * `docs/content/docs/{en,zh}/adr/0101-model-evaluation-lab.md`.
   */
  evalDatasets!: Table<EvalDataset, string>
  evalCases!: Table<EvalCase, string>
  evalRuns!: Table<EvalRunRow, string>
  traceAnnotations!: Table<TraceAnnotationRow, string>
  // v69 — Eval dataset version snapshots + per-case run results. See
  // `./eval-dataset-versions.ts` and `./eval-run-cases.ts`.
  evalDatasetVersions!: Table<EvalDatasetVersion, string>
  evalRunCaseResults!: Table<EvalRunCaseRow, string>
  // v137 — Complete Model Evaluation Lab. Project definitions and immutable
  // experiment manifests are separate from durable tasks and encrypted
  // artifacts so execution can recover without mutating historical evidence.
  evalProjects!: Table<EvalProjectRow, string>
  evalExperiments!: Table<EvalExperimentRow, string>
  evalTasks!: Table<EvalTaskRow, string>
  evalSamples!: Table<EvalSampleRow, string>
  evalScores!: Table<EvalScoreRow, string>
  evalReviewBatches!: Table<EvalReviewBatchRow, string>
  evalReviewVotes!: Table<EvalReviewVoteRow, string>
  evalAdjudications!: Table<EvalAdjudicationRow, string>
  evalRecommendations!: Table<EvalRecommendationRow, string>
  evalConfigurationApplies!: Table<EvalConfigurationApplyRow, string>
  evalAssets!: Table<EvalAssetRow, string>
  // v211 — Online evaluation. One observation envelope for every origin
  // (offline / online / human) so there is a single definition of "passing";
  // policies, a deduped work queue, and a per-day spend ledger. CRUD in
  // `./eval-online.ts`, row types in `./eval-online-types.ts`.
  evalObservations!: Table<EvalObservationRow, string>
  evalOnlinePolicies!: Table<EvalOnlinePolicyRow, string>
  evalOnlineQueue!: Table<EvalOnlineQueueRow, string>
  evalOnlineBudget!: Table<EvalOnlineBudgetRow, string>
  // v82 — Judge calibration loop (eval spec §10). `calibrationItems` holds
  // human-gold-labeled (input, answer) pairs grouped into sets; `calibrationRuns`
  // holds one full agreement report (confusion matrix + Cohen's κ + per-item
  // verdicts) per executed calibration. CRUD in `./calibration-items.ts` and
  // `./calibration-runs.ts`.
  calibrationItems!: Table<CalibrationItemRow, string>
  calibrationRuns!: Table<CalibrationRunRow, string>
  // v87 — Journaled background subagent tasks. A1 keeps execution in the
  // renderer/CLI heap, but records lifecycle transitions here so Job Center and
  // post-reload collect can distinguish done/error/interrupted history.
  backgroundTasks!: Table<BackgroundTaskJournalRow, string>
  // v103 — Agent Team PR feedback observations. See `lib/db/team-pr-observations.ts`.
  teamPrObservations!: Table<TeamPrObservationRow, string>
  // v104 — Agent-Team board projection (one-way store→Dexie mirror for mobile
  // sync). See `lib/db/agent-team-board.ts`.
  agentTeamBoard!: Table<AgentTeamBoardRow, string>
  // v145 — durable local AgentTeam runtime. Never registered for sync/export.
  agentTeamRuns!: Table<import("@/types/agent/agent-team-runtime").AgentTeamRunRecord, string>
  agentTeams!: Table<import("./agent-team-definitions").AgentTeamRow, string>
  agentTeammates!: Table<import("./agent-team-definitions").AgentTeammateRow, string>
  agentTeamTasks!: Table<import("./agent-team-definitions").AgentTeamTaskRow, string>
  agentTeamChildRuns!: Table<import("@/types/agent/agent-team-runtime").AgentTeamChildRun, string>
  agentTeamTrajectory!: Table<
    import("@/types/agent/agent-team-runtime").AgentTeamTrajectoryEvent,
    string
  >
  agentTeamCheckpoints!: Table<
    import("@/types/agent/agent-team-runtime").AgentTeamCheckpoint,
    string
  >
  agentTeamDecisions!: Table<import("@/types/agent/agent-team-runtime").AgentTeamDecision, string>
  agentTeamSteeringReceipts!: Table<
    import("@/types/agent/agent-team-runtime").AgentTeamSteeringReceipt,
    string
  >
  agentTeamEvidence!: Table<import("@/types/agent/agent-team-runtime").AgentTeamEvidence, string>
  agentTeamDeliveryGraphs!: Table<
    import("@/types/agent/agent-team-runtime").AgentTeamDeliveryGraph,
    string
  >
  agentTeamDeliveryNodes!: Table<
    import("@/types/agent/agent-team-runtime").AgentTeamDeliveryNode,
    string
  >
  agentTeamRetrospectives!: Table<
    import("@/types/agent/agent-team-runtime").AgentTeamRetrospective,
    string
  >
  agentTeamContentObjects!: Table<
    import("@/types/agent/agent-team-runtime").AgentTeamContentObject,
    string
  >
  projectEnvironmentVersions!: Table<
    import("@/types/project-environment").ProjectEnvironmentVersion,
    string
  >
  // v132 — Unified Template Platform. Definitions/packages/instance provenance
  // are portable; device bindings and migration journals are intentionally
  // local-only and never registered in `lib/sync`.
  templateDefinitions!: Table<TemplateDefinitionRow, string>
  templatePackages!: Table<TemplatePackageRow, string>
  templateInstances!: Table<TemplateInstanceRecord, string>
  templateDeviceBindings!: Table<TemplateDeviceBindingRecord, string>
  templateMigrationJournal!: Table<TemplateMigrationJournalRecord, string>
  // v88 — Durable WASM preopen grant ledger. See `lib/db/wasm-grant-ledger.ts`.
  wasmGrantLedger!: Table<WasmGrantLedgerRow, string>
  // v89 — Per-turn Run Records (Run Panel). See `lib/db/run-records.ts`.
  runRecords!: Table<RunRecordRow, [string, number]>
  // v90 — Conversation folders. See `lib/db/session-folders.ts`.
  sessionFolders!: Table<SessionFolder, string>
  // v160 — encrypted, target-scoped performance evidence.
  performanceCaptures!: Table<import("@/lib/perf/capture-types").PerformanceCaptureRow, string>
  performanceCaptureChunks!: Table<
    import("@/lib/perf/capture-types").PerformanceCaptureChunkRow,
    string
  >
  performanceCaptureAttachments!: Table<
    import("@/lib/perf/capture-types").PerformanceCaptureAttachmentRow,
    string
  >
  performanceCaptureGaps!: Table<
    import("@/lib/perf/capture-types").PerformanceCaptureGapRow,
    string
  >
  // v162 — local-only Matrix encrypted-event recovery queue. Raw encrypted
  // events never enter account sync/export; the Matrix adapter owns retry and
  // terminal recovery-required state through `matrix-pending-events.ts`.
  matrixPendingEncryptedEvents!: Table<
    import("./matrix-pending-events").MatrixPendingEncryptedEventRow,
    string
  >

  constructor(name = LEGACY_COGNIA_DB_NAME, connectionOwner = "unspecified") {
    super(name)
    if (name.startsWith("cognia-account-")) {
      this.use(createEncryptedContentMiddleware(name))
    }
    this.connectionOwner = connectionOwner
    this.connectionId = `db-${++databaseConnectionSequence}`
    this.connectionCreatedAt = Date.now()
    registerKnownConnection(this)
    this.on("ready", () => {
      registerKnownConnection(this)
      this.logConnectionEvent("open")
    })
    this.on("blocked", () => this.logConnectionEvent("blocked"))

    this.version(CURRENT_SCHEMA_VERSION).stores(CURRENT_SCHEMA)
  }

  // v212 — user-started history backfill runs (project-context mining).
  projectMiningRuns!: Table<import("@/types/memory/governance").ProjectMiningRun, string>

  accountContentMigrations!: Table<
    {
      id: "singleton"
      accountId: string
      status: "pending" | "migrating" | "verified" | "failed"
      completedTables: string[]
      updatedAt: number
      error?: string
    },
    "singleton"
  >

  // v206 — artifacts + their version history (ADR-0158). Authoritative; the
  // Zustand store is the in-memory view. See `lib/db/artifacts.ts`.
  artifacts!: Table<ArtifactRow, string>
  artifactVersions!: Table<ArtifactVersionRow, string>
  // v205 — backlink index (which turns cited which record) + its watermark.
  // Rebuildable derived data; see `lib/db/mention-links.ts`.
  mentionLinks!: Table<import("./mention-links").MentionLinkRow, string>
  mentionLinkState!: Table<import("./mention-links").MentionLinkStateRow, "singleton">
  // v204 — chat result index (what a turn produced) + its backfill watermark.
  // Rebuildable derived data; see `lib/db/chat-result-index.ts`.
  chatResultIndex!: Table<import("./chat-result-index").ChatResultIndexRow, string>
  chatResultIndexState!: Table<import("./chat-result-index").ChatResultIndexStateRow, "singleton">

  // v201 — host-owned external-agent configurations. See
  // `lib/db/external-agent-configs.ts`.
  externalAgentConfigHeads!: Table<ExternalAgentConfigHeadRow, string>
  externalAgentConfigRevisions!: Table<ExternalAgentConfigRevisionRow, string>
  // v193 — saved chat templates. See `lib/db/chat-templates.ts`.
  chatTemplates!: Table<ChatTemplateRow, string>
  // v194 — ADR-0149 identity projection. See `lib/db/identity.ts`.
  users!: Table<User, string>
  orgs!: Table<Org, string>
  orgMemberships!: Table<OrgMembership, string>
  workspaceMemberships!: Table<WorkspaceMembership, string>
  externalIdentities!: Table<ExternalIdentity, string>
  // v195 — ADR-0149 collaboration-plane issue mirror. Rebuildable cache; see
  // `lib/db/collab-issue-mirror.ts`.
  collabIssues!: Table<CollabIssueMirrorRow, string>
  // v197 — ADR-0149 collaboration-plane workspace mirror. Rebuildable cache;
  // see `lib/db/collab-workspace-mirror.ts`.
  collabWorkspaces!: Table<CollabWorkspaceMirrorRow, string>
  // v198 — ADR-0149 collaboration-plane plan and run mirrors. Rebuildable
  // caches; see `lib/db/collab-plan-mirror.ts` and `lib/db/collab-run-mirror.ts`.
  collabPlans!: Table<CollabPlanMirrorRow, string>
  collabRuns!: Table<CollabRunMirrorRow, string>
  // v207 — shared-chat server projections. Never authoritative for access.
  collabChatSessions!: Table<CollabChatSessionMirrorRow, string>
  collabChatMemberships!: Table<CollabChatMembershipMirrorRow, [string, string]>
  collabChatEvents!: Table<CollabChatEventMirrorRow, string>
  collabChatInvites!: Table<CollabChatInviteMirrorRow, string>
  collabChatApprovals!: Table<CollabChatApprovalMirrorRow, string>
  collabChatSyncStates!: Table<CollabChatSyncStateRow, string>
  collabChatAttachments!: Table<CollabChatAttachmentMirrorRow, string>
  // v199 — Browser Companion submission side-notes. See
  // `lib/db/browser-submissions.ts`.
  browserSubmissions!: Table<BrowserSubmissionRow, string>
  // v200 — ADR-0103 two-role cross-host handoff journal. See
  // `lib/db/thread-handoff-tickets.ts`.
  threadHandoffTickets!: Table<ThreadHandoffTicket, [string, string]>
  // v141 — Skill recorder source versions (ADR-0106). Provenance + review
  // edits only; the capture itself lives in the native bundle. See
  // `lib/db/skill-recordings.ts`.
  // v175 — durable host -> target outbound dispatch queue (the mirror of
  // `mobileOutboundQueue`). See `lib/db/host-dispatch-queue.ts`.
  hostDispatchQueue!: Table<HostDispatchJobRow, string>
  skillRecordings!: Table<SkillRecordingRow, string>
  sessionState!: Table<SessionStateRow, string>
  tts_provider_keys!: Table<TtsProviderKeyRow, string>
  openVsxCache!: Table<OpenVsxCacheRow, string>
  vscodeExtensionRuntime!: Table<VscodeExtensionRuntimeRow, string>
  // v109 — user-consent ledger for plugin-shipped binaries; the only thing
  // that can grant a prompt-free spawn. See `lib/db/approved-binaries.ts`.
  approvedBinaries!: Table<ApprovedBinaryRow, [string, string]>
  // v44 — companion sync cursors (Wave 4 / ADR-0026). See `lib/sync/types.ts`.
  // One cursor per host per table (v130), so a client that pairs elsewhere
  // cannot resume from the previous host's watermark. Replaces `syncCursors`,
  // which was keyed by table alone; Dexie cannot change a primary key in
  // place, hence the new name.
  hostSyncCursors!: Table<SyncCursorRow, [string, string]>
  // v62 — Workspaces (project model persistence). See `lib/db/projects.ts`.
  projects!: Table<Project, string>
  // v170 — Issue tracker. NAMING: `projects` above is the WORKSPACE entity;
  // `issueProjects` below is the tracker's delivery container, referenced by
  // `Issue.issueProjectId`. They are not the same thing — see the invariant
  // block in `types/issues/index.ts`. CRUD in `lib/db/issue{s,-projects,
  // -events,-counters}.ts`.
  issues!: Table<Issue, string>
  issueProjects!: Table<IssueProject, string>
  issueEvents!: Table<IssueEvent, string>
  issueCounters!: Table<IssueCounter, string>
  // v170 — Shared coloured-label catalogue, scope-discriminated. Supersedes
  // `conversationLabels` (ids preserved by the v170 upgrade, so existing
  // `labelIds[]` references keep resolving). See `lib/db/labels.ts`.
  labels!: Table<LabelRow, string>
  // v171 — GitHub issue mirror (slice ②). A REBUILDABLE read-through cache,
  // not a source of truth: rows are projected onto the board as read-only
  // federated items and are deliberately excluded from companion sync, since
  // re-fetching is cheaper than reconciling a cache that can drift.
  githubIssueMirror!: Table<GithubIssueMirrorRow, string>
  // v174 — Issue runs (slice ③). Issue-side record of every dispatch to an
  // execution engine; settled by `lib/issues/run/` adapters. Local-only, not
  // companion-synced: the engine rows it points at are not synced either.
  issueRuns!: Table<IssueRun, string>
  // v100 — Project-scoped RAG chunks (workspace knowledge base). See
  // `lib/db/project-chunks.ts` and `@/types/project-knowledge`.
  projectChunks!: Table<ProjectChunk, string>
  // v65 — Autonomous long-term memory. See `lib/db/memories.ts`.
  memories!: Table<Memory, string>
  // v118 — immutable evidence, durable maintenance work, and decision audit.
  memoryEvidence!: Table<MemoryEvidence, string>
  memoryJobs!: Table<MemoryJob, string>
  memoryAuditEvents!: Table<MemoryAuditEvent, string>
  // v163 — Shared Memory/RAG control plane.
  retrievalProfiles!: Table<RetrievalProfileRow, string>
  retrievalGenerations!: Table<RetrievalGenerationRow, string>
  retrievalActivePointers!: Table<RetrievalActivePointerRow, string>
  retrievalJobs!: Table<RetrievalJobRow, string>
  retrievalTraces!: Table<RetrievalTraceRow, string>
  retrievalEncryptedContent!: Table<RetrievalEncryptedContentRow, string>
  retrievalTombstones!: Table<RetrievalTombstoneRow, string>
  retrievalMigrationJournal!: Table<RetrievalMigrationJournalRow, string>
  retrievalRuntimeState!: Table<RetrievalRuntimeStateRow, "global">
  // v61 — companion sync tombstones (deletions). See `lib/sync/tombstones.ts`.
  syncTombstones!: Table<SyncTombstoneRow, [SyncableTable, string]>
  // v49 — Inbox telemetry ring buffer (cap 3000). See `lib/db/inbox-telemetry.ts`.
  inboxTelemetryEvents!: Table<InboxTelemetryEventRow, string>
  behaviorEvents!: Table<BehaviorEventRow, string>
  // v57 — Computer-Use sandbox connections. See `lib/db/sandbox-connections.ts`.
  sandboxConnections!: Table<SandboxConnectionRow, string>
  // v59 — GitHub marketplace-repo sources. See `lib/db/plugin-marketplace-sources.ts`.
  pluginMarketplaceSources!: Table<PluginMarketplaceSourceRow, string>
  // v60 — models.dev catalog cache (singleton). See `lib/db/models-dev-catalog.ts`.
  modelsDevCatalog!: Table<ModelsDevCatalogRow, string>
  // v93 — OpenRouter live-models catalog cache (singleton). See `lib/db/openrouter-catalog.ts`.
  openrouterCatalog!: Table<OpenRouterCatalogRow, string>
  // v67 — Pet subsystem. See `lib/db/pet.ts` and `@/types/pet`.
  petProfile!: Table<PetProfile, "global">
  petCharacterBindings!: Table<PetCharacterBinding, string>
  petActivityLog!: Table<PetActivityRow, number>
  petAchievements!: Table<PetAchievementRecord, string>
  // v94 — Pet item inventory (economy wave). See `lib/db/pet.ts`.
  petInventory!: Table<PetInventoryRow, string>
  // Historical table name retained for schema compatibility; new rows are
  // outbound-only and written through `lib/webhooks/audit.ts`.
  remoteControlAudit!: Table<WebhookAuditEntry, string>
  // Historical, no longer written after the legacy inbound listener removal.
  remoteControlRunStatus!: Table<LegacyRemoteControlRunStatusRow, string>
  // v73 — Pet Live2D models + asset blobs. See `lib/db/pet-models.ts`.
  petModels!: Table<PetModelRow, string>
  petModelFiles!: Table<PetModelFileRow, string>
  // v119 — Codex-compatible v2 sprite pet packs. See `lib/db/pet-sprite-packs.ts`.
  petSpritePacks!: Table<import("./pet-sprite-packs").PetSpritePackRow, string>
  // v74 — Terminal durable history + unattended-exec audit.
  terminalHistory!: Table<TerminalHistoryRow, string>
  unattendedExecAudit!: Table<UnattendedExecAuditRow, string>
  // v139 — Unified action-review receipts (ADR-0102). One durable row per
  // reviewed action across every decision point. See
  // `lib/db/action-review-receipts.ts`.
  actionReviewReceipts!: Table<import("./action-review-receipts").ActionReviewReceiptRow, string>
  // v157 — content-free cross-domain governance ledger. See
  // `lib/db/governance-ledger.ts`.
  governanceDecisions!: Table<import("./governance-ledger").GovernanceDecisionRow, string>
  governanceDecisionEvents!: Table<import("./governance-ledger").GovernanceDecisionEventRow, string>
  governanceEvidence!: Table<import("./governance-ledger").GovernanceEvidenceRow, string>
  governanceLineage!: Table<import("./governance-ledger").GovernanceLineageRow, string>
  governanceConflicts!: Table<import("./governance-ledger").GovernanceConflictRow, string>
  governanceProvenance!: Table<import("./governance-ledger").GovernanceProvenanceRow, string>
  // v158 — generic ExecutionRun retrospectives. AgentTeam legacy rows remain
  // read-only during the compatibility window.
  runRetrospectives!: Table<import("@/types/execution/retrospective").RunRetrospective, string>
  runLearningProposals!: Table<
    import("@/types/execution/retrospective").RunLearningProposal,
    string
  >
  // v140 — Provider diagnostics and balance history.
  providerDiagnosticJobs!: Table<ProviderDiagnosticJob, string>
  providerDiagnosticSamples!: Table<ProviderDiagnosticSample, string>
  providerBalanceSnapshots!: Table<ProviderBalanceSnapshot, string>
  providerDiagnosticsRefreshState!: Table<ProviderDiagnosticsRefreshState, string>
  providerEndpointChanges!: Table<ProviderEndpointChange, string>
  // v75 — Provider cost rollups. See `lib/db/provider-cost-daily.ts`.
  providerCostDaily!: Table<ProviderCostDailyRow, string>
  // v76 — Semantic tool routes. See `lib/db/tool-routes.ts`.
  toolRoutes!: Table<import("@/types/routing/tool-route").ToolRouteRecord, string>
  // v77 — Pet conversation history. See `lib/db/pet-conversation.ts`.
  petConversation!: Table<PetConversationRow, number>
  // v95 — Wiki Lint results (singleton per scope). See `lib/db/wiki-lint-results.ts`.
  wikiLintResults!: Table<import("@/types/wiki").WikiLintResult, import("@/types/wiki").WikiScope>
  // v96 — Attention Radar reports. See `lib/db/radar-reports.ts`.
  radarReports!: Table<import("@/types/radar").RadarReport, string>
  // v97 — Content capture store. See `lib/db/captured-items.ts`.
  capturedItems!: Table<import("@/types/capture").CapturedItem, string>
  // v105 — Fleet agent-monitor session history. See `lib/db/fleet-sessions.ts`.
  fleetSessions!: Table<import("./fleet-sessions").FleetSessionHistoryRow, string>
  // v98 — External Bridge inbound-write review queue. See `lib/db/inbound-drafts.ts`.
  inboundDrafts!: Table<import("./inbound-drafts").InboundDraftRow, string>
  // v142 — accept-side outbox, keyed by draft id so a retried accept
  // overwrites its own row instead of queueing the work twice. See
  // `lib/db/inbound-materializations.ts`.
  inboundMaterializations!: Table<
    import("./inbound-materializations").InboundMaterializationRow,
    string
  >
  // v142 — the `note` materialization target. See `lib/db/knowledge-notes.ts`.
  knowledgeNotes!: Table<import("./knowledge-notes").KnowledgeNoteRow, string>
  // v99 — Inbound gateway durable request log. See `lib/db/gateway-request-log.ts`.
  gatewayRequestLog!: Table<import("@/types/gateway").GatewayRequestLogRow, string>
  // v101 — Optical-compaction archives (ADR-0063). See `lib/db/optical-archives.ts`.
  opticalArchives!: Table<import("./optical-archives").OpticalArchiveRow, string>
  // v108 — Local code-adoption tracking (write-attribution). See `lib/code-adoption/types.ts`.
  codeAdoptionTurns!: Table<import("@/lib/code-adoption/types").CodeAdoptionTurnRow, string>
  // v110 — Recorded browser flows (ADR-0072). See `lib/db/browser-recordings.ts`.
  browserRecordings!: Table<import("./browser-recordings").BrowserRecordingRow, string>
  browserAnnotations!: Table<import("./browser-annotations").BrowserAnnotationRow, string>
  // v117 — host-local remote browser profile and public-domain grants.
  browserProfiles!: Table<import("./browser-profiles").BrowserProfileRow, string>
  browserDomainGrants!: Table<import("./browser-profiles").BrowserDomainGrantRow, string>
  // v144 — device-local project environments and controlled CDP metadata.
  projectEnvironments!: Table<import("@/types/project-environment").ProjectEnvironment, string>
  cdpGrants!: Table<import("@/types/browser-developer").CdpGrant, string>
  cdpAuditEvents!: Table<import("@/types/browser-developer").CdpAuditEvent, string>

  override close(closeOptions?: { disableAutoOpen: boolean }): void {
    if (this.isOpen()) this.logConnectionEvent("close")
    super.close(closeOptions)
    unregisterKnownConnection(this)
  }

  private logConnectionEvent(event: "open" | "close" | "blocked"): void {
    if (process.env.NODE_ENV !== "development") return
    const backend = this.isOpen() ? this.backendDB() : null
    console.debug("[db:connection]", {
      event,
      connectionId: this.connectionId,
      owner: this.connectionOwner,
      databaseName: this.name,
      declaredVersion: this.verno,
      nativeVersion: backend?.version ?? null,
      elapsedMs: Date.now() - this.connectionCreatedAt,
    })
  }
}

// Row types for these tables live next to their CRUD module (or a dedicated
// `*-types.ts` file) per `lib/db/CONVENTIONS.md`. They are re-exported here so
// `@/lib/db/schema` remains the stable import surface for existing call sites.
export type { ModelsDevCatalogRow } from "./models-dev-catalog"
export type {
  ProviderCatalogAliasRow,
  ProviderCatalogModelRow,
  ProviderCatalogOfferingRow,
  ProviderCatalogProviderRow,
  ProviderCatalogRevisionRow,
  ProviderCatalogStateRow,
  ProviderConnectionInventoryRow,
} from "./provider-catalog"
export type { OpenRouterCatalogRow } from "./openrouter-catalog"
export type { SessionStateRow } from "./session-state"
export type { TrustedPublisherRow } from "./trusted-publishers"
export type { TtsProviderKeyRow } from "@cognia/tts/types"
export type {
  OpenVsxCacheRow,
  VscodeExtensionRuntimeRow,
} from "@/types/plugin/vscode-extension-cache"
export type { ApprovedBinaryRow } from "@/types/plugin/approved-binary"
export type { AutomationAuditLogRow } from "@/lib/automation/audit"
export type { WorkflowViewportBookmarkRow } from "@/lib/workflow/editor/viewport-bookmarks-db"
export type { PluginDexieMeta } from "./plugin-types"
export type { EvalRunRow } from "./eval-runs"
export type {
  EvalAdjudicationRow,
  EvalAssetRow,
  EvalConfigurationApplyRow,
  EvalExperimentRow,
  EvalProjectRow,
  EvalRecommendationRow,
  EvalReviewBatchRow,
  EvalReviewVoteRow,
  EvalSampleRow,
  EvalScoreRow,
  EvalTaskRow,
} from "./eval-lab"
export type {
  EvalObservationRow,
  EvalOnlineBudgetRow,
  EvalOnlinePolicyRow,
  EvalOnlineQueueRow,
} from "./eval-online-types"
export type { OpticalArchiveRow, OpticalArchiveFrame } from "./optical-archives"
export type { TeamPrObservationRow } from "./team-pr-observations"
export type { TraceAnnotationRow } from "./trace-annotations"
export type { CalibrationItemRow } from "./calibration-items"
export type { CalibrationRunRow, CalibrationVerdict } from "./calibration-runs"
export type { BackgroundTaskJournalRow } from "./background-tasks"
export type { WasmGrantLedgerRow, WasmGrantSource } from "./wasm-grant-ledger"
export type { RunRecordRow } from "./run-records"
export type { PetModelRow, PetModelFileRow } from "./pet-models"
export type { PetSpritePackRow } from "./pet-sprite-packs"
export type { TerminalHistoryRow } from "./terminal-history"
export type { ProviderCostDailyRow } from "./provider-cost-daily"
export type { UnattendedExecAuditRow } from "./terminal-audit"
export type { ActionReviewReceiptRow } from "./action-review-receipts"
export type {
  GovernanceDecisionRow,
  GovernanceDecisionEventRow,
  GovernanceEvidenceRow,
  GovernanceLineageRow,
  GovernanceConflictRow,
  GovernanceProvenanceRow,
} from "./governance-ledger"
export type { SkillRecordingRow, SkillRecordingStatus } from "./skill-recordings"
export type {
  ConversationLabelRow,
  ConversationAssignmentEventRow,
  AssignmentEventKind,
  CannedResponseRow,
} from "./crm-types"

let _db: CogniaDB | null = null
const _knownConnections = new Map<string, Set<CogniaDB>>()
let _seedPromise: Promise<void> | null = null
let _activeDatabaseName: string | null = null
let _yieldChannel: BroadcastChannel | null = null
let _tauriYieldListening = false
let _tauriYieldUnlisten: (() => void) | null = null
let _yieldOrigin: string | null = null
const _reportedConnectionOwners = new Map<string, Set<string>>()
/** Stops the in-flight blocked-open re-nudge loop, if any (see getDb). */
let _stopBlockedRetry: (() => void) | null = null

function registerKnownConnection(database: CogniaDB): void {
  let connections = _knownConnections.get(database.name)
  if (!connections) {
    connections = new Set()
    _knownConnections.set(database.name, connections)
  }
  connections.add(database)
}

function unregisterKnownConnection(database: CogniaDB): void {
  const connections = _knownConnections.get(database.name)
  if (!connections) return
  connections.delete(database)
  if (connections.size === 0) _knownConnections.delete(database.name)
}

/** Owners of live CogniaDB handles in this renderer realm, for blocked diagnostics. */
export function getOpenDatabaseConnectionOwners(databaseName: string): string[] {
  const connections = _knownConnections.get(databaseName)
  if (!connections) return []
  const owners: string[] = []
  for (const database of connections) {
    if (database.isOpen()) owners.push(database.connectionOwner)
    else connections.delete(database)
  }
  if (connections.size === 0) _knownConnections.delete(databaseName)
  return [...new Set(owners)].sort()
}

/** Interval between yield re-nudges while a schema upgrade stays blocked. */
const BLOCKED_RENUDGE_INTERVAL_MS = 750
/**
 * Cap on re-nudges before giving up. ~15s at the interval above — long enough
 * for a still-booting overlay window to register its yield listener and close,
 * short enough that a genuinely stuck open fails loudly instead of nudging
 * forever.
 */
const BLOCKED_RENUDGE_MAX_ATTEMPTS = 20

/**
 * Cross-context yield coordination for schema upgrades.
 *
 * Native IndexedDB fires `versionchange` on connections that block an
 * upgrade, and our handler below closes the cached db in response — but
 * delivery across WKWebView windows and background-throttled tabs is
 * unreliable. A holder that never receives `versionchange` blocks the upgrade
 * indefinitely ("Upgrade '…' blocked by other connection holding version N").
 *
 * This is not hypothetical on desktop: the main window runs the plugin manager,
 * which bumps the schema past the static ceiling to register plugin Dexie
 * tables, while the pet-overlay / pet-popup / fleet-island webviews render the
 * minimal shell (no plugin manager) and so hold the *base* version open. They
 * share this origin's IndexedDB, so the overlay's stale connection blocks the
 * main window's upgrade and boot hangs on the loading spinner.
 *
 * So the blocked side nudges every other context to yield over TWO channels,
 * because each covers a gap the other leaves:
 *   - a `BroadcastChannel`, which reaches same-process tabs; and
 *   - a Tauri event, which is the ONLY reliable signal across separate
 *     WKWebView windows (BroadcastChannel does not cross Tauri webviews).
 * Each listening context closes its cached connection for that db name and
 * lazily re-opens (at the new version) on its next getDb(). A per-realm
 * `origin` tag lets a window ignore the events it emitted itself — needed for
 * the Tauri path, whose global `emit` echoes back to the sender (unlike
 * BroadcastChannel), so the upgrading context can't yank its own connection.
 */
const DB_YIELD_CHANNEL_NAME = "cognia-db-yield"
const TAURI_DB_YIELD_EVENT = "cognia://db-yield"

interface DbYieldMessage {
  type: "dexie-yield" | "dexie-yield-owners"
  dbName: string
  /** Emitting realm's id, so a window skips the yield events it broadcast. */
  origin: string
  targetOrigin?: string
  connectionOwners?: string[]
}

/** Stable per-realm identity for {@link DbYieldMessage.origin}. */
function yieldOrigin(): string {
  if (_yieldOrigin === null) {
    _yieldOrigin = Math.random().toString(36).slice(2)
  }
  return _yieldOrigin
}

function ensureYieldChannel(): BroadcastChannel | null {
  if (_yieldChannel) return _yieldChannel
  if (typeof BroadcastChannel === "undefined") return null
  try {
    _yieldChannel = new BroadcastChannel(DB_YIELD_CHANNEL_NAME)
    _yieldChannel.onmessage = (event: MessageEvent) => {
      const msg = event.data as DbYieldMessage | undefined
      handleYieldMessage(msg, (reply) => _yieldChannel?.postMessage(reply))
    }
    // Node's BroadcastChannel keeps the event loop alive on its own, so an
    // open yield channel is enough to stop a CLI / brain process from ever
    // exiting — `cognia-agent run` finished its turn and then hung forever.
    // `unref` only drops the loop reference; delivery still works for as long
    // as the process is running for another reason, which is exactly the
    // window in which a cross-context upgrade can need the handshake. Absent
    // in browsers (and in the jsdom stub), hence the guard. Dexie unrefs its
    // own internal BroadcastChannel for the same reason.
    ;(_yieldChannel as { unref?: () => void }).unref?.()
  } catch {
    _yieldChannel = null
  }
  return _yieldChannel
}

/**
 * Register the Tauri-event half of the yield handshake. `versionchange` and
 * `BroadcastChannel` both fail to cross separate WKWebView windows, so an
 * overlay window (pet / fleet-island) holding the base schema version never
 * learns the main window needs to upgrade past it — deadlocking the upgrade and
 * hanging boot. Tauri events DO cross windows, so on a yield request from
 * another window we close our cached connection and lazily re-open at the new
 * version on the next getDb(). Idempotent; no-op off Tauri.
 */
function ensureTauriYieldListener(): void {
  if (_tauriYieldListening || !isTauri()) return
  _tauriYieldListening = true
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<DbYieldMessage>(TAURI_DB_YIELD_EVENT, (event) => {
        const msg = event.payload
        handleYieldMessage(msg, emitTauriYield)
      })
    )
    .then((unlisten) => {
      _tauriYieldUnlisten = unlisten
    })
    .catch(() => {
      // Tauri event API unavailable / mid-teardown — reset so a later getDb()
      // retries. The BroadcastChannel path stays as the best-effort fallback.
      _tauriYieldListening = false
    })
}

function handleYieldMessage(
  message: DbYieldMessage | undefined,
  reply: (message: DbYieldMessage) => void
): void {
  if (!message) return
  if (message.type === "dexie-yield-owners") {
    if (message.targetOrigin !== yieldOrigin()) return
    let owners = _reportedConnectionOwners.get(message.dbName)
    if (!owners) {
      owners = new Set()
      _reportedConnectionOwners.set(message.dbName, owners)
    }
    for (const owner of message.connectionOwners ?? []) owners.add(owner)
    return
  }
  if (message.type !== "dexie-yield" || message.origin === yieldOrigin()) return
  if (!_db || _db.name !== message.dbName) return
  const connectionOwners = getOpenDatabaseConnectionOwners(message.dbName)
  if (connectionOwners.length > 0) {
    reply({
      type: "dexie-yield-owners",
      dbName: message.dbName,
      origin: yieldOrigin(),
      targetOrigin: message.origin,
      connectionOwners,
    })
  }
  closeCachedDb()
}

export function getDatabaseUpgradeBlockerOwners(databaseName: string): string[] {
  return [
    ...new Set([
      ...getOpenDatabaseConnectionOwners(databaseName),
      ...(_reportedConnectionOwners.get(databaseName) ?? []),
    ]),
  ].sort()
}

/** Mirror a yield request onto the Tauri event bus. No-op off Tauri. */
function emitTauriYield(message: DbYieldMessage): void {
  if (!isTauri()) return
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(TAURI_DB_YIELD_EVENT, message))
    .catch(() => {
      // Never let the cross-window nudge throw into the db-open path.
    })
}

function requestOtherConnectionsToYield(dbName: string): void {
  const message: DbYieldMessage = { type: "dexie-yield", dbName, origin: yieldOrigin() }
  try {
    ensureYieldChannel()?.postMessage(message)
  } catch {
    // Channel closed or structured-clone failure — the native versionchange
    // path remains the fallback; never let the nudge itself throw.
  }
  // BroadcastChannel does not reliably cross separate WKWebView windows; the
  // Tauri event does, so the overlay webviews actually release the connection.
  emitTauriYield(message)
}

/**
 * Keep asking other contexts to yield while a schema-upgrade open stays blocked.
 *
 * Native `blocked` fires ONCE. But a holder window that opens its base-version
 * connection — or registers its yield listener — AFTER that single nudge (or
 * drops the cross-window Tauri event, which is unreliable on WKWebView) keeps us
 * blocked forever: `db.open()` never resolves and boot hangs on the loading
 * spinner with an idle CPU. Re-emit on an interval so a late/racing holder still
 * hears us, capped so a genuinely stuck open gives up loudly (`onGiveUp`) rather
 * than nudging forever.
 *
 * Returns a stop handle to call the moment the open succeeds (`ready`) or the
 * connection is torn down (`closeCachedDb`). Exported for unit testing the
 * cadence in isolation from a real IndexedDB block.
 */
export function startBlockedYieldRetry(
  nudge: () => void,
  options: { intervalMs?: number; maxAttempts?: number; onGiveUp?: () => void } = {}
): () => void {
  const intervalMs = options.intervalMs ?? BLOCKED_RENUDGE_INTERVAL_MS
  const maxAttempts = options.maxAttempts ?? BLOCKED_RENUDGE_MAX_ATTEMPTS
  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    if (attempts > maxAttempts) {
      clearInterval(timer)
      options.onGiveUp?.()
      return
    }
    nudge()
  }, intervalMs)
  return () => clearInterval(timer)
}

/**
 * Dexie's "the connection went away under you" rejection. Spelled both ways
 * across Dexie versions, so both are matched.
 */
function isDatabaseClosedError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ""
  if (name === "DatabaseClosedError" || name === "DatabaseClosed") return true
  return err instanceof Error && "cause" in err ? isDatabaseClosedError(err.cause) : false
}

function isTransactionInactiveError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "TransactionInactiveError") return true
  return "cause" in err ? isTransactionInactiveError(err.cause) : false
}

function isDbReopenError(err: unknown): boolean {
  const isPrematureCommit = err instanceof Error && err.name === "PrematureCommitError"
  return isDatabaseClosedError(err) || isTransactionInactiveError(err) || isPrematureCommit
}

/**
 * Backoff before re-issuing an operation a schema mutation killed. The first
 * retry lands inside a typical close→upgrade→open round-trip; the tail covers a
 * bump that has to create stores.
 */
const DB_REOPEN_RETRY_DELAYS_MS = [50, 150, 400, 1000] as const

/**
 * Re-run a Dexie operation that a schema mutation killed mid-flight.
 *
 * This database gets closed out from under in-flight reads by design, from two
 * directions: the yield handshake above (another window needs to upgrade past
 * our version) and — far more often — the plugin table bridge, which registers
 * plugin stores with `close() → version(n).stores(patch) → open()` on the
 * *shared* cached instance (`lib/plugin/dexie/bridge.ts`). Both reject whatever
 * was in flight with `DatabaseClosedError` (inner `TransactionInactiveError`:
 * the IDB transaction is torn down under the pending request).
 *
 * At boot those two collide with the settings read every window makes:
 * `SettingsHydrator` and `PluginRuntimeInitializer` mount as siblings, so
 * `settings.get()` is regularly in flight when the plugin bump closes the
 * connection. The read never ran against a live connection — it isn't a failed
 * read, it's a cancelled one — but the caller saw a rejection and fell back to
 * DEFAULTS for the rest of the session ("settings.load failed
 * DatabaseClosedError"), silently discarding the user's persisted settings.
 *
 * So: re-issue it. `op` MUST re-derive its table handles from `getDb()` on
 * every call — after a yield the cached instance is gone entirely, and after a
 * plugin bump the surviving one is mid-reopen. Only this error class is
 * retried; everything else propagates untouched.
 */
export async function withDbReopenRetry<T>(
  op: () => Promise<T>,
  delaysMs: readonly number[] = DB_REOPEN_RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await op()
    } catch (err) {
      if (attempt >= delaysMs.length || !isDbReopenError(err)) throw err
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]))
    }
  }
}

export function activateAccountDatabase(accountId: string, targetId?: string): void {
  const nextName = targetId
    ? encryptedRuntimeTargetDatabaseName(accountId, targetId)
    : encryptedAccountDatabaseName(accountId)
  const vault = getActiveBrowserVault()
  if (vault?.accountId === accountId) {
    activateAccountContentCipher(vault.createContentCipher(nextName))
  }
  if (_activeDatabaseName === nextName && _db?.name === nextName) return
  _activeDatabaseName = nextName
  closeCachedDb()
}

export function clearAccountDatabaseSelection(): void {
  if (_activeDatabaseName === null && _db?.name === LEGACY_COGNIA_DB_NAME) return
  _activeDatabaseName = null
  closeCachedDb()
}

let _testDbRuntimeUsers = 0

/**
 * Test-only: explicitly allow the singleton Dexie database in a Node Jest
 * environment after fake IndexedDB has been installed. Keeping this as a
 * module-local capability avoids defining `window` and accidentally sending
 * unrelated production modules down their browser-only branches.
 */
export function __enableDbRuntimeForTesting(): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__enableDbRuntimeForTesting() is only available when NODE_ENV=test")
  }
  if (typeof indexedDB === "undefined") {
    throw new Error("__enableDbRuntimeForTesting() requires an IndexedDB implementation")
  }

  // Dexie snapshots its dependencies when the module is evaluated. Node tests
  // commonly import schema.ts before their fixture installs fake-indexeddb, so
  // refresh the dependency slots explicitly instead of relying on import order.
  Dexie.dependencies.indexedDB = indexedDB
  if (typeof IDBKeyRange !== "undefined") Dexie.dependencies.IDBKeyRange = IDBKeyRange

  _testDbRuntimeUsers += 1
  let active = true
  return () => {
    if (!active) return
    active = false
    _testDbRuntimeUsers = Math.max(0, _testDbRuntimeUsers - 1)
  }
}

export function getDb(): CogniaDB {
  // SSR-safe: only instantiate Dexie on the client. Static export still
  // pre-renders pages where `window` is undefined, so we lazy-create.
  const hasExplicitTestRuntime =
    process.env.NODE_ENV === "test" && _testDbRuntimeUsers > 0 && typeof indexedDB !== "undefined"
  if (typeof window === "undefined" && !hasExplicitTestRuntime) {
    throw new Error("getDb() called on the server — wrap usage in a client component")
  }
  if (!_db) {
    _db = new CogniaDB(_activeDatabaseName ?? LEGACY_COGNIA_DB_NAME, "active-singleton")
    ensureYieldChannel()
    ensureTauriYieldListener()
    // Yield to another connection that needs to upgrade the schema. Plugin
    // Dexie tables and second tabs open the same DB name at a higher version;
    // without this handler our connection keeps holding the old version and
    // the other one logs "Upgrade '…' blocked by other connection holding
    // version N" and stalls. Closing + dropping the cache lets the upgrade
    // proceed; the next getDb() re-opens at the new version.
    _db.on("versionchange", () => {
      closeCachedDb()
    })
    // The mirror case: WE are the connection trying to upgrade and something
    // else is holding the old version open. Note Dexie's own constructor-
    // registered "blocked" subscriber still fires alongside this one (its
    // console.warn cannot be suppressed by subscribing), so the noisy default
    // line will appear once; we add context and — because versionchange
    // delivery across WKWebView windows / throttled tabs is unreliable —
    // actively ask other contexts to yield over the BroadcastChannel.
    const opened = _db
    _db.on("blocked", () => {
      _reportedConnectionOwners.delete(opened.name)
      console.info(
        "[db] schema upgrade is waiting for another connection (tab or plugin) to close; it will proceed automatically."
      )
      requestOtherConnectionsToYield(opened.name)
      // `blocked` fires once, but an overlay window (desktop pet / fleet island /
      // a second tab) that opens or registers its yield listener AFTER this
      // nudge — or drops the unreliable cross-window Tauri event — would hold the
      // old version forever and hang boot on the loading spinner. Keep nudging
      // until the upgrade proceeds (the `ready` handler stops us) or the cap is
      // hit, so a stuck open surfaces loudly instead of spinning silently.
      _stopBlockedRetry?.()
      _stopBlockedRetry = startBlockedYieldRetry(
        () => requestOtherConnectionsToYield(opened.name),
        {
          onGiveUp: () => {
            _stopBlockedRetry = null
            console.error(
              "[db] schema upgrade still blocked after retries — another window (desktop pet / fleet island / a second tab) is holding an older database version open. Close the extra window or restart the app."
            )
            // The console line only ever reached developers. From the user's
            // side the app is simply frozen on the loading spinner with an idle
            // CPU, and nothing on screen says which window to close. Raise it so
            // `DbUpgradeBlockedDialog` can.
            dispatchDbUpgradeBlocked({
              databaseName: opened.name,
              attempts: BLOCKED_RENUDGE_MAX_ATTEMPTS,
              connectionOwners: getDatabaseUpgradeBlockerOwners(opened.name),
            })
          },
        }
      )
    })
    // The upgrade landed (or the db opened cleanly): stop any pending re-nudge.
    _db.on("ready", () => {
      _reportedConnectionOwners.delete(opened.name)
      _stopBlockedRetry?.()
      _stopBlockedRetry = null
    })
  }
  return _db
}

/**
 * Replace the active singleton with an unopened instance for a schema repair.
 *
 * WKWebView can stall when Dexie opens an old static schema, closes that same
 * instance, adds a version, and reopens it. Database boot uses a fresh instance
 * so the complete repaired schema is declared before its first open request.
 */
export function recreateActiveDatabaseForSchemaUpgrade(): CogniaDB {
  closeCachedDb()
  return getDb()
}

/**
 * Resolves once the built-in characters/skills/teams have been seeded. UI
 * surfaces that need to render seed rows immediately (the character picker on
 * first launch) can `await` this; everywhere else `useLiveQuery` will pick up
 * the rows reactively as soon as the seed completes.
 */
export function whenSeeded(): Promise<void> {
  if (_seedPromise) return _seedPromise
  const seedTarget = getDb()
  // Seeding is intentionally explicit: database boot first adopts any dynamic
  // plugin stores, then calls this function. Keeping getDb() side-effect-free
  // prevents a settings read from racing a plugin close→upgrade→open cycle.
  _seedPromise = (async () => {
    try {
      const { seedBuiltIns } = await import("./seed")
      await withDbReopenRetry(() => {
        if (_db !== seedTarget) return Promise.resolve()
        return seedBuiltIns()
      })
    } catch (err) {
      // DatabaseClosedError fires when the db is deleted or switched out from
      // under this attempt. The selected database will start its own seed.
      if (isDatabaseClosedError(err)) return
      _seedPromise = null
      console.error("seedBuiltIns failed", err)
      dispatchDiagnostic(
        createDiagnostic("seedFailed", {
          source: "storage",
          message: err instanceof Error ? err.message : String(err),
        })
      )
      throw err
    }
  })()
  return _seedPromise
}

/**
 * Test-only: drop the cached Dexie instance so the next `getDb()` call
 * re-opens a fresh database. Use after `db.delete()` in `beforeEach` blocks
 * — production code must never call this.
 */
export function __resetDbForTesting(): void {
  _activeDatabaseName = null
  closeCachedDb()
  try {
    _yieldChannel?.close()
  } catch {
    // already closed
  }
  _yieldChannel = null
  try {
    _tauriYieldUnlisten?.()
  } catch {
    // already detached
  }
  _tauriYieldUnlisten = null
  _tauriYieldListening = false
  _yieldOrigin = null
  _reportedConnectionOwners.clear()
}

function closeCachedDb(): void {
  _stopBlockedRetry?.()
  _stopBlockedRetry = null
  _db?.close()
  _db = null
  _seedPromise = null
}
