// IndexedDB schema (via Dexie) for cognia-next — the single `CogniaDB`
// instance backing chat, plugins, connectors, workflows, twin, and more.
//
// HARD RULE: never reorder, edit, or delete a historical `version(N).stores()`
// block or its `upgrade()` hook — doing so corrupts live user databases. Only
// ever append a new, higher version. See `lib/db/CONVENTIONS.md` for the data
// layer's ID / timestamp / error-handling / type-location conventions.
//
// Row types co-locate with their CRUD module (or a `*-types.ts` file) and are
// re-exported below so `@/lib/db/schema` stays the stable import surface.

import Dexie, { type Table, type Version } from "dexie"
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
  KnowledgeBase,
  KnowledgeBaseChunk,
  KnowledgeBaseIngestJob,
  KnowledgeBaseSource,
} from "@/types/knowledge-base"
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
import type { NotificationRecord } from "@/types/notifications"
import type { SandboxConnectionRow } from "./sandbox-connections"
import type {
  CanvasDocumentRow,
  CanvasVersionRow,
  CanvasCommentRow,
  CanvasSessionRow,
} from "./canvas-types"
import type { A2UIAppRow, A2UISurfaceRow, A2UITemplateRow, A2UIEventHistoryRow } from "./a2ui-types"
import { buildA2UIBridgeMcpRow, A2UI_BRIDGE_SERVER_NAME } from "@/lib/a2ui/mcp-tool-schemas"
import { dispatchDbUpgradeBlocked } from "./upgrade-blocked-signal"
import { createDiagnostic } from "@cognia/diagnostics"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { allocateUniqueSkillSlug, deriveMigratedSkillSlug } from "@/lib/skills/slug"
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
import { SELF_CORPUS_ID } from "@/types/wiki"
// Pure, import-free digest — safe to call from the v142 `.upgrade()` callback.
import { hashFileHashes } from "@/lib/wiki/manifest-hash"
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
import type {
  WorkflowRow,
  WorkflowRunRow,
  WorkflowRunEventRow,
  WorkflowTriggerRow,
} from "@/types/workflow/visual"
import type {
  WorkflowDeployment,
  WorkflowInvocation,
  WorkflowVersion,
} from "@/types/workflow/deployment"
import {
  createWorkflowVersion,
  workflowDeploymentId,
} from "@/lib/workflow/versioning/version-snapshot"
import type { WorkflowFolder } from "@/types/workflow/folder"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { SessionUsageRow } from "./session-usage"
import type { ChatDraftRow } from "./chat-drafts"
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
import type { CalibrationItemRow } from "./calibration-items"
import type { CalibrationRunRow } from "./calibration-runs"
import type { BackgroundTaskJournalRow } from "./background-tasks"
import type { ContextCommentRow } from "@/types/context-comment"
import { contextCommentRowFromCanvas } from "./context-comments-backfill"
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
import { accountDatabaseName } from "@/lib/accounts/account-db"
import { LEGACY_MIXED_TARGET_ID, runtimeTargetDatabaseName } from "@/lib/runtime/target-registry"
import { rootsFromLegacy } from "@/lib/workspace/roots"
import { isTauri } from "@/lib/platform/detect"
import { backfillProjectScopeV86 } from "./project-scope-backfill"
import { backfillTriggeredBySourceV91 } from "./triggered-by-source-backfill"
import { backfillSessionLineageV131 } from "./session-lineage-backfill"

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

export const LEGACY_COGNIA_DB_NAME = "cognia-claude"

function accountIdFromDatabaseName(databaseName: string): string | null {
  const prefix = "cognia-account-"
  if (!databaseName.startsWith(prefix)) return null
  const scopedName = databaseName.slice(prefix.length)
  const targetSeparatorIndex = scopedName.indexOf("-target-")
  return targetSeparatorIndex === -1 ? scopedName : scopedName.slice(0, targetSeparatorIndex)
}

/**
 * Test-only collapsed schema declaration.
 *
 * Constructing CogniaDB declares 100+ historical `version(N).stores()` blocks,
 * and Dexie eagerly parses every index spec at declaration time. CPU profiling
 * showed that parse dominating unit-suite time: fake-indexeddb suites pay it on
 * every `__resetDbForTesting()` + `getDb()` cycle (~1s+ per construction).
 *
 * Under Jest the first construction in a worker process runs the full chain
 * once, merges the per-version `stores()` deltas into the latest cumulative
 * spec, and caches it on `process` (which — unlike module state — survives
 * Jest's per-suite module registries). Every later construction in that worker
 * declares a single version with the merged spec.
 *
 * This is behavior-preserving for tests because Dexie never runs upgrade hooks
 * when creating a FRESH database — it builds the latest schema directly. The
 * only tests this would break are the ones that deliberately seed an
 * older-version database and open CogniaDB over it to exercise upgrade hooks;
 * those opt out by setting `globalThis.__COGNIA_DB_FULL_SCHEMA__ = true` at
 * the top of the suite (before the first construction).
 *
 * Production never enters this path: it is gated on JEST_WORKER_ID.
 */
interface CollapsedSchemaCache {
  version: number
  stores: Record<string, string>
}

type VersionInternals = Version & {
  _cfg: { version: number; storesSource?: Record<string, string> }
}

function isSchemaCollapseEnabled(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.env?.JEST_WORKER_ID === "string" &&
    // Run-wide kill switch for debugging: COGNIA_DB_FULL_SCHEMA=1 pnpm test
    process.env.COGNIA_DB_FULL_SCHEMA !== "1" &&
    (globalThis as { __COGNIA_DB_FULL_SCHEMA__?: boolean }).__COGNIA_DB_FULL_SCHEMA__ !== true
  )
}

function collapsedSchemaCacheSlot(): { __cogniaCollapsedSchema?: CollapsedSchemaCache } {
  return process as unknown as { __cogniaCollapsedSchema?: CollapsedSchemaCache }
}

/** Merge the declared per-version stores() deltas into the latest cumulative spec. */
function buildCollapsedSchema(db: Dexie): CollapsedSchemaCache | undefined {
  const versions = (db as unknown as { _versions?: VersionInternals[] })._versions
  if (!Array.isArray(versions) || versions.length === 0) return undefined
  const stores: Record<string, string> = {}
  let latest = 0
  for (const v of [...versions].sort((a, b) => a._cfg.version - b._cfg.version)) {
    latest = Math.max(latest, v._cfg.version)
    if (v._cfg.storesSource) Object.assign(stores, v._cfg.storesSource)
  }
  if (latest === 0) return undefined
  return { version: latest, stores }
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
  settings!: Table<AppSettings, "singleton">
  promptPresets!: Table<SystemPromptPreset, string>
  mcpServers!: Table<McpServer, string>
  // v151 — MCP control-plane governance and durable runtime metadata.
  mcpSyncJobs!: Table<McpSyncJob, string>
  mcpCapabilityCache!: Table<McpCapabilityCacheRow, string>
  mcpServerSummaries!: Table<McpServerSummary, string>
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
  conversationLabels!: Table<ConversationLabelRow, string>
  conversationAssignmentEvents!: Table<ConversationAssignmentEventRow, string>
  cannedResponses!: Table<CannedResponseRow, string>
  connectorAttachments!: Table<ConnectorAttachmentRow, string>
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
  // v26 — Per-session unsent composer text (chat drafts). Pure additive, no
  // upgrade hook. Primary key `sessionId` makes upserts trivial; `updatedAt`
  // is indexed so debug surfaces can sort newest-first.
  chatDrafts!: Table<ChatDraftRow, string>
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

  constructor(name = LEGACY_COGNIA_DB_NAME, connectionOwner = "unspecified") {
    super(name)
    this.connectionOwner = connectionOwner
    this.connectionId = `db-${++databaseConnectionSequence}`
    this.connectionCreatedAt = Date.now()
    registerKnownConnection(this)
    this.on("ready", () => {
      registerKnownConnection(this)
      this.logConnectionEvent("open")
    })
    this.on("blocked", () => this.logConnectionEvent("blocked"))

    // Jest fast path: a previous construction in this worker already merged
    // the full version chain — declare only the latest cumulative schema.
    // See the "Test-only collapsed schema" note above the class.
    if (isSchemaCollapseEnabled()) {
      const collapsed = collapsedSchemaCacheSlot().__cogniaCollapsedSchema
      if (collapsed) {
        this.version(collapsed.version).stores(collapsed.stores)
        return
      }
    }

    this.version(1).stores({
      sessions: "id, updatedAt, createdAt",
      messages: "id, sessionId, [sessionId+createdAt]",
      settings: "id",
    })

    // v2 — adds prompt presets and MCP server tables. No upgrade hook needed
    // because we're only adding new stores; existing data is untouched.
    this.version(2).stores({
      sessions: "id, updatedAt, createdAt",
      messages: "id, sessionId, [sessionId+createdAt]",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
    })

    // v3 — characters, skills, teams. Extend session/message indexes for the
    // new lookups (kind/characterId/teamId on sessions, senderId on messages).
    // Built-in seeds are populated on first access via `lib/db/seed.ts`, not
    // in an upgrade hook, so the seeding stays robust across reloads and
    // doesn't fight Dexie's own migration transaction.
    this.version(3).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
    })

    // v4 — sessionState (unread / last-read tracking). Kept separate from the
    // session row so the immutable session metadata isn't churned every time
    // a message arrives.
    this.version(4).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
    })

    // v5 — Team.memberCharacterIds (string[]) → Team.members (TeamMember[]).
    // Indexes are unchanged; only the row shape for `teams` changes. The
    // upgrade hook is idempotent: if a row already has `members[]`, leave it.
    this.version(5)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets: "id, updatedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("teams")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (Array.isArray(row.members)) return
            const ids = Array.isArray(row.memberCharacterIds)
              ? (row.memberCharacterIds as string[])
              : []
            row.members = ids.map((characterId) => ({ characterId }))
            delete row.memberCharacterIds
          })
      })

    // v6 — adds `trustedWorkspaces` for the workspace-trust gate that hooks
    // and project-scoped slash commands consult before running. Pure new
    // table; no upgrade hook needed.
    this.version(6).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
    })

    // v7 — McpServer.appsEnabled: per-agent projection toggles for the
    // multi-agent sync feature (Claude Code / Cursor / VS Code / Codex /
    // Gemini / Windsurf / etc.). Indexes unchanged. The upgrade hook
    // back-fills `{}` for legacy rows so reads don't have to defend against
    // `undefined`; sync code treats the empty object as "not projected
    // anywhere yet".
    this.version(7)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets: "id, updatedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("mcpServers")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.appsEnabled && typeof row.appsEnabled === "object") return
            row.appsEnabled = {}
          })
      })

    // v8 — Skills feature port: adds the `skillResources` table for bundled
    // scripts/refs/assets, and richer indexes on `skills` (category / source
    // / status / lastUsedAt) so the panel UI can filter without scanning the
    // full collection. Existing rows get default values back-filled in the
    // upgrade hook so the new filter dropdowns don't show "(empty)" buckets.
    this.version(8)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets: "id, updatedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
        skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("skills")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (!row.source) {
              row.source = row.isBuiltIn ? "builtin" : "custom"
            }
            if (!row.status) row.status = "enabled"
            if (!row.category) row.category = row.isBuiltIn ? "meta" : "custom"
            if (typeof row.usageCount !== "number") row.usageCount = 0
          })
      })

    // v9 — TTS provider key fallback table (web mode only). Tauri builds use
    // the OS keyring; this table is consulted only when `isTauri()` is false
    // so the user can still configure cloud providers in the browser shell.
    this.version(9).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
    })

    // v10 — `backupHistory` for the data-section's history card. Pure new
    // table; no upgrade hook needed. Indexed by `completedAt` so the panel
    // can sort newest-first with `db.backupHistory.orderBy("completedAt").reverse()`,
    // and by `type` / `success` so we can filter to only auto-backups or
    // failures without scanning the whole table.
    this.version(10).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
    })

    // v11 — Canvas (Monaco-based code/document editor) tables. Pure new
    // tables; no upgrade hook needed. Documents are the primary records;
    // versions/comments/sessions hang off documentId for cascade deletes
    // performed at the CRUD layer (lib/db/canvas-documents.ts).
    this.version(11).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
    })

    // v12 — Preset feature uplift. Existing 5-field rows survive untouched;
    // the upgrade hook back-fills `isBuiltIn=false`, `isFavorite=false`,
    // `usageCount=0`, `sortOrder=0` so newly-added filters/sort indexes don't
    // see "(empty)" buckets. Indexes for the rich-preset section: category
    // (filter chips), sortOrder (manual reorder), lastUsedAt ("Recent" filter),
    // isDefault / isFavorite / isBuiltIn (badge queries). IndexedDB doesn't
    // index booleans reliably across browsers — these flags are stored as-is
    // (no 1/0 coercion) and filtered in memory by the CRUD layer.
    this.version(12)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets:
          "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
        skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
        tts_provider_keys: "id",
        backupHistory: "id, completedAt, type, success",
        canvasDocuments: "id, title, language, type, updatedAt, createdAt",
        canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
        canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
        canvasSessions: "id, documentId, ownerId, createdAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("promptPresets")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.isBuiltIn === undefined) row.isBuiltIn = false
            if (row.isFavorite === undefined) row.isFavorite = false
            if (row.usageCount === undefined) row.usageCount = 0
            if (row.sortOrder === undefined) row.sortOrder = 0
          })
      })

    // v13 — A2UI subsystem tables + the in-process `a2ui-bridge` MCP server
    // row. The new tables are pure additions; characters get an
    // `a2uiEnabled = false` backfill so prompts don't grow until the user
    // explicitly opts in. The MCP row is seeded idempotently by name so
    // re-running the upgrade (test resets, schema rollbacks) is safe.
    this.version(13)
      .stores({
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets:
          "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
        skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
        tts_provider_keys: "id",
        backupHistory: "id, completedAt, type, success",
        canvasDocuments: "id, title, language, type, updatedAt, createdAt",
        canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
        canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
        canvasSessions: "id, documentId, ownerId, createdAt",
        a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
        a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
        a2uiTemplates: "id, name, category, updatedAt, source",
        a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      })
      .upgrade(async (tx) => {
        await tx
          .table("characters")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.a2uiEnabled === undefined) row.a2uiEnabled = false
          })
        const exists = await tx
          .table("mcpServers")
          .where("name")
          .equals(A2UI_BRIDGE_SERVER_NAME)
          .first()
        if (!exists) {
          await tx.table("mcpServers").add(buildA2UIBridgeMcpRow())
        }
      })

    // v14 — Employee Digital Twin tables. Pure additions (no upgrade hook
    // required): the only existing-row migration is the `Character.twinId` /
    // `Character.twinSettings` fields, both of which are TS-optional and
    // schema-less in Dexie (non-indexed) — old rows simply omit them.
    //
    // Indexes are picked for the hot paths the Phase 4-7 code drives:
    //   • `twinSources`  — by twinId+kind/status to power the workbench source
    //                      list, by `fingerprint` for dedupe-on-import.
    //   • `twinChunks`   — by twinId+sourceId for cascade-delete and source
    //                      drilldown, by `vectorDocId` to resolve a vector
    //                      search hit back to its full-text payload.
    //   • `twinProfile`  — 1:1 with twinId; only the lookup index is needed.
    //   • `twinDrafts`   — by twinId+status to render the "needs review"
    //                      queue, by twinId+kind to filter character vs skill.
    //   • `twinJobs`     — by twinId+status for "in-flight" badges; by
    //                      `queuedAt` to drive a FIFO scheduler picker.
    this.version(14).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
    })

    // v15 — Plugin system port. Adds 5 plugin-related tables; existing rows
    // are untouched so no upgrade hook is needed. Indexes mirror Cognia's
    // production schema:
    //   * `plugins` — single-key + status/source/type filters for the
    //     Settings → Plugins list, `lastUsedAt` for "recent" sort, `enabled`
    //     for the activation gate, `*capabilities` (multi-entry) so the
    //     "filter by capability" dropdown stays index-driven.
    //   * `pluginPermissions` — composite primary key on (pluginId, permission)
    //     so the runtime can look up a single decision in O(1) without scanning.
    //     Side indexes on `pluginId` / `permission` / `decision` / `expiresAt`
    //     drive the audit-log UI and TTL sweep.
    //   * `pluginReviews` — composite primary key on (pluginId, id) lets a
    //     single plugin carry many reviews; `rating` and `createdAt` for the
    //     marketplace-tab sorts.
    //   * `pluginAnalytics` — composite primary key on (pluginId, key) so
    //     each (plugin, metric) row is unique and `lastEventAt` indexes
    //     the "recent activity" sort.
    //   * `pluginScheduledJobs` — single-key + `pluginId` / cron / status /
    //     run-time filters so the scheduler executor can pull only the
    //     active rows it needs.
    //
    // The new tables are empty for existing v14 installs; the migration test
    // (Phase 1 verification) asserts every prior row survives the upgrade.
    this.version(15).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
    })

    // v16 — Dual-variant CustomTheme migration. The settings table schema
    // itself doesn't change between v15 and v16 — `customThemes` is a
    // JSON-typed field inside the singleton row, not its own table. The
    // upgrade hook walks each theme and rewrites the legacy `{colors, isDark}`
    // pair to `{tokens: {light, dark}, baseVariant, derivedVariant}`,
    // deriving the opposite variant via OKLCH math (Task 6 — `deriveOppositeVariant`).
    //
    // The legacy fields are preserved on each row for one release so a
    // rollback to v15 doesn't lose data. They will be pruned in a future
    // version once the dual-variant shape has been live for at least one
    // release cycle. The hook is idempotent — already-migrated rows
    // (those with `tokens.light` populated) are skipped.
    this.version(16)
      .stores({
        // SAME as v15. The settings table schema doesn't change; only the
        // blob shape inside the singleton row does.
        sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
        messages: "id, sessionId, [sessionId+createdAt], senderId",
        settings: "id",
        promptPresets:
          "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
        mcpServers: "id, name, enabled",
        characters: "id, name, updatedAt, isBuiltIn",
        skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
        skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
        teams: "id, name, updatedAt, isBuiltIn",
        sessionState: "sessionId, lastReadAt",
        trustedWorkspaces: "path, trustedAt",
        tts_provider_keys: "id",
        backupHistory: "id, completedAt, type, success",
        canvasDocuments: "id, title, language, type, updatedAt, createdAt",
        canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
        canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
        canvasSessions: "id, documentId, ownerId, createdAt",
        a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
        a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
        a2uiTemplates: "id, name, category, updatedAt, source",
        a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
        twinSources:
          "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
        twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
        twinProfile: "&id, twinId",
        twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
        twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
        plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
        pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
        pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
        pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
        pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
      })
      .upgrade(async (tx) => {
        // Lazy-import to avoid loading the OKLCH derivation code (and its
        // ~25 KB culori dep) on the cold path of every db open. Most users
        // never hit this branch — the import only fires during the one-time
        // upgrade transaction.
        const { deriveOppositeVariant } = await import("@/lib/appearance/derive-variant")
        await tx
          .table("settings")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const themes = (row.customThemes ?? []) as Array<Record<string, unknown>>
            for (const t of themes) {
              // Idempotent: skip rows that have already been migrated.
              if (t.tokens && (t.tokens as { light?: unknown }).light) continue
              if (!t.colors) continue
              const baseVariant: "light" | "dark" = t.isDark ? "dark" : "light"
              const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
              const single = t.colors as Record<string, string>
              t.baseVariant = baseVariant
              t.derivedVariant = opposite
              // The legacy `colors` blob is `Partial<ThemeColors>` — older
              // rows may have missing keys. `deriveOppositeVariant` walks
              // `Object.entries(source)` so it handles partial inputs without
              // surfacing `undefined` keys; cast through `unknown` to bypass
              // the strict `ThemeColors` shape check.
              t.tokens = {
                [baseVariant]: single,
                [opposite]: deriveOppositeVariant(
                  single as unknown as Parameters<typeof deriveOppositeVariant>[0],
                  baseVariant
                ),
              }
              // Preserve `colors` and `isDark` for one release for rollback safety.
            }
          })
      })

    // v17 — External Bridge (LLM Wiki + MCP server) tables. Pure additions;
    // no upgrade hook needed (existing rows aren't touched). Indexes match the
    // hot paths in `lib/external-bridge/handlers/*` and `lib/wiki/*`:
    //   • `wikiArticles`  — `&slug` is unique within table (we treat the
    //     slug as the primary lookup key, but use a separate `id` so we can
    //     reuse Dexie's `id` convention from twin tables); `[scope+module]`
    //     drives `wiki_search` filter; `pageRank` is a tie-breaker but
    //     hybrid scoring runs in memory.
    //   • `wikiSections`  — by `articleId` for partial reload; `[articleId+sectionIndex]`
    //     for in-order render.
    //   • `wikiManifest`  — keyed by `scope` (one row per scope).
    //   • `mcpAuditLog`   — by `ts` for newest-first listing; `tool` for
    //     filter; `allowed` for "show only denied" view in Settings.
    this.version(17).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
      wikiArticles: "&id, &slug, scope, module, pageRank, generatedAt, [scope+module]",
      wikiSections: "&id, articleId, [articleId+sectionIndex]",
      wikiManifest: "&scope, lastBuildAt",
      mcpAuditLog: "&id, ts, tool, allowed, [tool+ts]",
    })

    // v18 — Platform Connectors (ADR-0009). Pure additions; no upgrade hook
    // because we don't migrate existing rows. Indexes calibrated to the
    // hot paths in lib/connectors/:
    //   • adapterInstances — by enabled/type for the bus boot list, by displayName for nav.
    //   • platformIdentities — composite [platform+remoteUserId] for cross-platform
    //     identity merge, [adapterId+remoteUserId] for per-adapter directory lookups.
    //   • inboundLedger — composite [adapterId+platformMessageId] for O(1) dedup
    //     check; receivedAt for the LRU prune sweep (cap 10k rows).
    //   • outboundQueue — by conversationKey for FIFO lane lookup, by [conversationKey+createdAt]
    //     for in-order picking, by status / nextAttemptAt for the runner's
    //     "next pending due" query, by idempotencyKey for retry coalescing.
    //   • conversationOverrides — by conversationKey for resolution, by sessionId
    //     for "session → override" lookups when the chat UI binds.
    //   • connectorAudit — by adapterId for per-adapter filter, by [adapterId+at]
    //     for time-ordered scrolling. Capped at 5000 rows by the writer.
    //   • connectorDrafts — by conversationKey + status for "next pending draft",
    //     by [conversationKey+createdAt] for order.
    //   • connectorAttachments — composite [adapterId+remoteRef] for "do I have it",
    //     by adapterId for adapter-scoped cleanup, by mimeType for filters.
    this.version(18).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
      wikiArticles: "&id, &slug, scope, module, pageRank, generatedAt, [scope+module]",
      wikiSections: "&id, articleId, [articleId+sectionIndex]",
      wikiManifest: "&scope, lastBuildAt",
      mcpAuditLog: "&id, ts, tool, allowed, [tool+ts]",
      adapterInstances: "id, type, enabled, displayName, [type+enabled], createdAt, updatedAt",
      platformIdentities:
        "&id, [platform+remoteUserId], [adapterId+remoteUserId], remoteUserId, platform, lastSeenAt",
      inboundLedger: "&id, [adapterId+platformMessageId], adapterId, receivedAt",
      outboundQueue:
        "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status]",
      conversationOverrides: "&id, &conversationKey, sessionId, pinned, archived",
      connectorAudit: "&id, adapterId, kind, at, [adapterId+at]",
      connectorDrafts:
        "&id, conversationKey, sessionId, [conversationKey+createdAt], status, expiresAt",
      connectorAttachments: "&id, [adapterId+remoteRef], adapterId, mimeType, fetchedAt, expiresAt",
    })

    // v19 — Pure index addition: `conversationOverrides` now has `updatedAt`
    // indexed so the Conversations settings tab can drive a `orderBy("updatedAt")`
    // newest-first listing. No upgrade hook needed; existing rows already carry
    // `updatedAt` (set by `lib/db/conversation-overrides.ts`), Dexie just needs
    // the keyPath registered on the object store.
    this.version(19).stores({
      conversationOverrides: "&id, &conversationKey, sessionId, pinned, archived, updatedAt",
    })

    // v20 — Claude subscription usage. One row per snapshot of the
    // `anthropic-ratelimit-unified-*` headers, captured either passively from
    // real chat traffic or actively from the optional probe loop. The collector
    // trims oldest rows over the 1 000-row cap; the Overview / Usage tabs query
    // by `[fetchedAt+source]` for time-windowed views.
    this.version(20).stores({
      subscriptionUsage: "++localId, fetchedAt, status, source, [source+fetchedAt]",
    })

    // v21 — Pure index addition: `outboundQueue` now has `createdAt` indexed
    // standalone so the Outbound settings tab can drive a global newest-first
    // listing via `orderBy("createdAt").reverse()`. The existing
    // `[conversationKey+createdAt]` compound index only supports per-lane
    // ordering and Dexie rejects a standalone `orderBy("createdAt")` against
    // it ("KeyPath createdAt … is not indexed"). No upgrade hook needed —
    // existing rows already carry `createdAt` (set by the writer), Dexie just
    // needs the keyPath registered on the object store.
    this.version(21).stores({
      outboundQueue:
        "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status], createdAt",
    })

    // v22 — Visual workflows (ADR-0011). Pure additions; no upgrade hook
    // because we don't migrate existing rows (no prior workflow data exists).
    // Indexes are calibrated to the hot paths in lib/workflow/ and components/workflow/:
    //   • workflows         — &id is the primary; `name` for the library list
    //                         orderBy("name"), `updatedAt` for "Recently edited",
    //                         `isBuiltIn` / `isTemplate` for the gallery filters,
    //                         `*tags` (multi-entry) for tag-driven discovery,
    //                         `schemaVersion` so the migrator can pick out
    //                         legacy rows without scanning the blob.
    //   • workflowRuns      — &id primary; per-workflow filtering + sort uses
    //                         [workflowId+startedAt] (timeline) and
    //                         [workflowId+status] (status-filter chips). The
    //                         standalone `status` index drives the global
    //                         "Recent runs" tab; `startedAt` is also indexed
    //                         standalone so the same tab can sort newest-first
    //                         across all workflows.
    //   • workflowRunEvents — &id primary; the per-step timeline binds to
    //                         [runId+ts] for in-order render and [runId+stepId]
    //                         to scroll/highlight a specific node's events.
    //                         `type` is indexed for the "errors only" filter.
    //   • workflowTriggers  — &id primary; [workflowId+enabled] is the lookup
    //                         the editor uses to render the trigger pane; the
    //                         standalone `kind` and `cron` indexes power the
    //                         Settings → Defaults overview without scans.
    //                         `nextFireAt` is indexed so the cron preview
    //                         (TS-side) can list the next N firings cheaply
    //                         without re-evaluating every cron expression.
    this.version(22).stores({
      workflows: "&id, name, updatedAt, createdAt, isBuiltIn, isTemplate, *tags, schemaVersion",
      workflowRuns:
        "&id, workflowId, status, startedAt, completedAt, [workflowId+startedAt], [workflowId+status]",
      workflowRunEvents: "&id, runId, [runId+ts], stepId, [runId+stepId], type",
      workflowTriggers: "&id, workflowId, kind, enabled, [workflowId+enabled], cron, nextFireAt",
    })

    // v23 — Mobile companion paired devices. Pure additive; no upgrade hook
    // because no prior pairedDevices data exists. Indexes: `lastSeenAt` for
    // the settings table's newest-first sort and `revokedAt` so the deny-list
    // cache (M2.4) can hydrate from a `where("revokedAt").above(0)` query at
    // server boot without scanning the full table.
    this.version(23).stores({
      pairedDevices: "&deviceId, lastSeenAt, revokedAt, platform",
    })

    // v24 — Per-turn usage + cost rows. Pure additive, no upgrade hook.
    //   • `&messageId`        — primary key (Anthropic assistant message id,
    //                            unique across sessions). put() is idempotent.
    //   • `sessionId`         — equality lookup for per-session aggregations
    //                            and cascade delete in `deleteSession`.
    //   • `[sessionId+at]`    — used by the chat header / sessions tab to
    //                            render rows in chronological order without
    //                            an in-memory sort.
    //   • `at`                — global newest-first listing (audit / debug).
    //   • `model`             — power the per-model breakdown popover.
    this.version(24).stores({
      sessionUsage: "&messageId, sessionId, [sessionId+at], at, model, characterId",
    })

    // v25 — Mobile outbound queue (Wave 2.1, ADR-0015 §Wave 2). Indexes:
    //   • `&id`             — UUIDv4 primary key.
    //   • `status`           — claimNext + listByStatus filter.
    //   • `[status+nextAttemptAt]` — runner picks the next ready row by
    //                          (status="pending", nextAttemptAt <= now).
    //   • `createdAt`        — chronological listing in the queue UI.
    //   • `command`          — "show only chat sends" filters in deadletter view.
    this.version(25).stores({
      mobileOutboundQueue: "&id, status, [status+nextAttemptAt], createdAt, command",
    })

    // v26 — Per-session chat composer drafts (unsent text). Pure additive.
    //   • `&sessionId`  — primary key; upsert by sessionId so each session has
    //                     at most one draft row.
    //   • `updatedAt`   — newest-first listing for debug / data settings.
    this.version(26).stores({
      chatDrafts: "&sessionId, updatedAt",
    })

    // v27 — Plugin Dexie table registry (M0 platform feature).
    //   Tracks which dynamic schema versions have been applied per plugin so
    //   that applyPluginTables can compute the next Dexie version number
    //   without a full db.tables scan, and so that removePluginTables knows
    //   which namespaced table names to drop.
    //   • `&pluginId`   — primary key; one row per plugin.
    //   • `appliedAt`   — debug/audit timestamp.
    this.version(27).stores({
      pluginDexieMeta: "&pluginId, appliedAt",
    })

    // v28 — UI automation audit log. Mirrors `mcpAuditLog` in shape: one row
    // per Rust-side permission-gate evaluation (allow/deny/consent). Cap is
    // enforced in `lib/automation/audit.ts:recordEntry`, not in the schema.
    //   • `&id`         — uuid primary key.
    //   • `ts`          — newest-first listing.
    //   • `surface`     — workflow / computerUse / mcp / plugin filter.
    //   • `decision`    — allow / deny / consent filter (for the "deny only" view).
    //   • `command`     — drill-down by Tauri command name.
    this.version(28).stores({
      automationAuditLog: "&id, ts, surface, decision, command",
    })

    // v29 — Trusted publisher ledger for WASM plugin signed installs.
    //   • `&publicKey`  — base64-encoded Ed25519 public key (primary key
    //                     guarantees one row per author key).
    //   • `fingerprint` — SHA-256 hex of the key for fast lookup in the UI.
    //   • `firstTrustedAt` — epoch ms of first install accept.
    this.version(29).stores({
      trustedPublishers: "&publicKey, fingerprint, firstTrustedAt",
    })

    // v30 — `/goal` command (ADR-0013). Pure additive; no upgrade hook.
    //   • `chatGoals`      — `&id` primary; `sessionId` for "active goal of
    //                         this session" lookups by the composer pill;
    //                         `[sessionId+status]` so the "find the one
    //                         active goal in this session" query is
    //                         index-driven (writer enforces the unique
    //                         constraint, not the index); `status` standalone
    //                         for the global History tab; `characterId` for
    //                         per-character filters; `createdAt` for
    //                         newest-first listing; `updatedAt` for
    //                         live-query refreshes.
    //   • `chatGoalEvents` — `&id` primary; `goalId` for cascade-delete;
    //                         `[goalId+ts]` for in-order Activity render;
    //                         `kind` for kind-filtered audit views;
    //                         `ts` for global newest-first when needed.
    this.version(30).stores({
      chatGoals: "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt",
      chatGoalEvents: "&id, goalId, [goalId+ts], kind, ts",
    })

    // v31 — VS Code extension reuse layer
    // (see ~/.claude/plans/vscode-snug-squid.md).
    //   • `openVsxCache` — 24h TTL metadata cache for Open VSX marketplace
    //     entries. `&extensionId` is the canonical `publisher.name` string,
    //     `fetchedAt` drives the staleness check.
    //   • `vscodeExtensionRuntime` — per-extension runtime telemetry. Cap is
    //     enforced lazily by the row writer (one row per installed extension;
    //     no listing query, just lookups), so no compound index needed.
    this.version(31).stores({
      openVsxCache: "&extensionId, fetchedAt",
      vscodeExtensionRuntime: "&extensionId, lastActivatedAt, lastError, sidecarPid",
    })

    // v32 — Character.enableComputerUse + Character.computerUseSettings (ADR-0020).
    //   No store-shape changes: every new field on `Character` is optional, so
    //   existing rows round-trip unchanged. We still bump the version to give
    //   the next contributor a clean anchor — and to surface in the migration
    //   audit trail that v32 corresponds to the Computer Use completion work.
    this.version(32).stores({})

    // v33 — ADR-0021 WebRTC WAN transport originally added rendezvous
    //   metadata. Current rows carry the public v2 room descriptor and a
    //   native secret reference; private role keys are never stored here.
    //   These are optional non-indexed JSON columns, so no `.stores()` change is
    //   required — IndexedDB stores the extra keys transparently. The
    //   version bump records that pre-v33 rows have neither field and the
    //   transport must therefore treat them as WebRTC-disabled until the
    //   user re-pairs.
    this.version(33).stores({})

    // v34 — Twin registry table. The container row that binds Character →
    // Twin and powers archive/rename/delete from the Twin Selector UI. Pure
    // additive on the schema side; the upgrade hook walks every existing
    // twin* table plus the `characters.twinId` field to ensure a registry
    // row exists for legacy twinIds, so pre-v34 installs with twin data but
    // no registry row land in a coherent state.
    //   • `&id`         — primary key (`twn_*`).
    //   • `updatedAt`   — newest-first listing in the selector.
    //   • `archived`    — boolean filter for the "Show archived" toggle.
    //   • `createdAt`   — debug / data settings sort.
    this.version(34)
      .stores({
        twins: "&id, updatedAt, archived, createdAt",
      })
      .upgrade(async (tx) => {
        const twinsTable = tx.table("twins")
        const existing = new Set((await twinsTable.toArray()).map((t: { id: string }) => t.id))
        const seen = new Set<string>()
        const collectTwinIds = async (tableName: string) => {
          const rows = await tx.table(tableName).toArray()
          for (const row of rows) {
            const id = (row as { twinId?: string }).twinId
            if (id) seen.add(id)
          }
        }
        await collectTwinIds("twinSources")
        await collectTwinIds("twinChunks")
        await collectTwinIds("twinProfile")
        await collectTwinIds("twinDrafts")
        await collectTwinIds("twinJobs")
        const charactersByTwin = new Map<string, { name?: string }>()
        for (const character of await tx.table("characters").toArray()) {
          const id = (character as { twinId?: string }).twinId
          if (id) {
            seen.add(id)
            if (!charactersByTwin.has(id)) charactersByTwin.set(id, character)
          }
        }
        const now = Date.now()
        for (const id of seen) {
          if (!id || existing.has(id)) continue
          const character = charactersByTwin.get(id)
          await twinsTable.add({
            id,
            name: character?.name || id,
            createdAt: now,
            updatedAt: now,
          })
        }
      })

    // v35 — Visual workflow editor viewport bookmarks (Phase 3 of the
    // editor's Flowith-inspired feature track). Indexed columns:
    //   • `&id`                       — primary key (`vb_` + nanoid).
    //   • `workflowId`                — scope filter.
    //   • `[workflowId+createdAt]`    — newest-first dropdown listing.
    this.version(35).stores({
      workflowViewportBookmarks: "&id, workflowId, [workflowId+createdAt]",
    })

    // v36 — OCR result cache (ADR-0024). Indexed columns:
    //   • `&id`         — primary key `${sha256(file)}|${providerId}|${langs}`.
    //   • `providerId`  — per-provider purge in settings.
    //   • `createdAt`   — TTL purge.
    //   • `fileSha`     — "delete every cached result for this file".
    this.version(36).stores({
      ocrResults: "&id, providerId, createdAt, fileSha",
    })

    // v37 — Plugin-skill usage telemetry. Mirrors the per-row
    // `usageCount` / `lastUsedAt` columns on `skills`, but for plugin-
    // contributed runtime skills which have no Dexie row of their own.
    // One row per plugin skill id; the writer `recordPluginSkillUsage`
    // upserts on each chat send that resolves the plugin skill.
    //   • `&pluginSkillId` — primary key (the plugin's skill id string).
    //   • `lastUsedAt`     — newest-first listing in plugin telemetry UIs.
    //   • `pluginId`       — bulk-purge on plugin uninstall.
    this.version(37).stores({
      pluginSkillUsage: "&pluginSkillId, lastUsedAt, pluginId",
    })

    // v38 — A2UI ⇄ IM connector bridge support.
    //
    //   • `inboundLedger` gains a `namespace` field so the same dedup
    //     ledger can serve inbound messages AND connector callbacks (Slack
    //     block_actions / Lark card actions / Telegram callback_query /
    //     Discord component interactions). The compound index
    //     `[adapterId+namespace+platformMessageId]` replaces the v18
    //     `[adapterId+platformMessageId]` so lookups remain O(1). The
    //     upgrade hook backfills `namespace = "inbound"` on every legacy
    //     row so the new query path still finds them.
    //
    //   • `connectorCallbackBindings` is a new table — one row per
    //     (adapter, A2UI surface, component, platform action_id). Written
    //     by the platform-specific A2UI mapper at outbound send; read by
    //     the adapter parser when a callback arrives so the bus can route
    //     it back to the right surface/component without re-parsing the
    //     outbound payload. Indexed by `[adapterId+actionId]` for O(1)
    //     callback-arrival lookup, by `surfaceId` for surface-scoped
    //     cleanup (e.g., when an A2UI surface is destroyed), and by
    //     `createdAt` for LRU prune.
    //
    //   • `adapterInstances` gains an in-row `lastKnownCapabilities`
    //     column written at adapter start — no index change because the
    //     resolver always loads the row by primary key.
    this.version(38)
      .stores({
        inboundLedger:
          "&id, [adapterId+namespace+platformMessageId], adapterId, receivedAt, namespace",
        connectorCallbackBindings:
          "&id, [adapterId+actionId], adapterId, surfaceId, conversationKey, createdAt, expiresAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("inboundLedger")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.namespace !== "string") {
              row.namespace = "inbound"
            }
          })
      })

    // v39 — VS Code-extension LSP binary trust seed (Phase A of the LSP
    // reuse work). Pre-populates `trustedPublishers` with the public
    // signing keys of mainstream extension publishers (Microsoft, rust-
    // lang, golang, palantir, python-lsp, openvsx, dbaeumer, ms-python,
    // eamodio) so users don't get prompted on every spawn of well-known
    // LSP binaries. Idempotent: existing user-trusted rows are never
    // overwritten; placeholder rows from this seed are replaced when a
    // future release ships verified fingerprints. See
    // `lib/db/seed/trusted-publishers.ts`.
    this.version(39).upgrade(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { seedTrustedPublishers } = require("@/lib/db/seed/trusted-publishers") as {
        seedTrustedPublishers: (
          tx: unknown
        ) => Promise<{ inserted: number; updated: number; skipped: number }>
      }
      await seedTrustedPublishers(tx as unknown as Parameters<typeof seedTrustedPublishers>[0])
    })

    // v40 — Computer Use chat-side dispatch completeness (ADR-0020 addendum
    //   2026-05-18). Two additive fields:
    //     • `Character.computerUseSettings.chatConsentMode` — controls the
    //       chat-side canUseTool modal cadence ("always-ask" | "session-grant"
    //       | "auto"). Defaults to "always-ask" when unset.
    //     • `ClickOpts.count` — number of consecutive clicks (1/2/3). Used
    //       by Anthropic `triple_click` actions. Backwards-compatible — the
    //       existing `double` field still wins when `count` is unset.
    //   No store-shape changes; both fields are optional on existing rows.
    this.version(40).stores({})

    // v41 — IM connector complete gap closure (ADR-0009 v41, im-a2ui-warm-
    //   eclipse plan). One migration bundles five additive changes; no
    //   table is dropped, no column is renamed, no row is rewritten beyond
    //   the connectorCallbackBindings `kind` backfill and the
    //   outboundQueue `source` backfill.
    //
    //   • `connectorCallbackBindings` gains a `kind` discriminator
    //     ("callback_query" | "force_reply" | "modal_open" | "block_action")
    //     so the bus can route inbound platform callbacks to the right
    //     correlation path. Adds `kind` as a non-compound index so the
    //     LRU prune + maintenance UIs can do per-kind filters. Rows
    //     persisted before v41 backfill to `"callback_query"` (the only
    //     case the v38 schema supported).
    //
    //   • `outboundQueue.source` (enum: "ai-run" | "manual" | "workflow" |
    //     "draft-approved") + optional `sourceWorkflow` triple — captures
    //     job provenance so the inbox UI can render a workflow badge and
    //     so audit log queries can drill down on origin. Rows persisted
    //     before v41 backfill to `"ai-run"` because that's the only path
    //     that existed when they were created. No index change (filter
    //     column).
    //
    //   • `conversationOverrides` gains `providerOverride?: string` +
    //     `modelOverride?: string`. Both are filter-only columns on this
    //     small per-conversation table, so no index change is needed.
    //
    //   • `adapterInstances` gains `implMetadata?: {impl, version,
    //     features}` — populated by adapter startup probes (OneBot
    //     `get_version_info`, Slack `auth.test`, etc.). No index change.
    //
    //   • `automationAuditLog.conversationKey?: string` — so the inbox's
    //     computer-use HITL strip can filter to the conversation that
    //     drove the action. Index `conversationKey` so the filter is
    //     selective.
    this.version(41)
      .stores({
        connectorCallbackBindings:
          "&id, [adapterId+actionId], adapterId, kind, surfaceId, conversationKey, createdAt, expiresAt",
        automationAuditLog: "&id, ts, surface, decision, command, conversationKey",
      })
      .upgrade(async (tx) => {
        await tx
          .table("connectorCallbackBindings")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.kind !== "string") {
              row.kind = "callback_query"
            }
          })
        await tx
          .table("outboundQueue")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.source !== "string") {
              row.source = "ai-run"
            }
          })
      })

    // v42 — Workflow proposal history (Changelog tab). One row per
    //   terminal applied / discarded proposal. `id` is `${proposalId}:
    //   ${status}`; per-workflow listing keys on `[workflowId+createdAt]`
    //   for newest-first reads. Capped at 50 per workflow by
    //   `lib/workflow/editor/proposal-history.ts`.
    this.version(42).stores({
      workflowProposalHistory: "&id, workflowId, createdAt, [workflowId+createdAt]",
    })

    // v43 — Built-in skills tier + lark-cli bridge (ADR-0026).
    //
    //   All changes are additive optional columns; no index is added,
    //   no table is created, no row is rewritten:
    //
    //   • `connectorCallbackBindings.payload?: Record<string, unknown>` —
    //     free-form structured payload the bus passes to kind-specific
    //     dispatchers. Used by the new `kind: "skill_invoke"` to carry
    //     `{skillId, args}` from confirm-card outbound to inbound
    //     callback so the skill re-fires with HITL bypass.
    //   • `connectorCallbackBindings.kind` enum widened to include
    //     `"skill_invoke"` (no schema declaration needed — `kind` is
    //     already an index column at v41 and Dexie filter-only at that
    //     level; the wider union is purely a type-level change).
    //   • `conversationOverrides.allowedBuiltInSkillIds?:
    //     string[] | "all"` and `requireHitlForWrites?: boolean` — per-
    //     channel gating for the built-in skill tier. Filter-only
    //     columns; no index.
    //   • `adapterInstances.lastKnownSkillCapabilities?:
    //     readonly PlatformSkillCapability[]` — sibling of the existing
    //     `lastKnownCapabilities` A2UI matrix cache. Written at adapter
    //     start by adapters that expose built-in skill families
    //     (Lark in v1). Filter-only; no index.
    //
    //   Pre-v43 rows that lack these fields are interpreted by the
    //   resolver as "fall back to per-skill defaults" / "no skill
    //   capabilities cached" — no backfill needed.
    this.version(43).stores({})

    // v44 (Wave 4 / ADR-0026) — persistent cursors for the companion sync
    // orchestrator. Previously `stateMap` lived only in memory, so a cold
    // start re-pulled every table from `since: 0`. With this table the
    // mobile shell resumes from the last successful cursor across app
    // restarts. Primary key `&table` enforces one row per syncable table.
    // Pure additive — no upgrade hook needed; pre-v44 installs start with
    // an empty cursor table and the orchestrator falls back to `since: 0`.
    this.version(44).stores({ syncCursors: "&table, lastSyncAt, since" })

    // v45 — IM connector Lark-first completeness pass (im-refactored-crayon
    //   plan). Pure additive optional columns on `adapterInstances`; no
    //   index changes, no row rewrites, no upgrade hook.
    //
    //   • `atResponseStrategy?: "always" | "mention_only" | "direct_only"` —
    //     gates inbound Lark messages in `dispatchEnvelope` via the new
    //     `lib/connectors/adapters/lark/at-gate.ts:shouldRespondToMessage`.
    //     Rows without the field behave as `"mention_only"` (the safer
    //     default for new Lark adapters); DMs (`chatType === "p2p"`) always
    //     bypass the strategy regardless.
    //   • `chatAllowlist?: string[]` / `chatBlocklist?: string[]` — same
    //     gate. Allowlist non-empty means "only these chat_ids may respond";
    //     blocklist hit means "never respond here".
    //   • `lastWhoamiAt?: number` + `lastWhoamiResult?` — cached bot
    //     identity probe written by
    //     `lib/connectors/adapters/lark/whoami.ts:probeBotIdentity`. The
    //     Settings Lark detail panel renders it so the operator can
    //     confirm "connected to the right bot" without a second click.
    //   • `userTokenStoredAt?: number` — flag indicating when an OAuth
    //     user-access-token was persisted to the keyring under
    //     `<adapterId>:user_token`. Used by the OAuth card to show
    //     "Connected as <user>" vs "Connect with Lark".
    //
    //   None of these fields are indexed (all are filter-only blobs read
    //   from the adapter row by primary key), so the bump is `stores({})`.
    this.version(45).stores({})

    // v46 — companion pause/resume affordance on `pairedDevices`. Adds an
    //   optional `pausedAt?: number` column read by the Settings UI to
    //   distinguish "temporarily blocked, can be resumed" from "revoked,
    //   biometric required to undo". The Rust deny-list is what actually
    //   enforces the block (paused devices are added to the same deny-list
    //   as revoked ones, then removed on resume) — `pausedAt` is purely
    //   the persistence layer's record of "why" it's in the deny-list, so
    //   no new index is needed. Pure additive; no upgrade hook.
    this.version(46).stores({})

    // v47 — Appearance optimization (ADR-0029). Adds optional fields to the
    //   `settings` singleton row: `density`, `radius`, `motion`,
    //   `typographyExt`, `a11y`, `autoMode`, `monacoLink`, `activeThemePackId`,
    //   `customCssScope`. All fields are optional in `AppSettings`; the
    //   appliers consume the defaults from `@/types/appearance` when missing.
    //   Pure additive — no upgrade hook needed; lazy backfill happens in the
    //   appliers / settings selectors rather than during DB upgrade so the
    //   Dexie callback stays non-blocking.
    this.version(47).stores({})

    // v48 — Character pack overlay capability (ADR-0030). Adds four optional
    //   non-indexed fields to `characters` rows: `sourcePluginId`,
    //   `sourcePackId`, `clonedFromPackCharacterId`, `packVersionAtClone`. The
    //   fields are populated only when a user duplicates a plugin-overlay
    //   character into a Dexie row, so existing rows remain valid with all
    //   four undefined → treated as "user-created" by the badge logic. Pure
    //   additive — no upgrade hook, no index change.
    this.version(48).stores({})

    // v49 — Inbox optimization pass (plan: inbox-fluttering-tome).
    //
    //   1. `messages` gains a denormalized, indexed `platformMessageId`
    //      column populated from `metadata.platformMessage.messageId`. The
    //      column lets `ConnectorBus.applyMessageEdit` / `applyMessageDelete`
    //      replace a full-table `.toArray().find()` scan with an indexed
    //      `where("platformMessageId").equals(id).first()`. A platform
    //      safety filter at call-site prevents cross-platform collisions
    //      (Telegram messageId=12345 vs Discord messageId=12345).
    //
    //   2. New `inboxTelemetryEvents` ring-buffer table (cap 3000) backs
    //      the `lib/telemetry/inbox-events.ts` breadcrumb layer. Decoupled
    //      from `connectorAudit` so high-volume telemetry rotation does
    //      not displace the operator-visible 5000-row audit window.
    //
    //   Upgrade hook backfills `platformMessageId` once per row from the
    //   existing metadata. Streams via `toCollection().modify` so large
    //   mailboxes don't load all rows at once.
    this.version(49)
      .stores({
        messages: "id, sessionId, [sessionId+createdAt], senderId, platformMessageId",
        inboxTelemetryEvents: "&id, kind, at, adapterId, conversationKey",
      })
      .upgrade(async (tx) => {
        await tx
          .table("messages")
          .toCollection()
          .modify((row) => {
            const pmid = (row as { metadata?: { platformMessage?: { messageId?: unknown } } })
              ?.metadata?.platformMessage?.messageId
            if (typeof pmid === "string" && pmid.length > 0) {
              ;(row as { platformMessageId?: string }).platformMessageId = pmid
            }
          })
      })

    // v50 — Built-in characters → first-party character pack (ADR-0030
    //   Amendment, 2026-05-23). The six `char_builtin_*` rows pre-v50 were
    //   app-seeded with no `sourcePluginId`. The `cognia-builtin-characters`
    //   first-party plugin now ships those personas as overlay-registry
    //   entries; this upgrade tags the legacy Dexie rows so the new
    //   `clone-hides-overlay` dedupe rule in `listCharacters` treats them
    //   as user clones of the overlay characters. User customisations are
    //   preserved verbatim — only attribution fields are added.
    //
    //   `pristineSnapshot` is NOT backfilled here: the plugin manager
    //   hasn't booted yet at upgrade time, so the overlay registry is
    //   empty and we'd have nothing to compare against. The post-boot
    //   `seedBuiltInCharacters` runs a second-pass backfill once the
    //   plugin is active. Rows that fall through that window degrade
    //   gracefully — `applyPackUpdate` uses the "no baseline" path and
    //   surfaces a warning in the confirm dialog.
    //
    //   No store-shape change (every new field is optional non-indexed)
    //   so the upgrade hook only mutates rows — Dexie still requires an
    //   empty `.stores({})` to register the version number.
    this.version(50)
      .stores({})
      .upgrade(async (tx) => {
        const legacyMap: Record<string, string> = {
          char_builtin_coding: "coding",
          char_builtin_writer: "writer",
          char_builtin_research: "research",
          char_builtin_brainstorm: "brainstorm",
          char_builtin_translator: "translator",
          char_builtin_goal_tracker: "goal-tracker",
        }
        await tx
          .table("characters")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const localId = legacyMap[row.id as string]
            if (!localId) return
            if (row.sourcePluginId) return
            row.sourcePluginId = "cognia-builtin-characters"
            row.sourcePackId = "builtin"
            row.clonedFromPackCharacterId = `cognia-pack:cognia-builtin-characters:builtin:${localId}`
            row.packVersionAtClone = "1.0.0"
          })
      })

    // v51 — Connector recurring-work performance hardening. Pure additions
    // (two compound indexes + one table); no upgrade hook because existing
    // rows already carry the indexed fields, mirroring the v19/v21 pattern.
    //   • outboundQueue [status+nextAttemptAt] — lets the runner pick the
    //     next due job (and peek the next retry deadline) via an index range
    //     instead of a full-table `.filter()` scan.
    //   • connectorAudit [adapterId+kind+at] — lets the passive heartbeat
    //     read "last inbound.received for this adapter" as a pure index
    //     lookup instead of an `at`-range scan + JS `kind` filter.
    //   • connectorHeartbeats — dedicated heartbeat table (see field doc).
    this.version(51).stores({
      outboundQueue:
        "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status], createdAt, [status+nextAttemptAt]",
      connectorAudit: "&id, adapterId, kind, at, [adapterId+at], [adapterId+kind+at]",
      connectorHeartbeats: "&id, adapterId, [adapterId+at], at",
    })

    // v52 — Workflow library folders + the `folderId` index on workflows
    // (ADR-0011 library upgrade). `workflowFolders` is a new additive table.
    // The `workflows` keyPath re-declares its full index list with the added
    // `folderId` so the library can range-query a folder's contents.
    //   • workflowFolders — &id primary; `parentFolderId` and the compound
    //                       [parentFolderId+name] drive the "children of folder
    //                       X, sorted by name" query that renders a folder's
    //                       sub-folders without a scan; `updatedAt`/`createdAt`
    //                       for debug/data views.
    //   • workflows.folderId — equality lookup for "workflows in folder X".
    //
    // The upgrade hook backfills every pre-existing row to the root sentinel
    // ("root"). This is REQUIRED: IndexedDB does not index `undefined`, so
    // without the backfill the library's `where("folderId").equals("root")`
    // read would never see legacy workflows.
    this.version(52)
      .stores({
        workflows:
          "&id, name, updatedAt, createdAt, isBuiltIn, isTemplate, *tags, schemaVersion, folderId",
        workflowFolders: "&id, name, parentFolderId, [parentFolderId+name], updatedAt, createdAt",
      })
      .upgrade(async (tx) => {
        await tx
          .table("workflows")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.folderId === undefined) row.folderId = "root"
          })
      })

    // v53 — Goal template library (ADR-0019 Phase 2). Additive table only;
    // no data migration (all new GoalConfig/GoalDefaults fields are optional
    // and round-trip on existing chatGoals rows). Built-in templates are
    // seeded on access (see `lib/goal/seed-templates.ts`). `sortOrder` drives
    // the picker order; `updatedAt`/`createdAt` for data views. Booleans are
    // filtered in-memory (the v12 promptPresets precedent).
    this.version(53).stores({
      goalTemplates: "&id, builtin, isFavorite, sortOrder, updatedAt, createdAt",
    })

    // v54 — public share links. Additive only; no upgrade hook. `code` is
    // unique; `createdAt` drives the newest-first list; `expiresAt` powers the
    // expired-row prune. `revoked` (boolean) is filtered in-memory, not indexed.
    this.version(54).stores({
      sharedLinks: "&id, &code, kind, createdAt, expiresAt",
    })

    // v55 — Agent-trace span rows. Additive only; no upgrade hook. Indexes:
    // `sessionId` and `[sessionId+startTime]` drive the per-session timeline
    // query; `traceId` and `[traceId+startTime]` drive the trace-grouped
    // detail view; `parentSpanId` lets the renderer pull child spans
    // without scanning; `surface` is filterable so the Settings →
    // Observability → Agent Trace tab can scope to one origin.
    this.version(55).stores({
      agentTraces:
        "&id, sessionId, [sessionId+startTime], traceId, [traceId+startTime], parentSpanId, surface",
    })

    // v56 — Workflow run fan-out subscriptions (im-a2ui-abstract-anchor
    // Phase 7). One row per "mirror progress for workflow X into channel
    // (adapter, conversation)". Additive only — no upgrade hook because
    // no pre-existing rows could carry this shape. Indexes:
    //   • `&id`               — uuid primary
    //   • `workflowId`        — runtime hot path: the progress-runner
    //                            queries by workflowId at watcher
    //                            creation to seed the fan-out channels.
    //   • `[workflowId+enabled]` — same query filtered to live rows so
    //                            the runner skips disabled subscriptions
    //                            without an in-memory pass.
    //   • `enabled`           — global "all live mirrors" view in
    //                            settings.
    //   • `adapterId` + `conversationKey` — the operator-side "what does
    //                            this channel mirror?" lookup.
    //   • `createdAt`         — newest-first sort in the settings list.
    this.version(56).stores({
      workflowFanoutSubscriptions:
        "&id, workflowId, [workflowId+enabled], enabled, adapterId, conversationKey, createdAt",
    })

    // v57 — Computer-Use sandbox connection registry (ADR-0020 remote-target
    // addendum). One row per cua desktop sandbox. Additive only — no upgrade
    // hook (no pre-existing rows carry this shape). Indexes:
    //   • `&id`        — uuid primary; the value target selectors reference.
    //   • `name`       — settings-list lookups.
    //   • `createdAt`  — newest-first sort in the Sandbox Connections tab.
    //   • `updatedAt`  — data views.
    this.version(57).stores({
      sandboxConnections: "&id, name, createdAt, updatedAt",
    })

    // v58 — add the `[twinId+fingerprint]` compound index to `twinSources` so
    // import-time dedup (`findTwinSourceByFingerprint`) is a direct compound
    // lookup instead of a full `fingerprint` index scan + JS `twinId` filter.
    // Additive index only — Dexie builds it on upgrade; no data migration.
    this.version(58).stores({
      twinSources:
        "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status], [twinId+fingerprint]",
    })

    // v59 — GitHub "marketplace repo" sources (Claude-Code-style plugin
    // dispatch). One row per added catalog repo. Additive only; no upgrade
    // hook. Indexes: `&id` (owner/repo[@ref] primary), `addedAt` (newest-first
    // list in the manage-sources dialog).
    this.version(59).stores({
      pluginMarketplaceSources: "&id, repoRef, addedAt",
    })

    // v60 — models.dev provider/model catalog cache. Single "singleton" row
    // holding the normalized catalog (keyed by our provider ids) + fetch
    // timestamp. Bundled snapshot seeds it on first run; runtime sync refreshes
    // it. See `lib/db/models-dev-catalog.ts` + `lib/ai/providers/models-dev-sync.ts`.
    this.version(60).stores({
      modelsDevCatalog: "&id, fetchedAt",
    })

    // v61 — Companion sync completeness pass (chat / workflow / settings).
    //   1. `syncTombstones` — new table recording desktop deletions so the
    //      `sync_pull` delta can carry `deleted_ids` (V1 always sent `[]`,
    //      leaving deleted rows orphaned on paired phones). Compound PK
    //      `[table+id]`; `table` + `deletedAt` indexed for per-table reads
    //      and the boot-time retention prune (`lib/sync/tombstones.ts`).
    //   2. `messages` gains a `[createdAt+id]` compound index so the desktop
    //      sync source can page chat history by creation order instead of
    //      scanning the whole table and capping at the newest 200 (see
    //      `desktop-sync-source.ts:readMessagesDelta`). Pure index addition
    //      on existing rows — no upgrade hook needed.
    this.version(61).stores({
      syncTombstones: "[table+id], table, deletedAt",
      messages: "id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id]",
    })

    // v62 — Workspaces. The `useProjectStore` project model gains durable
    // persistence (was in-memory only). One row per workspace, keyed by `id`;
    // `lastAccessedAt` indexed for recency ordering. The active-workspace
    // pointer lives on the settings singleton, not here. See
    // `lib/db/projects.ts`. Additive — no upgrade hook.
    this.version(62).stores({
      projects: "&id, isArchived, lastAccessedAt",
    })

    // v63 — Drop the `isArchived` index. `isArchived` is a JS boolean, and
    // IndexedDB cannot index boolean keys (only number/string/Date/binary and
    // arrays of those), so the index never populated — a `where("isArchived")`
    // query would silently match nothing. All callers already filter archived
    // state in memory (`getAllProjects().filter(...)`), so this just removes a
    // dead, footgun index. Data is preserved; only the index definition changes.
    this.version(63).stores({
      projects: "&id, lastAccessedAt",
    })

    // v64 — Agent evaluation subsystem. Additive only; no upgrade hook (no
    // pre-existing rows carry these shapes). Indexes:
    //   • evalDatasets    — `&id` primary; `capability` for the per-capability
    //                       dataset list; `updatedAt` for newest-first sort.
    //   • evalCases       — `&id` primary; `datasetId` + `[datasetId+createdAt]`
    //                       for in-order per-dataset listing; `capability` and
    //                       `failureMode` for the error-analysis filters;
    //                       `sourceTraceId` to dedupe "save as eval case".
    //   • evalRuns        — `&runId` primary (the report IS the row); `datasetId` +
    //                       `[datasetId+createdAt]` for the per-dataset trend
    //                       chart; `createdAt` for the global recent-runs view.
    //   • traceAnnotations— `&id` primary; `traceId` (one annotation per trace)
    //                       and `sessionId` for the panel; `failureMode` for the
    //                       taxonomy roll-up; `createdAt` for newest-first.
    this.version(64).stores({
      evalDatasets: "&id, capability, updatedAt, createdAt",
      evalCases: "&id, datasetId, [datasetId+createdAt], capability, failureMode, sourceTraceId",
      evalRuns: "&runId, datasetId, [datasetId+createdAt], createdAt",
      traceAnnotations: "&id, &traceId, sessionId, failureMode, createdAt",
    })

    // v65 — Autonomous long-term memory. Additive only; no upgrade hook (no
    // pre-existing rows carry this shape). One table holds all three memory
    // types (semantic/episodic/procedural). Indexes:
    //   • `scope` / `type` / `characterId`     — panel grouping + scope-union retrieval.
    //   • `status`                             — retrieval filters to `active` only.
    //   • `lastAccessedAt`                     — recency factor + access-time expiry.
    //   • `vectorDocId`                        — reverse lookup on vector cleanup.
    //   • `sourceSessionId`                    — provenance "jump to source".
    //   • `pinned`                             — eviction exemption.
    //   • `[scope+type]` / `[scope+status]` / `[type+status]` — composite reads.
    // See `lib/db/memories.ts` and `@/types/memory/memory`.
    this.version(65).stores({
      memories:
        "&id, scope, type, characterId, status, lastAccessedAt, vectorDocId, sourceSessionId, pinned, [scope+type], [scope+status], [type+status]",
    })

    // v66 — Multi-root workspaces. `Project.roots` becomes the source of truth;
    // backfill it from the legacy rootDir/additionalDirs mirrors. Store string
    // unchanged (`roots` lives in the row, not indexed).
    this.version(66)
      .stores({ projects: "&id, lastAccessedAt" })
      .upgrade(async (tx) => {
        await tx
          .table("projects")
          .toCollection()
          .modify((p) => {
            backfillRootsForRow(p as Project)
          })
      })

    // v67 — Pet subsystem (virtual companion). Additive only; no upgrade hook.
    //   • petProfile           — singleton (id="global"); identity Soul + nurture state.
    //   • petCharacterBindings — per-Character appearance override, keyed by characterId.
    //   • petActivityLog       — append-only XP/interaction ledger (auto-id), pruned by
    //                            `lib/db/pet.ts`. `[kind+ts]` powers achievement counters.
    //   • petAchievements      — unlock records keyed by achievement id.
    // See `lib/db/pet.ts` and `@/types/pet`.
    this.version(67).stores({
      petProfile: "&id",
      petCharacterBindings: "&characterId, updatedAt",
      petActivityLog: "++id, kind, ts, [kind+ts]",
      petAchievements: "&id, unlockedAt",
    })

    // v68 — Unified Notification Center (ADR-0042). Additive only; no upgrade
    // hook. The durable in-app "center" record for every notification, fed by
    // the single `lib/notifications/notify()` pipe (scheduler, agent-team,
    // plugin, connector, session, push all funnel here). Preferences ride on
    // the AppSettings singleton (`notificationPreferences`), NOT this table.
    //   • dedupeKey  — coalescing key (bump existing `count` within window).
    //   • groupKey   — feed grouping (e.g. conversationKey, runId).
    //   • [readState+createdAt] — newest-unread feed queries + badge counts.
    //   • [source+createdAt]    — per-source filtering, newest-first.
    // See `lib/db/notifications.ts` and `@/types/notifications`.
    this.version(68).stores({
      notifications:
        "&id, createdAt, updatedAt, source, level, readState, dedupeKey, groupKey, snoozedUntil, expiresAt, [readState+createdAt], [source+createdAt]",
    })

    // v69 — Eval datasets/runs/compare extension. Additive; no upgrade hook.
    //   • evalDatasetVersions — immutable snapshot per dataset version
    //     (Approach A). `[datasetId+version]` for "latest snapshot for version"
    //     lookup, `tag` for tagged-version lookup.
    //   • evalRunCaseResults  — compact per-case verdict per run, feeding the
    //     A-vs-B comparison grid. `[runId+caseId]` is the natural unique read.
    // See `./eval-dataset-versions.ts` and `./eval-run-cases.ts`.
    this.version(69).stores({
      evalDatasetVersions: "&id, datasetId, [datasetId+version], tag, createdAt",
      evalRunCaseResults: "&id, runId, [runId+caseId], caseId",
    })

    // v70 — Subscription balance snapshots (ADR-0025 Phase 3). Additive; no
    // upgrade hook. One row per `queryAccountBalance` result, capped at 500
    // newest-first by `lib/subscription/balance/store.ts`.
    //   • [providerKey+accountId] — latest snapshot per account+adapter.
    // See `lib/subscription/balance/` and `@/types/subscription`.
    this.version(70).stores({
      subscriptionBalance: "++localId, fetchedAt, accountId, [providerKey+accountId]",
    })

    // v71 — Unified Plan Execution Hub (ADR-0045). Additive; no upgrade hook.
    // Indices mirror `chatGoals` / `chatGoalEvents` (v30):
    //   • agentPlans       — `&id` primary; `[sessionId+status]` for the
    //     one-open-plan-per-session lookup; `sessionId` for the per-session
    //     history; `createdAt`/`updatedAt` for sorting.
    //   • agentPlanEvents  — `&id` primary; `planId` for cascade-delete;
    //     `[planId+ts]` for the newest-first audit trail; `kind` for filtering.
    // See `lib/db/plans.ts` and `@/types/agent/plan`.
    this.version(71).stores({
      agentPlans: "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt",
      agentPlanEvents: "&id, planId, [planId+ts], kind, ts",
    })

    // ── v72 — Remote-control durable audit trail (ADR-0005 activation). ──────
    // One row per inbound command dispatch and per outbound delivery attempt.
    // `at` drives the newest-first Events tab; `direction`/`kind` filter.
    // Historical table name; canonical outbound writes live in `lib/webhooks/audit.ts`.
    this.version(72).stores({
      remoteControlAudit: "id, at, direction, kind, runId",
    })

    // ── v73 — Pet Live2D model storage (Live2D skin engine). ─────────────────
    // Imported / sample-downloaded Live2D models live in two tables:
    //   • petModels      — `&id` primary; one row per model with capability
    //     metadata (motion groups / expressions) for state mapping. `name`,
    //     `createdAt`, `source` index the list/sort/filter surfaces.
    //   • petModelFiles  — `&id` (`${modelId}:${path}`) primary; one row per
    //     model asset blob. `modelId` drives cascade-delete; `[modelId+path]`
    //     gives O(1) per-file lookup for the runtime URL resolver.
    // Additive; no upgrade hook. See `lib/db/pet-models.ts`.
    this.version(73).stores({
      petModels: "&id, name, createdAt, source",
      petModelFiles: "&id, modelId, [modelId+path]",
    })

    // ── v74 — Terminal: durable history + unattended-exec audit. ─────────────
    //   • terminalHistory     — cross-session command history feeding the
    //     autocomplete history provider (ADR-0039 phase 2). One row per
    //     `(projectId, command)`; re-runs bump `ts`/`uses`. `command` indexes
    //     the prefix query; `ts` drives LRU pruning (cap 5000). `projectId`
    //     is `""` (never null) for project-less rows — IndexedDB compound
    //     keys cannot contain null. See `lib/db/terminal-history.ts`.
    //   • unattendedExecAudit — one row per unattended terminal execution
    //     (or block), the durable trail for the consent-replacement policy.
    //     `ts` newest-first; `runId` filters per workflow run. See
    //     `lib/db/terminal-audit.ts`.
    // Additive; no upgrade hook.
    this.version(74).stores({
      terminalHistory: "&id, ts, command, [projectId+command]",
      unattendedExecAudit: "&id, ts, runId",
    })

    // ── v75 — Persistent provider cost rollups (routing daily budgets). ──────
    // One row per `(local day, providerId, modelId)`, upsert-incremented from
    // `recordProviderOutcome`. `day` drives the boot hydration of the budget
    // mirror + 90-day pruning; `[providerId+day]` serves per-provider history.
    // Additive; no upgrade hook. See `lib/db/provider-cost-daily.ts`.
    this.version(75).stores({
      providerCostDaily: "&id, day, providerId, [providerId+day], updatedAt",
    })

    // ── v76 — Semantic tool routes (semantic-router analog). ─────────────────
    // One row per route: example utterances (+ cached vectors) attached to a
    // tool or a whole plugin, consumed by `lib/ai/routing/semantic-tool-router`
    // to prune the exposed plugin-tool manifest when the opt-in setting is on.
    // `refId` serves per-tool lookups; `pluginId` serves manifest-route cleanup
    // on plugin disable. Additive; no upgrade hook. See `lib/db/tool-routes.ts`.
    this.version(76).stores({
      toolRoutes: "&id, refId, kind, enabled, pluginId",
    })

    // ── v77 — Pet rolling conversation history (talked LLM side channel). ────
    // One row per completed talk turn; pruned to the newest 200 on append.
    // Proactive utterances are skip-memory and never stored. Additive; no
    // upgrade hook. See `lib/db/pet-conversation.ts`.
    this.version(77).stores({
      petConversation: "++id, at",
    })

    // ── v78 — Detach skills installed from the defunct "SkillsMP" source. ────
    // The speculative SkillsMP marketplace adapter was replaced by the real
    // skills.sh integration; its canonicalId scheme (`skillsmp:<id>`) can
    // never match the new `skillssh:owner/repo/slug` ids. Clearing the
    // provenance fields turns those rows into plain local skills (they keep
    // working) instead of phantom marketplace installs whose "installed"
    // badge and update checks would silently never resolve. Idempotent: only
    // rows whose canonicalId carries the `skillsmp:` prefix are touched.
    this.version(78)
      .stores({})
      .upgrade(async (tx) => {
        await tx
          .table("skills")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.canonicalId === "string" && row.canonicalId.startsWith("skillsmp:")) {
              row.canonicalId = undefined
              row.marketplaceSkillId = undefined
            }
          })
      })

    // ── v79 — /loop command (recurring prompts). ─────────────────────────────
    // `loops` mirrors `chatGoals` (session-scoped, `[sessionId+status]` for
    // the one-active-per-session invariant; `scheduledTaskId` links interval
    // loops to their backing scheduler task). `loopEvents` mirrors
    // `chatGoalEvents` (append-only, capped per loop at the CRUD layer).
    // Additive; no upgrade hook. See `lib/db/loops.ts` and `@/types/loop`.
    this.version(79).stores({
      loops: "&id, sessionId, [sessionId+status], status, mode, scheduledTaskId, createdAt",
      loopEvents: "&id, loopId, [loopId+ts], kind, ts",
    })
    // v80 — composer sent-message history (↑/↓ recall). Pure additive.
    this.version(80).stores({
      chatInputHistory: "++id, sessionId, [sessionId+createdAt]",
    })
    // v81 — conversation branching lineage. Adds the `parentSessionId` index to
    // `sessions` so a branched session can find its parent (and a parent its
    // children) for the lightweight "branched from" indicator. The branch
    // payload fields (`branchedFromMessageId`, `branchKind`, `branchSeed`) are
    // non-indexed and need no store change. Additive; no upgrade hook (legacy
    // rows simply have `parentSessionId === undefined`). See
    // `lib/chat/branch-session.ts`.
    this.version(81).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId",
    })

    // v82 — Judge calibration loop (eval spec §10).
    //   • calibrationItems — `id` primary; `setId` + `[setId+createdAt]` for the
    //     per-set listing; `criterion`/`sourceTraceId`/`sourceCaseId` for lookups.
    //   • calibrationRuns  — `runId` primary (the agreement report IS the row);
    //     `setId` + `[setId+createdAt]` drive κ-over-time history.
    this.version(82).stores({
      calibrationItems:
        "id, setId, criterion, [setId+createdAt], sourceTraceId, sourceCaseId, createdAt",
      calibrationRuns: "runId, setId, [setId+createdAt], createdAt",
    })

    // v83 — Connector CRM maturation (Chatwoot-style inbox).
    //   • conversationOverrides — adds lifecycle `status` (+ `[status+updatedAt]`
    //     for status-filtered listing), multi-entry `*labelIds`,
    //     `nextResponseDueAt` (overdue queries), and the `assigneeKind`
    //     discriminator. Other CRM fields (snoozeUntil, assignee blob, SLA
    //     timestamps) are non-indexed and need no index entry. Full index
    //     string repeats the v19 set because Dexie replaces, not merges, a
    //     table's index list.
    //   • conversationLabels — reusable label catalog.
    //   • conversationAssignmentEvents — append-only status/assign/label trail,
    //     `[conversationKey+at]` for the per-conversation timeline.
    //   • cannedResponses — global saved-reply library with `*labelIds`.
    // Pure additive — no upgrade callback (readers default the new fields).
    this.version(83).stores({
      conversationOverrides:
        "&id, &conversationKey, sessionId, pinned, archived, updatedAt, status, [status+updatedAt], *labelIds, nextResponseDueAt, assigneeKind",
      conversationLabels: "&id, name, builtin, sortOrder, updatedAt",
      conversationAssignmentEvents: "&id, conversationKey, [conversationKey+at], kind, at",
      cannedResponses: "&id, title, category, isBuiltIn, sortOrder, updatedAt, *labelIds",
    })

    // v84 — Unified provider limits/usage snapshots (ADR-0025 follow-up). One
    // capped table feeding both the TUI `/limits` panel and the desktop Usage
    // tab for every subscription provider, not just Anthropic. Pure additive.
    this.version(84).stores({
      providerLimits: "++localId, fetchedAt, provider, accountId, [provider+accountId]",
    })

    // v85 — IM control-plane: multi-session per conversation. Adds the
    // denormalized `platformConversationKey` index to `sessions` so the
    // connector runtime can enumerate every session bound to one IM
    // conversation (`/new` / `/switch` / `/sessions`) without a full-table
    // scan. The upgrade hook backfills the new column from each row's existing
    // `platformBinding.conversationKey`. Full index string repeats the v81 set
    // because Dexie replaces, not merges, a table's index list. The new
    // ConversationOverrideRow fields (reasoningOverride, activeSessionId,
    // teamId, approvalMode, proactivePush) are non-indexed and need no store
    // change — readers default the absent values.
    this.version(85)
      .stores({
        sessions:
          "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId, platformConversationKey",
      })
      .upgrade(async (tx) => {
        await tx
          .table("sessions")
          .toCollection()
          .modify((session: ChatSession) => {
            const key = session.platformBinding?.conversationKey
            if (key && session.platformConversationKey === undefined) {
              session.platformConversationKey = key
            }
          })
      })

    // v86 — Workspace (Project) data isolation. Adds a `projectId` scalar +
    // compound index to every runtime/working-state table so chat sessions,
    // messages, goals/plans/loops, agent traces, canvas docs, workflow runs,
    // and connector routing/draft/audit rows are partitioned per workspace.
    // Connector CONFIG (`adapterInstances`/`platformIdentities`), the global
    // inbound dedup `inboundLedger`, attachment cache, and heartbeats stay
    // profile-level shared and gain no column. Workflow DEFINITIONS
    // (`workflows`) stay shared too — only their `workflowRuns` history is
    // scoped. The upgrade backfills via the legacy `Project.sessionIds[]`
    // reverse map (faithful for multi-project users), falling back to the
    // active project — or an auto-created Default workspace when none is set.
    // Index strings repeat each table's full prior set because Dexie replaces,
    // not merges, a table's index list. See `lib/db/project-scope.ts`.
    this.version(86)
      .stores({
        sessions:
          "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId, platformConversationKey, projectId, [projectId+updatedAt]",
        messages:
          "id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id], projectId, [projectId+createdAt]",
        chatGoals:
          "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt, projectId, [projectId+createdAt]",
        chatGoalEvents: "&id, goalId, [goalId+ts], kind, ts, projectId",
        agentPlans:
          "&id, sessionId, [sessionId+status], status, characterId, createdAt, updatedAt, projectId, [projectId+createdAt]",
        agentPlanEvents: "&id, planId, [planId+ts], kind, ts, projectId",
        loops:
          "&id, sessionId, [sessionId+status], status, mode, scheduledTaskId, createdAt, projectId, [projectId+createdAt]",
        loopEvents: "&id, loopId, [loopId+ts], kind, ts, projectId",
        agentTraces:
          "&id, sessionId, [sessionId+startTime], traceId, [traceId+startTime], parentSpanId, surface, projectId, [projectId+startTime]",
        canvasDocuments:
          "id, title, language, type, updatedAt, createdAt, projectId, [projectId+updatedAt]",
        canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave, projectId",
        canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt, projectId",
        canvasSessions: "id, documentId, ownerId, createdAt, projectId",
        workflowRuns:
          "&id, workflowId, status, startedAt, completedAt, [workflowId+startedAt], [workflowId+status], projectId, [projectId+startedAt]",
        workflowRunEvents: "&id, runId, [runId+ts], stepId, [runId+stepId], type, projectId",
        outboundQueue:
          "&id, conversationKey, [conversationKey+createdAt], status, nextAttemptAt, idempotencyKey, [adapterId+status], createdAt, [status+nextAttemptAt], projectId, [projectId+status]",
        connectorDrafts:
          "&id, conversationKey, sessionId, [conversationKey+createdAt], status, expiresAt, projectId",
        connectorAudit:
          "&id, adapterId, kind, at, [adapterId+at], [adapterId+kind+at], projectId, [projectId+at]",
        conversationOverrides:
          "&id, &conversationKey, sessionId, pinned, archived, updatedAt, status, [status+updatedAt], *labelIds, nextResponseDueAt, assigneeKind, projectId",
      })
      .upgrade(backfillProjectScopeV86)

    // v87 — Journaled background subagent tasks. Pure additive; running rows
    // are reconciled to `interrupted` by the host boot code, not by migration.
    this.version(87).stores({
      backgroundTasks:
        "&runId, kind, subagentId, sessionId, host, status, startedAt, settledAt, [host+status], [sessionId+startedAt]",
    })

    // v88 — WASM preopen grant ledger. Pure additive; grant reconciliation is
    // handled by `lib/plugin/security/wasm-grant.ts` at load/call time.
    this.version(88).stores({
      wasmGrantLedger: "&id, pluginId, preopen, source, grantedAt",
    })

    // v89 — Per-turn Run Records (Run Panel "second clock"). Pure additive;
    // a row with no `settledAt` on reload is shown as "interrupted". See
    // `lib/db/run-records.ts`.
    this.version(89).stores({
      runRecords: "[sessionId+runId], sessionId, [sessionId+startedAt], startedAt, status",
    })

    // v90 — Conversation folders (conversation-list overhaul). A lightweight,
    // workspace-scoped folder dimension orthogonal to the workspace itself;
    // sessions reference a folder via the non-indexed `ChatSession.folderId`.
    // Pure additive — no upgrade hook. See `lib/db/session-folders.ts`.
    this.version(90).stores({
      sessionFolders: "id, projectId, [projectId+order], name, createdAt, updatedAt",
    })

    // v91 — Denormalised `triggeredBySource` index on `workflowRuns`. Promotes
    // `triggeredBy.source` to a top-level indexed column (Dexie can't index
    // nested props) so the IM progress-runner watches only IM-triggered runs
    // via `.where("triggeredBySource").equals("im")` instead of scanning the
    // whole table. Restates the full workflowRuns index list (Dexie replaces,
    // not merges, a table's index list). Backfill stamps legacy rows.
    this.version(91)
      .stores({
        workflowRuns:
          "&id, workflowId, status, startedAt, completedAt, [workflowId+startedAt], [workflowId+status], projectId, [projectId+startedAt], triggeredBySource, [triggeredBySource+startedAt]",
      })
      .upgrade(backfillTriggeredBySourceV91)

    // v92 — Remote-control run-status projection. Closes the result loop for the
    // inbound `/api/v1/commands/:target` surface: the renderer stamps each
    // server-issued `runId` with its dispatch outcome (and, where a subsystem
    // emits a terminal signal, the final status) so `GET /api/v1/runs/:runId`
    // can report it. Pure additive — no upgrade hook. See
    // Historical run projection retained read-only for database compatibility.
    this.version(92).stores({
      remoteControlRunStatus: "&runId, target, status, startedAt, updatedAt",
    })

    // v93 — OpenRouter live-models catalog cache (singleton). The OpenRouter
    // analogue of `modelsDevCatalog` (v60): a single "singleton" row holding the
    // full real-time `/models` list + fetch timestamp. Both the GUI and the CLI
    // (which shares this Dexie via its snapshot) read it so the OpenRouter model
    // picker syncs in real time across shells. Pure additive — no upgrade hook.
    // See `lib/db/openrouter-catalog.ts` + `lib/ai/providers/openrouter-catalog-sync.ts`.
    this.version(93).stores({
      openrouterCatalog: "&id, fetchedAt",
    })

    // v94 — Pet item inventory (economy wave, ADR-0058). Catalog item id is
    // the PK; qty/timestamps are non-indexed payload. The catalog itself is
    // static code (`lib/pet/economy/item-catalog.ts`), never persisted. Pure
    // additive — no upgrade hook. See `lib/db/pet.ts`.
    this.version(94).stores({
      petInventory: "&id",
    })

    // v95 — Wiki Lint results (one singleton row per scope, mirrors
    // `wikiManifest`). Detects orphan pages + dangling `[[slug]]` links from a
    // no-AI local pass. Pure additive — no upgrade hook. See
    // `lib/db/wiki-lint-results.ts` and `lib/wiki/lint/`.
    this.version(95).stores({
      wikiLintResults: "&scope, lastRunAt",
    })

    // v96 — Attention Radar reports (info-diet analysis). Newest-first by
    // `generatedAt`; `[scope+generatedAt]` powers the "latest for scope" read.
    // Pure additive — no upgrade hook. See `lib/db/radar-reports.ts` +
    // `lib/radar/`.
    this.version(96).stores({
      radarReports: "&id, generatedAt, [scope+generatedAt]",
    })

    // v97 — Content capture store (confirm-bubble flow). `fingerprint` is the
    // SHA-256 dedup key; `capturedAt` drives the radar's "last N days" query.
    // Pure additive — no upgrade hook. See `lib/db/captured-items.ts` +
    // `lib/capture/`.
    this.version(97).stores({
      capturedItems: "&id, capturedAt, kind, sourceApp, fingerprint",
    })

    // v98 — External Bridge inbound-write review queue (ADR-0008 Phase 4).
    // MCP inbound-write tools land contributions here as `pending` drafts for
    // operator review; nothing mutates live state. `status` powers the pending
    // queue read; `createdAt` drives newest-first + cap trimming. Pure
    // additive — no upgrade hook. See `lib/db/inbound-drafts.ts` +
    // `lib/external-bridge/handlers/inbound.ts`.
    this.version(98).stores({
      inboundDrafts: "&id, kind, status, createdAt",
    })

    // v99 — Inbound gateway durable request log (ADR-0043). One row per
    // inbound request (success, upstream failure, or middleware rejection),
    // pushed from the `gateway://request-log` Tauri event. `at` drives the
    // newest-first view + cap trimming; `status`/`model`/`keyId` power the
    // filters. Pure additive — no upgrade hook. See
    // `lib/db/gateway-request-log.ts` + `src-tauri/src/gateway/server.rs`.
    this.version(99).stores({
      gatewayRequestLog: "&id, at, status, model, keyId",
    })

    // v100 — Project-scoped RAG (workspace knowledge base). One row per sliced
    // chunk of a `Project.knowledgeBase` file, with a pointer into the remote
    // vector store (collection `cognia_project_{projectId}`). Project-scoped —
    // listed in `PROJECT_SCOPED_TABLES` so `deleteProjectCascade` drops the
    // local rows (and a best-effort remote collection drop). Indexes mirror
    // `twinChunks`: `[projectId+fileId]` for per-file cascade on remove,
    // `[projectId+createdAt]` for the cheap corpus-version signal. Pure additive
    // — chunks are derived and repopulate on next ingest. See
    // `lib/db/project-chunks.ts` + `lib/project-knowledge/`.
    this.version(100).stores({
      projectChunks:
        "&id, projectId, fileId, vectorDocId, [projectId+fileId], [projectId+createdAt]",
    })

    // v101 — Optical-compaction archives (ADR-0063). One row per "optical"
    // compaction boundary: the rendered image frames + token stats + the
    // original pre-compaction transcript, so a boundary can be re-opened after a
    // reload (the in-memory undo registry is empty then). `sessionId` powers the
    // per-session viewer; `createdAt` (and the `[sessionId+createdAt]` compound)
    // drive newest-first reads + cap trimming. Pure additive — no upgrade hook.
    // See `lib/db/optical-archives.ts`.
    this.version(101).stores({
      opticalArchives: "&id, sessionId, createdAt, [sessionId+createdAt]",
    })

    // v102 — `triggerKind` index on `workflowRuns`. The Agent-Team runs view
    // (`components/agent/team/runs-list.tsx`) and the CLI status projection
    // (`lib/cli-bridge/handlers/agent-team.ts`) both resolve team runs via
    // `.where("triggerKind").equals("trigger.team")`, but no prior version
    // indexed the column — Dexie threw `SchemaError: KeyPath triggerKind on
    // object store workflowRuns is not indexed` on first render of the team
    // workspace. `triggerKind` is a required top-level field stamped at run
    // creation (`lib/workflow/runtime/orchestrator.ts`), so unlike v91's derived
    // `triggeredBySource` it needs no backfill — Dexie re-indexes existing rows
    // from their live values. Restates the full workflowRuns index list (Dexie
    // replaces, not merges, a table's index list).
    this.version(102).stores({
      workflowRuns:
        "&id, workflowId, status, startedAt, completedAt, [workflowId+startedAt], [workflowId+status], projectId, [projectId+startedAt], triggeredBySource, [triggeredBySource+startedAt], triggerKind",
    })

    // v103 — Agent Team PR feedback loop (ADR — team PR feedback). One row per
    // (team run, PR): the durable PR/CI/review observation facts, the cached
    // read-time-derived display status, and the restart-safe reaction dedup
    // ledger. `teamId` powers the workspace PR-status liveQuery; `runId` powers
    // per-run cleanup; `derivedStatus` supports status filtering. Pure additive
    // — no upgrade hook. See `lib/db/team-pr-observations.ts`.
    this.version(103).stores({
      teamPrObservations: "&id, teamId, [teamId+updatedAt], runId, derivedStatus",
    })

    // v104 — Agent-Team board projection (team-board CQRS). A one-way mirror
    // of the localStorage-persisted agent-team-store (the single write source)
    // so the mobile sync pipeline can carry the task board to the phone: task
    // rows (`kind: "task"`, id = taskId) + one team-meta row per team
    // (`kind: "team"`, id = `team:<teamId>`) carrying the roster the mobile
    // board needs for swimlanes/guards. Desktop-only writer
    // (`lib/db/agent-team-projection.ts`); Dexie NEVER writes back to the
    // store. `updatedAt` cursors the sync delta; `[teamId+updatedAt]` powers
    // per-team liveQueries on the phone. Pure additive — no upgrade hook.
    // See `lib/db/agent-team-board.ts`.
    this.version(104).stores({
      agentTeamBoard: "&id, teamId, [teamId+updatedAt], updatedAt, kind, status",
    })

    // v105 — Fleet agent-monitor history. Summary rows for coding-agent
    // sessions observed by the fleet island (Claude Code / Codex / OpenCode),
    // written by `hooks/fleet/use-fleet-history-sink.ts` from the live
    // `fleet://update` stream so the history survives island close / app
    // restart (the in-memory Rust registry does not). Keyed by
    // `[agent+sessionId]`; `startedAt` orders the history list. Pure additive
    // — no upgrade hook. See `lib/db/fleet-sessions.ts`.
    this.version(105).stores({
      fleetSessions: "&id, [agent+sessionId], startedAt, endedAt, agent, outcome",
    })

    // v106 — instance-level AI binding defaults + chat-management scaffolding
    //   (multi-bot × multi-agent connectors, W1/W2). Pure additive optional
    //   columns; no index changes, no row rewrites, no upgrade hook.
    //
    //   `adapterInstances`:
    //   • `defaultTeamId?` / `defaultModel?` / `defaultProvider?` /
    //     `defaultReasoning?` — per-bot AI binding defaults resolved by
    //     `resolveEffectiveTeamBinding` (`lib/connectors/policy-resolve.ts`)
    //     and the model/provider/effort chains in
    //     `lib/claude/build-options.ts`. Conversation overrides still win;
    //     the bot default wins over the character's own model/provider.
    //   • `lastMissingScopes?: string[]` — platform scopes observed missing
    //     by chat-management calls; rendered by the Lark whoami panel.
    //
    //   `conversationOverrides`:
    //   • `teamDisabled?: boolean` — explicit `/team off` sentinel that
    //     suppresses both the override teamId and the bot `defaultTeamId`.
    //
    //   `outboundQueue`:
    //   • `OutboundJobSource` union gains `"skill"` (im.* built-in skills:
    //     new-chat first message, broadcast fan-out targets).
    //
    //   None of these fields are indexed (all are filter-only blobs read
    //   from rows fetched by primary key / conversationKey), so the bump is
    //   `stores({})`.
    this.version(106).stores({})

    // v107 — inbound dispatch rules (条件规则表 v1, W3 multi-bot). Pure
    //   additive optional column; no index changes, no row rewrites, no
    //   upgrade hook.
    //
    //   `adapterInstances`:
    //   • `dispatchRules?: DispatchRule[]` — declarative per-instance rules
    //     (keywords / regex / senderIds / channelKinds → character | team |
    //     workflow), evaluated in array order by
    //     `lib/connectors/dispatch-rules.ts:matchDispatchRule`. Precedence at
    //     dispatch (`lib/connectors/runtime.ts` ai-run branch): explicit
    //     conversation override (`/team`, `/character`, `/workflow`,
    //     `teamDisabled`) > first matching rule > instance defaults.
    //
    //   The field is a filter-only JSON blob read from rows fetched by
    //   primary key, so the bump is `stores({})`.
    this.version(107).stores({})

    // v108 — Local code-adoption tracking (per-turn write-attribution metrics).
    // See `lib/code-adoption/` and the 2026-07-13 design spec. Local-only:
    // intentionally NOT registered in `lib/sync` (SyncableTable /
    // DEFAULT_HANDLERS), so it never leaves the device. Pure additive.
    this.version(108).stores({
      codeAdoptionTurns: "&id, runId, sessionId, workspaceRoot, ts, [sessionId+ts]",
    })

    // v109 — Binary trust model rebuild (Phase 1). Replaces the
    //   `trustedPublishers` fingerprint model with a user-consent ledger.
    //
    //   Why: the old model granted prompt-free `child_process.spawn` when a
    //   plugin's manifest asserted a `publisherKeyFingerprint` that matched a
    //   `trustedPublishers` row by **plain string equality, zero crypto**. The
    //   v39 seed populated that table with nine `"placeholder:*"` fingerprints
    //   whose literal strings live in the repo source — so any hostile plugin
    //   could self-declare `"placeholder:microsoft.vscode"` and spawn its own
    //   bundled binary with no prompt. There was no proof of possession
    //   anywhere in the chain.
    //
    //   Two changes, both required to cut it:
    //   1. `approvedBinaries` (new) — the only grant surface now. Records that
    //      THIS user approved THESE exact bytes (`sha256`) at THIS path for
    //      THIS plugin. Compound PK `[pluginId+binaryPath]`; the readers
    //      re-hash the file on every spawn, so any byte drift re-prompts. See
    //      `types/plugin/approved-binary.ts` + `lib/db/approved-binaries.ts`.
    //   2. The upgrade hook deletes every `trustedPublishers` row whose
    //      `fingerprint` starts with `"placeholder:"` — retiring the v39 seed
    //      from databases that already drank it. Rows the user populated
    //      themselves are preserved: they are the user's data, not the seed's,
    //      and they are inert under the new policy regardless.
    //
    //   Idempotent: re-running finds no placeholder rows and deletes nothing.
    this.version(109)
      .stores({
        approvedBinaries: "&[pluginId+binaryPath], pluginId, sha256, approvedAt",
      })
      .upgrade(async (tx) => {
        const placeholders = await tx
          .table("trustedPublishers")
          .filter(
            (row: { fingerprint?: unknown }) =>
              typeof row.fingerprint === "string" && row.fingerprint.startsWith("placeholder:")
          )
          .toArray()
        for (const row of placeholders) {
          await tx.table("trustedPublishers").delete(row.publicKey)
        }
      })

    // v110 — Recorded browser flows (ADR-0072). A flow is the human's captured
    //   interaction with the `/browser` preview, replayable and exportable.
    //
    //   Indexed by `baseUrl` so the pane can offer the flows recorded against
    //   the origin currently loaded, and by `updatedAt` for a recency-ordered
    //   list. `steps` is stored as a nested array (not a separate table): a
    //   flow is only ever read and written whole, so splitting it would buy
    //   nothing and cost a join.
    //
    //   Local-only: intentionally NOT registered in `lib/sync` (SyncableTable /
    //   DEFAULT_HANDLERS). A flow is a script for one machine's dev server, and
    //   syncing it would push localhost URLs off the device for no benefit.
    //   Credentials are never in here to begin with — the recorder captures
    //   `{value:"", secret:true}` for password fields and never their value
    //   (see `lib/browser/recording/protocol.ts`). Pure additive.
    this.version(110).stores({
      browserRecordings: "&id, baseUrl, updatedAt, [baseUrl+updatedAt]",
    })

    // v111 — Durable browser annotations and their resolution lifecycle.
    // Local-only: these target one machine's localhost dev server, so syncing
    // them would leak meaningless local URLs off-device for no benefit.
    this.version(111).stores({
      browserAnnotations: "&id, sessionId, baseUrl, status, createdAt, [baseUrl+status]",
    })

    // v112 — Explicitly opted-in product behavior events. Local storage and
    // OTLP Logs export are independent; clearing this table never changes the
    // user's consent preference.
    this.version(112).stores({
      behaviorEvents: "&id, eventName, at, sessionId, [eventName+at]",
    })

    // v113 — Remove the unused pluginScheduledJobs table. Plugin schedules
    // are canonical ScheduledTask rows in the separate SchedulerDatabase;
    // keeping a second unwritten table made unified views and uninstall
    // cleanup observe the wrong storage.
    this.version(113).stores({
      pluginScheduledJobs: null,
    })

    // v114 — Durable execution semantics shared by Agent turns, Visual
    // Workflows, and IM presentation drivers. Source runtimes remain their
    // execution authority; these tables are the replayable presentation and
    // control journal. Pure additions, so no backfill is required.
    this.version(114).stores({
      executionRuns:
        "&id, kind, sourceId, status, sessionId, projectId, updatedAt, [kind+sourceId]",
      executionRunEvents: "&id, runId, [runId+seq], type, ts, projectId",
      executionRunBindings:
        "&id, runId, adapterId, conversationKey, status, [runId+conversationKey], projectId",
      executionRunInterrupts: "&id, runId, status, expiresAt, [runId+status], projectId",
    })

    // v115 — One writable comment source for every Context Workbench
    // resource. Keep canvasComments as a historical rollback table, but
    // idempotently copy its rows into the generalized resource/anchor model.
    this.version(115)
      .stores({
        contextComments:
          "&id, resourceKind, resourceId, [resourceKind+resourceId], [resourceKind+resourceId+createdAt], parentId, resolvedAt, projectId",
      })
      .upgrade(async (tx) => {
        const source = tx.table<CanvasCommentRow, string>("canvasComments")
        const target = tx.table<ContextCommentRow, string>("contextComments")
        const canvasComments = await source.toArray()
        for (const canvasComment of canvasComments) {
          if (await target.get(canvasComment.id)) continue
          await target.add(contextCommentRowFromCanvas(canvasComment))
        }
      })

    // v116 — Cognia-owned Sites lifecycle. Separate tables preserve immutable
    // versions/artifacts, operation recovery, and provider-resource ownership.
    // Pure additions: there is no legacy row to backfill.
    this.version(116).stores({
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
    })

    // v117 — Remote browser metadata. Both tables are host-local by design:
    // profile ids point at protected WorkspaceRuntime volumes and domain grants
    // are security decisions for this host, so neither belongs in sync.
    this.version(117).stores({
      browserProfiles: "&id, workspaceId, [workspaceId+updatedAt], name",
      browserDomainGrants: "&id, workspaceId, &[workspaceId+domain], updatedAt",
    })

    // v118 — Learned-memory governance. Existing memories remain usable but
    // are explicitly marked legacy/no-evidence; new immutable evidence,
    // durable extraction jobs, and content-free audit events live separately.
    this.version(118)
      .stores({
        memories:
          "&id, scope, type, characterId, projectId, agentId, status, reviewStatus, lastAccessedAt, vectorDocId, sourceSessionId, pinned, [scope+type], [scope+status], [type+status], [projectId+status], [agentId+status]",
        memoryEvidence: "&id, memoryId, kind, sessionId, createdAt, [memoryId+createdAt]",
        memoryJobs:
          "&id, dedupeKey, status, kind, sessionId, projectId, queuedAt, nextAttemptAt, [status+queuedAt]",
        memoryAuditEvents: "&id, memoryId, sessionId, action, createdAt, [memoryId+createdAt]",
      })
      .upgrade(async (tx) => {
        await tx
          .table<Memory, string>("memories")
          .toCollection()
          .modify((memory) => {
            backfillMemoryGovernanceV118(memory)
          })
      })

    // v119 — Installed Codex-compatible v2 sprite pet packs. The atlas blob
    // and manifest metadata share one row so installation/deletion is atomic;
    // displayName and createdAt support picker search/sort surfaces.
    this.version(119).stores({
      petSpritePacks: "&id, displayName, createdAt",
    })

    // v120 — Platform-neutral conversation state and crash-safe inbound work.
    // Pure additions; legacy connector rows remain valid and are resolved lazily.
    this.version(120).stores({
      connectorConversationStates:
        "&conversationKey, adapterId, activationStatus, expiresAt, updatedAt",
      connectorInboundJobs:
        "&id, &[adapterId+platformMessageId], [conversationKey+status+receivedAt], adapterId, conversationKey, status, leaseExpiresAt, executionRunId, receivedAt",
    })

    // v121 — Provider Profile Store (ADR-0090 Phase 1). Derived, secret-free
    // projections of the legacy providerSettings/customProviders rows into
    // provider / deployment / transport documents. The legacy rows stay the
    // credential + read authority; these tables are kept fresh by the
    // settings dual-write hook (`lib/settings/provider-profile-sync.ts`) and
    // re-derivable at any time, so rollback = old code ignoring new tables.
    this.version(121)
      .stores({
        providerProfiles: "&id",
        deploymentProfiles: "&id, providerRef, legacyProviderId",
        transportProfiles: "&id",
        profileStoreMeta: "&id",
      })
      .upgrade(async (tx) => {
        // Lazy-import: the catalog + deriver only load during the one-time
        // upgrade transaction, not on every db open.
        const { deriveProfiles, getBuiltInProviderCatalog } = await import("@cognia/provider-types")
        const settings = (await tx.table("settings").get("singleton")) as
          | {
              providerSettings?: Record<string, never>
              customProviders?: never[]
            }
          | undefined
        const derived = deriveProfiles({
          catalog: getBuiltInProviderCatalog(),
          providerSettings: settings?.providerSettings,
          customProviders: settings?.customProviders,
        })
        await tx.table("providerProfiles").bulkPut(derived.providerProfiles)
        await tx.table("deploymentProfiles").bulkPut(derived.deploymentProfiles)
        await tx.table("transportProfiles").bulkPut(derived.transportProfiles)
        await tx.table("profileStoreMeta").put({
          id: "singleton",
          profileVersion: 1,
          schemaVersion: 1,
          migratedAt: new Date().toISOString(),
        })
      })

    // v122 — Memory chat-surface index. Adds `sourceMessageId` to the memories
    // index string so per-message "learned from this reply" chips can liveQuery
    // by originating assistant message. Index-only; no data reshaping.
    this.version(122).stores({
      memories:
        "&id, scope, type, characterId, projectId, agentId, status, reviewStatus, lastAccessedAt, vectorDocId, sourceSessionId, sourceMessageId, pinned, [scope+type], [scope+status], [type+status], [projectId+status], [agentId+status]",
    })

    // v123 — Certification-manifest projection (ADR-0090 Phase 5). Pure index
    // over the signed bundle files (the authority); rebuildable at any time
    // via `rebuildCompatibilityProjection`, so no upgrade backfill.
    this.version(123).stores({
      agentCompatibilityRecords: "&keyId, bundleId, deploymentRef",
    })

    // v124 — Canonical-session HEADER projection (ADR-0090 Phase 8). The
    // authority is the canonical envelope stream on the workflow event-log
    // (lib/ai/agent/recovery/canonical-log.ts) plus codec conversions; this
    // table is a rebuildable index for listing/lookup only — no backfill.
    this.version(124).stores({
      agentCanonicalSessions: "&canonicalSessionId, sourceRuntime, nativeSessionId, updatedAt",
    })

    // v125 — Feishu unified identity registry (plan 2026-07-24 Phase 1).
    // Pure additions, no upgrade callback. Compound UNIQUE indexes carry the
    // identity model's constraints: one tenant row per (tenantKey, appId),
    // one principal per (tenantKey, appId, openId) — the same openId text in
    // another tenant/app never merges. Bind requests are keyed by the short
    // code shown to unbound users.
    this.version(125).stores({
      feishuTenants: "&id, &[tenantKey+appId], status, updatedAt",
      feishuPrincipals:
        "&id, &[tenantKey+appId+openId], [tenantKey+appId], cogniaUserId, platformIdentityId, status, updatedAt",
      feishuPrincipalBindRequests: "&id, openId, adapterId, status, requestedAt, expiresAt",
    })

    // v126 — Lark entry surfaces (plan 2026-07-24 Phases 3-5). Pure
    // additions: token ledger (jti-keyed), chat-surface reconcile state
    // (compound primary key — one row per adapter/chat/surface), shortcut
    // import idempotency (unique sourceHash), web-session audit ledger.
    this.version(126).stores({
      larkEntryContexts: "&id, adapterId, principalId, accountId, entryType, expiresAt",
      larkChatSurfaces: "&[adapterId+chatId+surfaceType], adapterId, status, nextAttemptAt",
      larkMessageImports: "&id, &sourceHash, [adapterId+chatId], sessionId, createdAt",
      larkWebSessions: "&id, adapterId, principalId, expiresAt",
    })

    // v127 — Host-owned Marketplace Integration control plane. External
    // service resources/actions stay separate from IM Connector state.
    this.version(127).stores({
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
    })

    // v128 — Content-addressed store for images carried by chat messages.
    //
    // Until now every chat image lived as a base64 `data:` URL inlined into
    // `messages.parts`, so the same bytes were held by the Dexie row, the
    // Zustand store, the DOM attribute and the decoded bitmap at once. A
    // session of agent screenshots measured 717MB of base64 for 2.2GB of
    // renderer heap (`tests/e2e/mobile/chat-render-perf.baseline.json`).
    // Messages now carry a `ref` and the bytes live here as Blobs, which
    // IndexedDB stores out-of-line and the renderer can page in on demand.
    //
    // Keyed by content hash, so the same screenshot referenced from twenty
    // turns is stored once. `lastUsedAt` drives orphan collection; there is no
    // upgrade callback because the migration is lazy and per-session (a
    // transaction that rewrote every message row would block boot for minutes
    // on a large profile, and a failure mid-way would roll the whole database
    // back).
    this.version(128).stores({
      messageMedia: "&hash, createdAt, lastUsedAt",
    })

    // 129 is deliberately skipped. A concurrent branch was mid-flight over this
    // same working tree when this block was written, and schema numbers have
    // been lost to that twice before (v66, v69). Leaving the next number free
    // costs nothing — Dexie only requires versions to increase — and removes
    // the chance of two branches shipping different definitions of the same
    // version to users who ran both.
    //
    // Sync cursors become per-host. Their primary key was the table name
    // alone, with nothing anywhere recording WHICH host a watermark came from,
    // and nothing clearing them when a client paired to a different one. A
    // client that re-paired elsewhere therefore resumed from the previous
    // host's watermark and asked the new host for "everything since <a
    // timestamp that means nothing here>" — blending two machines' sessions,
    // messages and characters into one local store, silently.
    //
    // Keyed on the device id the host issued at pair time rather than the
    // host's own `serverId`: it is unique per (client, host) pair, present from
    // the moment of pairing (no first-connect round-trip), already persisted in
    // `CompanionConfig`, and it changes exactly when a fresh pull is the safe
    // answer. Old rows are dropped rather than migrated — a cursor whose host
    // is unknown cannot be attributed to one, and re-pulling is always safe.
    // Dexie cannot change an existing table's primary key — attempting it
    // breaks every multi-version upgrade path, not just this one. So the
    // per-host cursors live in a new store and the old one is dropped.
    // Losing the watermarks costs a single full re-pull and is the safe
    // direction regardless: a cursor with no host recorded cannot be
    // attributed to one after the fact.
    this.version(130).stores({
      syncCursors: null,
      hostSyncCursors: "&[serverKey+table], table, lastSyncAt, since",
    })

    // v131 — Session lineage repair + an indexable surface binding.
    //
    // Claimed as 130+1 rather than taking the 129 left free above: 129 is a
    // LOWER number than a version already declared in this tree, so any profile
    // that ran the v130 branch is already past it and would never execute a 129
    // upgrade callback. A backfill that silently skips exactly the users who ran
    // both branches is worse than no backfill.
    //
    // Two writers create session rows without going through `createSession` —
    // the only helper that resolves a workspace: conversation branching
    // (`buildChildRow`) and the workbench sidechat
    // (`ensureResourceWorkbenchSession`). Both `put` a hand-built row, and both
    // omitted `projectId`. Because `listScopedSessions` reads through
    // `[projectId+updatedAt]` and Dexie omits rows whose key path contains
    // `undefined` from a compound index, those rows were not mis-filed — they
    // were absent. Branches vanished from the sidebar on the first reload after
    // creation, and sidechats sat outside `deleteProjectCascade`, outliving the
    // workspace they belonged to along with all of their messages.
    //
    // `surfaceBindingKey` denormalises `surfaceBinding` so an embedded session
    // can be looked up by binding without `db.sessions.toArray()` — a full scan
    // of every session, which is what each workbench open paid until now. The
    // sessions index list is restated in full because Dexie replaces, not
    // merges, a table's index list.
    //
    // See `lib/db/session-lineage-backfill.ts` for the attribution rules.
    this.version(131)
      .stores({
        sessions:
          "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId, platformConversationKey, projectId, [projectId+updatedAt], surfaceBindingKey",
      })
      .upgrade(backfillSessionLineageV131)

    // v132 — Unified Template Platform.
    //
    // Drafts and immutable releases share one definition table and carry a
    // storage key so nullable draft versions never participate in an IndexedDB
    // compound primary key. Package rows and instance provenance are portable.
    // Local Twin/credential/path bindings and the rollback-capable legacy
    // migration journal are deliberately not part of companion sync.
    this.version(132).stores({
      templateDefinitions: "&storageKey, id, domain, status, version, updatedAt, [id+status]",
      templatePackages: "&key, id, version, trust, importedAt",
      templateInstances: "&id, source.definitionId, source.version, updatedAt",
      templateDeviceBindings: "&id, definitionId, slotId, kind, [definitionId+slotId], updatedAt",
      templateMigrationJournal: "&id, domain, sourceKey, status, updatedAt",
    })

    // 133 is deliberately skipped, for the same reason 129 was: v132 above was
    // uncommitted work by a concurrent session on this shared working tree when
    // this block was written. Leaving the next number free costs nothing and
    // removes the chance of two branches shipping different definitions of one
    // version to users who ran both.
    //
    // Chat-history search (ADR-0099). `chatSearchText` holds one lean row per
    // message carrying ONLY the projected searchable text — never `parts`. The
    // search path must not load `parts`: a single message can carry tens of KB
    // of tool output, and reading whole message rows to search them is precisely
    // what made the previous `searchSessionsByContent` unusable (it read up to
    // 5001 complete rows per keystroke, in primary-key order, which is not
    // chronological because message ids come from several generators).
    //
    // There is intentionally no inverted index. Highlighting needs character
    // offsets, so the final decision is always `indexOf` over the text; once the
    // text is reachable, `indexOf` beats an index probe. A fixed-width
    // fingerprint was evaluated and rejected: its entry count is min(grams,
    // buckets) while selectivity needs buckets >> grams, so at 64 buckets a
    // 200-gram message lights 61 of them and every query matches nearly
    // everything. See `lib/chat/search/corpus.ts`.
    //
    // `[createdAt+messageId]` rather than `createdAt` alone: several messages
    // routinely share a millisecond, and both the resident-corpus load and the
    // older-history scan page through this index — a non-total ordering would
    // re-read or skip the tied rows.
    //
    // `chatSearchState` is the descending-backfill watermark. The upgrade
    // callback only creates tables; backfilling here would freeze boot for
    // minutes on a large account. See `lib/db/chat-search-text.ts`.
    this.version(134).stores({
      chatSearchText:
        "&messageId, sessionId, [sessionId+createdAt], [createdAt+messageId], projectId, [projectId+createdAt]",
      chatSearchState: "id",
    })

    // v135 — Unified multimodal provider/model catalog. Complete revisions
    // stage into normalized tables and activate through one pointer; deployment
    // inventory is local evidence and never mutates global certification.
    this.version(135)
      .stores({
        providerCatalogRevisions: "&id, status, generatedAt, integrity",
        providerCatalogProviders: "&[revisionId+id], revisionId, id, tier, *modalities",
        providerCatalogModels: "&[revisionId+id], revisionId, id, creator, family, lifecycle",
        providerCatalogOfferings:
          "&[revisionId+id], revisionId, id, [revisionId+providerRef], [revisionId+modelRef], providerRef, modelRef, lifecycle, available",
        providerCatalogAliases: "&[revisionId+id], revisionId, id, kind",
        providerCatalogState: "&id",
        providerConnectionInventory:
          "&id, &deploymentRef, providerRef, status, checkedAt, *availableUpstreamIds",
      })
      .upgrade(async (tx) => {
        const { PROFILE_STORE_SCHEMA_VERSION, upgradeDeploymentProfileCatalogRefs } =
          await import("@cognia/provider-types")
        await tx
          .table<DeploymentProfile, string>("deploymentProfiles")
          .toCollection()
          .modify((deployment) => {
            Object.assign(deployment, upgradeDeploymentProfileCatalogRefs(deployment))
          })
        const meta = await tx.table("profileStoreMeta").get("singleton")
        if (meta) {
          await tx.table("profileStoreMeta").update("singleton", {
            schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
            migratedAt: new Date().toISOString(),
          })
        }
      })

    // v136 — Queue rows created before runtime-target scoping cannot be safely
    // replayed because their intended destination was never persisted. Preserve
    // them for diagnostics, but quarantine them under the legacy mixed target
    // instead of silently attributing them to whichever target is active now.
    this.version(136).upgrade(async (tx) => {
      const accountId = accountIdFromDatabaseName(this.name) ?? "legacy-unscoped"
      await tx
        .table<MobileOutboundJobRow, string>("mobileOutboundQueue")
        .toCollection()
        .modify((row) => {
          if (row.accountId && row.targetId) return
          Object.assign(row, {
            accountId,
            targetId: LEGACY_MIXED_TARGET_ID,
            status: "deadlettered",
            lastError: "Legacy outbound action could not be safely attributed to a runtime target.",
          } satisfies Partial<MobileOutboundJobRow>)
        })
    })

    // v137 — Additive durable evaluation-project storage. Existing dataset,
    // version, run, case-result, and calibration ids remain untouched. Legacy
    // reports receive an explicit reproducibility marker and stay readable,
    // while formal recommendation queries use only evalExperiments.
    this.version(137)
      .stores({
        evalRuns: "&runId, datasetId, [datasetId+createdAt], createdAt, reproducibility",
        evalProjects: "&id, mode, updatedAt, createdAt",
        evalExperiments: "&id, projectId, state, [projectId+createdAt], updatedAt",
        evalTasks:
          "&id, experimentId, [experimentId+state], [state+nextAttemptAt], variantId, caseId, providerId",
        evalSamples:
          "&id, experimentId, taskId, [experimentId+caseId], variantId, createdAt, expiresAt",
        evalScores: "&id, experimentId, sampleId, scorerId, [experimentId+scorerId], createdAt",
        evalReviewBatches: "&id, experimentId, status, createdAt",
        evalReviewVotes: "&id, batchId, experimentId, pairId, reviewerId, [batchId+pairId]",
        evalAdjudications: "&id, batchId, pairId, adjudicatorId, [batchId+pairId]",
        evalRecommendations: "&id, &experimentId, createdAt",
        evalConfigurationApplies:
          "&id, experimentId, targetType, targetId, appliedAt, rolledBackAt",
        evalAssets: "&digest, mediaType, createdAt, expiresAt, referenceCount",
      })
      .upgrade(async (tx) => {
        await tx
          .table("evalRuns")
          .toCollection()
          .modify((run) => {
            if (!("reproducibility" in run)) run.reproducibility = "legacy-non-reproducible"
          })
      })

    // v138 — Remote terminal access is an independent, explicit grant. Seed
    // every existing paired device to false so no historical control/agent
    // permission can implicitly authorize a durable shell.
    this.version(138).upgrade(async (tx) => {
      await tx
        .table<PairedDeviceRow, string>("pairedDevices")
        .toCollection()
        .modify((row) => {
          if (typeof row.allowRemoteTerminal !== "boolean") {
            row.allowRemoteTerminal = false
          }
        })
    })

    // v139 — Unified action review (ADR-0102). Additive only; no upgrade hook,
    // because the table is new.
    //
    // Deliberately ONE table. Cross-host handoff (ADR-0103) and the PR chat
    // workspace (ADR-0105) each claim their own later version alongside their
    // accessor module, rather than being batched here: a table declared before
    // anything can read it is the "built but dormant" defect this repo keeps
    // hitting. Version numbers are cheap and append-only (129 and 133 are
    // already burned); a dormant table is not.
    //
    // `actionReviewReceipts` is the first durable home for an approval
    // decision. Query columns are FLATTENED off the nested receipt by
    // `toReceiptRow` (lib/db/action-review-receipts.ts): six single axes plus
    // the two compounds the audit UI pages through, and a multiEntry
    // `surfaceIds` so "every credential-auth decision this quarter" is an index
    // hit rather than a full-table filter. `expiresAt` is the 90-day retention
    // watermark, indexed so the sweeper is a range delete — and stamped per
    // row, so changing the retention constant never re-dates existing rows.
    this.version(139).stores({
      actionReviewReceipts:
        "&id, decidedAt, expiresAt, outcome, authority, tier, channel, sessionId, runId, projectId, [channel+decidedAt], [sessionId+decidedAt], *surfaceIds",
    })

    // v140 — Provider diagnostics control plane. Additive history, balance,
    // scheduler-state, and endpoint rollback tables; no historical rows need
    // rewriting and legacy subscription snapshots remain intact.
    this.version(140).stores({
      providerDiagnosticJobs: "&id, providerId, status, startedAt, [providerId+startedAt]",
      providerDiagnosticSamples:
        "&id, jobId, targetId, providerId, modelId, status, startedAt, [providerId+startedAt], [targetId+startedAt]",
      providerBalanceSnapshots:
        "&id, providerId, sourceId, accountId, fetchedAt, [providerId+fetchedAt], [sourceId+fetchedAt]",
      providerDiagnosticsRefreshState:
        "&sourceId, providerId, status, nextDueAt, [providerId+nextDueAt]",
      providerEndpointChanges: "&id, providerId, appliedAt, rolledBackAt, [providerId+appliedAt]",
    })

    // v141 — Skill recorder source versions (ADR-0106). Additive only; no
    // upgrade hook, because the table is new.
    //
    // DEVICE-LOCAL BY CONSTRUCTION. This table appears in none of the
    // backup / sync / export allow-lists, and `lib/db/skill-recordings.test.ts`
    // asserts that rather than leaving the omission to be noticed later. A
    // recording is a video of the user's screen in all but name.
    //
    // The row holds the user's review edits and counts — never the capture. The
    // trace and every frame live in the native bundle under the app-data
    // directory, addressed by `bundleId`. That is what keeps a saved source
    // version immutable (re-opening replays edits over an untouched bundle) and
    // what keeps a 400-step recording from putting hundreds of megabytes of PNG
    // into IndexedDB.
    //
    // `[skillId+createdAt]` is the compound the "Recording versions" tab pages
    // through, newest first.
    this.version(141).stores({
      skillRecordings: "&id, skillId, status, updatedAt, [skillId+createdAt]",
    })

    // v142 — Epic 4: user-repo wiki corpora, terminal inbound review, and the
    // materialization outbox (ADR-0008 Phases 3–6).
    //
    // Three things happen here, and all three are additive-or-widening so a
    // rollback to v141 still finds every pre-existing row where it left it:
    //
    //  1. CORPUS ISOLATION. `wikiArticles.slug` was `&slug` — unique across the
    //     whole table. That was fine while `cognia-self` was the only corpus,
    //     and becomes a write collision the moment two repos each contain a
    //     `lib/utils`. The unique moves to `&[corpusId+slug]`; `slug` stays as
    //     a plain (non-unique) index so legacy slug-only lookups still resolve.
    //     Every wiki/RAG query must pass an explicit `corpusId` — there is
    //     deliberately no cross-corpus fallback, because silently answering
    //     from the wrong repo is worse than answering nothing.
    //
    //     `wikiManifest` is keyed by `scope`, which cannot express "many user
    //     repos". Dexie cannot repoint a primary key in place (same constraint
    //     that produced `hostSyncCursors` in v130), so `wikiCorpusManifest` is
    //     a new table and the legacy rows are copied, not moved.
    //
    //  2. TERMINAL REVIEW STATE. `inboundDrafts.status` allowed the triple
    //     `pending | accepted | discarded`, with no rule about what may follow
    //     what. It becomes `pending → accepted | rejected`, both terminal. The
    //     historical `discarded` value is rewritten to `rejected` here so the
    //     union has exactly one spelling for "the operator said no".
    //
    //  3. MATERIALIZATION OUTBOX. Accepting a draft has to flip its status and
    //     enqueue the work that turns it into a memory / Skill / note in ONE
    //     transaction, or a crash between the two silently drops the accept.
    //     `inboundMaterializations` is keyed by `draftId`, which makes the
    //     enqueue idempotent by construction: a retried accept overwrites its
    //     own row instead of queueing the work twice.
    this.version(142)
      .stores({
        // `&[corpusId+slug]` is the new uniqueness rule; `slug` survives as a
        // non-unique index. `[corpusId+module]` backs the per-repo module list.
        wikiArticles:
          "&id, slug, corpusId, scope, module, pageRank, generatedAt, [scope+module], &[corpusId+slug], [corpusId+module]",
        wikiSections: "&id, articleId, corpusId, [articleId+sectionIndex]",
        wikiCorpora: "&id, kind, enabled, createdAt",
        wikiCorpusManifest: "&corpusId, scope, lastBuildAt",
        wikiBuildJobs: "&id, corpusId, status, queuedAt, [corpusId+queuedAt], [corpusId+status]",
        // Staging is keyed by `buildId` so tearing down a cancelled build is a
        // range delete. No unique slug index here: a staged build may legally
        // hold a slug that the live corpus also holds, right up until the swap.
        wikiArticlesStaging: "&id, buildId, corpusId, [buildId+slug], [buildId+module]",
        wikiSectionsStaging: "&id, buildId, articleId, [articleId+sectionIndex]",
        // `[status+createdAt]` drives the review queue (pending, newest first).
        // `canonicalHash` is the dedup probe: the distiller refuses to create a
        // second draft for content it has already queued, so a crawler that
        // re-reads the same page and an IDE scanner that replays the same log
        // cannot flood the operator's queue with the same item.
        inboundDrafts: "&id, kind, status, createdAt, canonicalHash, [status+createdAt]",
        // Primary key IS the draft id — see (3) above.
        inboundMaterializations: "&draftId, status, kind, queuedAt, [status+queuedAt]",
        knowledgeNotes: "&id, createdAt, sourceDraftId, *tags",
      })
      .upgrade(async (tx) => {
        // (1) Backfill `corpusId`. Only `cognia-self` was ever buildable before
        // v142 (`user-repo` was the deferred Phase 3), so `scope` is the honest
        // source of truth and falls back to the self corpus for rows that
        // predate the field entirely.
        const articleCorpus = new Map<string, string>()
        await tx
          .table("wikiArticles")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            const corpusId = (row.corpusId as string) || (row.scope as string) || SELF_CORPUS_ID
            row.corpusId = corpusId
            articleCorpus.set(row.id as string, corpusId)
          })

        // Sections denormalize their parent's corpus. A section whose article
        // is already gone is an orphan from a partial delete; it gets the self
        // corpus rather than an undefined index entry that no query can reach.
        await tx
          .table("wikiSections")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            row.corpusId =
              (row.corpusId as string) ||
              articleCorpus.get(row.articleId as string) ||
              SELF_CORPUS_ID
          })

        // Copy (do not move) the scope-keyed manifests into the corpus-keyed
        // table. `manifestHash` is computed now so a full-rebuild confirmation
        // token can be bound to it on the very first post-upgrade estimate.
        const legacyManifests = (await tx.table("wikiManifest").toArray()) as WikiManifest[]
        if (legacyManifests.length > 0) {
          await tx.table("wikiCorpusManifest").bulkPut(
            legacyManifests.map((m) => ({
              corpusId: m.scope === "cognia-self" ? SELF_CORPUS_ID : m.scope,
              scope: m.scope,
              fileHashes: m.fileHashes ?? {},
              lastBuildAt: m.lastBuildAt ?? 0,
              articleCount: m.articleCount ?? 0,
              generatorVersion: m.generatorVersion ?? "",
              manifestHash: hashFileHashes(m.fileHashes ?? {}),
            }))
          )
        }

        // (2) One spelling for "the operator said no".
        await tx
          .table("inboundDrafts")
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.status === "discarded") row.status = "rejected"
          })
      })

    // v143 — Epic 5: sandbox connections gain a provider/driver split.
    //
    // The pre-v143 row was Docker-shaped (`image`/`host`/`port`/`containerId`
    // at the top level). It now carries `provider` × `driver` plus a
    // provider-specific `config`, a normalized lifecycle `state` and a
    // capability matrix, so cua.ai Cloud and Lume connections are describable
    // without a second table.
    //
    // The mapping itself lives in `lib/sandbox/connection-migration.ts` — pure
    // and unit-tested there — so this callback only walks the table. It is
    // idempotent: `migrateSandboxConnectionRows` returns already-migrated rows
    // untouched and reports `changed: 0`, so a re-run after a downgrade/upgrade
    // cycle neither rewrites nor clobbers a config the user has since edited.
    //
    // The four legacy top-level fields are deliberately NOT dropped: they are
    // dual-written for one compatibility release so a downgrade to the previous
    // build still finds a working Docker row.
    this.version(143)
      .stores({
        // `provider` and `state` are indexed so the connections tab can filter
        // without a full scan once several providers coexist.
        sandboxConnections: "&id, name, provider, state, createdAt, updatedAt",
      })
      .upgrade(async (tx) => {
        const { migrateSandboxConnectionRows } = await import("@/lib/sandbox/connection-migration")
        const table = tx.table("sandboxConnections")
        const rows = (await table.toArray()) as Parameters<
          typeof migrateSandboxConnectionRows
        >[0][number][]
        if (rows.length === 0) return
        const { rows: migrated, changed } = migrateSandboxConnectionRows(rows)
        if (changed === 0) return
        await table.bulkPut(migrated)
      })

    // v144 — Codex-inspired desktop workflow metadata. Project environments
    // and CDP authority are device-local by contract: none of these tables is
    // included in sync, backup, export, or Companion allow-lists. CDP audit
    // rows contain metadata only and are append-only through browser-cdp.ts.
    this.version(144).stores({
      projectEnvironments: "&id, projectId, isEnabled, updatedAt, [projectId+updatedAt]",
      cdpGrants:
        "&id, sessionId, browserSessionId, origin, expiresAt, revokedAt, [sessionId+expiresAt]",
      cdpAuditEvents:
        "&id, grantId, sessionId, browserSessionId, origin, outcome, createdAt, [sessionId+createdAt]",
    })

    // v145 — durable local AgentTeam execution. These tables are deliberately
    // device-local: trajectories can contain repository content and may only be
    // removed through explicit run/team/project cleanup.
    this.version(145).stores({
      agentTeamRuns: "&id, teamId, projectId, status, priority, updatedAt, [teamId+updatedAt]",
      agentTeamChildRuns:
        "&id, runId, teamId, teammateId, taskId, repositoryId, status, sessionId, updatedAt, [runId+updatedAt]",
      agentTeamTrajectory:
        "&id, runId, childRunId, sequence, kind, createdAt, [runId+sequence], [childRunId+sequence]",
      agentTeamCheckpoints:
        "&id, runId, childRunId, createdAt, [runId+createdAt], [childRunId+createdAt]",
      agentTeamDecisions: "&id, runId, version, status, createdAt, [runId+version]",
      agentTeamSteeringReceipts:
        "&id, runId, childRunId, status, updatedAt, [childRunId+updatedAt]",
      agentTeamEvidence:
        "&id, runId, childRunId, taskId, kind, createdAt, [runId+createdAt], [taskId+createdAt]",
      agentTeamDeliveryGraphs: "&id, runId, status, updatedAt",
      agentTeamDeliveryNodes:
        "&id, graphId, runId, repositoryId, order, status, updatedAt, [graphId+order]",
      agentTeamRetrospectives: "&id, runId, status, createdAt, updatedAt",
      agentTeamContentObjects: "&hash, mimeType, byteLength, createdAt",
      projectEnvironmentVersions:
        "&id, environmentId, projectId, version, createdAt, [environmentId+version]",
    })

    // v146 — reusable Agent Knowledge Bases. Sources are portable originals;
    // chunks are derived vector pointers; ingest jobs provide crash-visible
    // lifecycle state. Ownership is always explicit through knowledgeBaseId.
    this.version(146).stores({
      knowledgeBases: "&id, name, updatedAt",
      knowledgeBaseSources:
        "&id, knowledgeBaseId, status, fingerprint, updatedAt, [knowledgeBaseId+updatedAt], &[knowledgeBaseId+fingerprint]",
      knowledgeBaseChunks:
        "&id, knowledgeBaseId, sourceId, vectorDocId, [knowledgeBaseId+sourceId], [knowledgeBaseId+createdAt]",
      knowledgeBaseIngestJobs:
        "&id, knowledgeBaseId, sourceId, status, updatedAt, [knowledgeBaseId+status], [knowledgeBaseId+updatedAt]",
    })

    // v147 — single-Agent task board. Task metadata is portable; each retry
    // appends a separate attempt so results are never overwritten.
    this.version(147).stores({
      agentTasks:
        "&id, agentId, projectId, status, priority, scheduledFor, updatedAt, [agentId+status], [agentId+updatedAt]",
      agentTaskAttempts:
        "&id, taskId, agentId, status, attemptNo, schedulerExecutionId, updatedAt, [taskId+attemptNo], [taskId+updatedAt]",
    })

    // v148 — Immutable workflow versions + atomic environment deployments.
    // Legacy `published` rows become version 1 and an active production
    // deployment. The old publication envelope remains as a dual-read
    // projection for one compatibility release; draft edits never rewrite the
    // immutable artifact.
    this.version(148)
      .stores({
        workflowVersions: "&id, workflowId, [workflowId+sequence], digest, createdAt",
        workflowDeployments:
          "&id, &[accountId+workflowId+environment], workflowId, environment, versionId, status, updatedAt",
        workflowInvocations:
          "&id, &[accountId+entrypoint+deploymentId+caller+idempotencyKey], deploymentId, versionId, runId, status, createdAt",
      })
      .upgrade(async (tx) => {
        const accountId = accountIdFromDatabaseName(name) ?? "local_acct_a"
        const workflowTable = tx.table("workflows")
        const rows = (await workflowTable.toArray()) as WorkflowRow[]
        const versions: WorkflowVersion[] = []
        const deployments: WorkflowDeployment[] = []

        for (const workflow of rows) {
          if (!workflow.published) continue
          const version = createWorkflowVersion({
            workflow,
            workflowInterface: workflow.interface ?? {},
            accountId,
            sequence: 1,
            createdAt: workflow.published.at,
          })
          const deploymentId = workflowDeploymentId(accountId, workflow.id, "production")
          versions.push(version)
          deployments.push({
            id: deploymentId,
            accountId,
            workflowId: workflow.id,
            environment: "production",
            versionId: version.id,
            revision: 1,
            status: "active",
            createdAt: workflow.published.at,
            updatedAt: workflow.published.at,
          })
          await workflowTable.update(workflow.id, {
            published: {
              ...workflow.published,
              versionId: version.id,
              deploymentId,
              deploymentRevision: 1,
            },
          })
        }

        if (versions.length > 0) await tx.table("workflowVersions").bulkPut(versions)
        if (deployments.length > 0) await tx.table("workflowDeployments").bulkPut(deployments)
      })

    // v149 — durable, per-run workflow event cursors for HTTP/SSE replay.
    // Historical rows are ordered deterministically by timestamp then id;
    // every future event-log write allocates the next sequence transactionally.
    this.version(149)
      .stores({
        workflowRunEvents:
          "&id, runId, [runId+ts], [runId+sequence], stepId, [runId+stepId], type, projectId",
      })
      .upgrade(async (tx) => {
        const table = tx.table("workflowRunEvents")
        const rows = (await table.toArray()) as WorkflowRunEventRow[]
        rows.sort((left, right) =>
          left.runId === right.runId
            ? left.ts - right.ts || left.id.localeCompare(right.id)
            : left.runId.localeCompare(right.runId)
        )
        let runId = ""
        let sequence = 0
        for (const row of rows) {
          if (row.runId !== runId) {
            runId = row.runId
            sequence = 0
          }
          sequence += 1
          row.sequence = sequence
        }
        if (rows.length > 0) await table.bulkPut(rows)
      })

    // v150 — global trace-time index. Retention, recent-span, paging and
    // dashboard-window reads previously materialized and sorted the entire
    // high-write trace table. The existing compound indexes remain unchanged;
    // `startTime` adds a bounded global cursor for those hot paths.
    this.version(150).stores({
      agentTraces:
        "&id, startTime, sessionId, [sessionId+startTime], traceId, [traceId+startTime], parentSpanId, surface, projectId, [projectId+startTime]",
    })

    // v151 — MCP control plane. Legacy definitions stay operational, while
    // newly-created definitions use pending trust and host-owned credentials.
    // Duplicate legacy namespaces are fail-closed instead of silently
    // overwriting each other in the SDK's name-keyed map.
    this.version(151)
      .stores({
        mcpSyncJobs: "&id, status, nextAttemptAt, updatedAt",
        mcpCapabilityCache: "&id, serverId, expiresAt, updatedAt",
        mcpServerSummaries: "&id, updatedAt, trustState",
      })
      .upgrade(async (tx) => {
        const table = tx.table("mcpServers")
        const rows = (await table.toArray()) as McpServer[]
        const seen = new Set<string>()
        const summaries: McpServerSummary[] = []
        for (const row of rows.sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
        )) {
          const normalized = row.name.trim().toLocaleLowerCase("en-US")
          const duplicate = seen.has(normalized)
          seen.add(normalized)
          const builtin = row.name === A2UI_BRIDGE_SERVER_NAME
          row.displayName = row.displayName?.trim() || row.name
          row.schemaVersion = 1
          row.revision = row.revision ?? 1
          row.credentialVersion = row.credentialVersion ?? 0
          row.origin = row.origin ?? (builtin ? "builtin" : row.pluginId ? "plugin" : "manual")
          row.trust = duplicate
            ? { state: "blocked" }
            : (row.trust ?? { state: builtin ? "trusted" : "legacy" })
          if (duplicate) row.enabled = false
          summaries.push({
            id: row.id,
            displayName: row.displayName,
            transport: row.transport,
            enabled: row.enabled,
            trustState: row.trust.state,
            updatedAt: row.updatedAt,
          })
        }
        if (rows.length > 0) await table.bulkPut(rows)
        if (summaries.length > 0) await tx.table("mcpServerSummaries").bulkPut(summaries)
      })

    // v152 — Keep binary media outside message payloads while retaining a
    // small, indexed authorization/lifecycle ledger. Turn indexes support the
    // lazy transcript projection without rewriting legacy rows.
    this.version(152).stores({
      messages:
        "id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id], projectId, [projectId+createdAt], turnKey, [sessionId+turnKey]",
      messageMediaRefs: "[messageId+hash], sessionId, messageId, hash, [sessionId+hash]",
    })

    // v153 — Empty-on-upgrade lazy transcript index. First access writes only
    // the newest bounded page; older pages are added as the user scrolls.
    this.version(153).stores({
      chatTurnSummaries:
        "[sessionId+turnKey], sessionId, turnKey, [sessionId+order], revision, updatedAt",
      chatTranscriptIndexState: "sessionId, revision, updatedAt",
    })

    // v154 — Agent Skills portable identity. `slug` is intentionally not
    // indexed: it is a low-cardinality management field and uniqueness is
    // enforced transactionally by the Skill persistence seam.
    this.version(154).upgrade(async (tx) => {
      const table = tx.table<Skill, string>("skills")
      const rows = await table.toArray()
      const used = new Set<string>()
      rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      for (const row of rows) {
        row.slug = allocateUniqueSkillSlug(deriveMigratedSkillSlug(row), used)
      }
      if (rows.length > 0) await table.bulkPut(rows)
    })

    // v155 — Independent-session messaging. The payload is text-only and
    // carries explicit untrusted-agent provenance; receiver policy transitions
    // the durable receipt instead of treating enqueue success as delivery.
    this.version(155).stores({
      sessionPeerMessages:
        "&id, senderSessionId, receiverSessionId, status, expiresAt, [receiverSessionId+status], [senderSessionId+createdAt], [receiverSessionId+createdAt]",
    })

    // First full-chain construction under Jest: cache the merged spec so every
    // later construction in this worker takes the collapsed fast path above.
    if (isSchemaCollapseEnabled() && !collapsedSchemaCacheSlot().__cogniaCollapsedSchema) {
      collapsedSchemaCacheSlot().__cogniaCollapsedSchema = buildCollapsedSchema(this)
    }
  }

  // v141 — Skill recorder source versions (ADR-0106). Provenance + review
  // edits only; the capture itself lives in the native bundle. See
  // `lib/db/skill-recordings.ts`.
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
  // v100 — Project-scoped RAG chunks (workspace knowledge base). See
  // `lib/db/project-chunks.ts` and `@/types/project-knowledge`.
  projectChunks!: Table<ProjectChunk, string>
  // v65 — Autonomous long-term memory. See `lib/db/memories.ts`.
  memories!: Table<Memory, string>
  // v118 — immutable evidence, durable maintenance work, and decision audit.
  memoryEvidence!: Table<MemoryEvidence, string>
  memoryJobs!: Table<MemoryJob, string>
  memoryAuditEvents!: Table<MemoryAuditEvent, string>
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
    ? runtimeTargetDatabaseName(accountId, targetId)
    : accountDatabaseName(accountId)
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
