import type { StorageCategory } from "@/lib/storage/types"

export type DataTableRole = "authoritative" | "projection" | "cache" | "audit" | "queue"
export type DataSensitivity = "public" | "internal" | "confidential" | "secret"
export type DataAccountScope = "global" | "account" | "runtime-target" | "plugin"
export type DataBackupMode = "portable" | "device-local" | "derived" | "ephemeral"
export type DataSyncMode = "none" | "companion-readonly"
export type DataCleanupPolicy = "protected" | "quick" | "deep"
export type DataExpectedScale = "small" | "medium" | "large" | "very-large"
export type DataRetentionEnforcement = "central" | "domain" | "explicit-delete"

export interface DataRetentionPolicy {
  mode: "permanent" | "ttl" | "cap"
  days?: number
  maxRows?: number
  enforcement: DataRetentionEnforcement
  /** Deduplicated executor name consumed by the central retention sweeper. */
  executorId?: string
  reason: string
}

export interface DataTableCatalogEntry {
  name: string
  owner: string
  role: DataTableRole
  sensitivity: DataSensitivity
  accountScope: DataAccountScope
  backupPolicy: { mode: DataBackupMode; reason: string; rebuild?: string }
  syncPolicy: { mode: DataSyncMode; reason: string }
  retentionPolicy: DataRetentionPolicy
  deleteCascade: {
    account: boolean
    runtimeTarget: boolean
    plugin: boolean
    reason: string
  }
  storageCategory: StorageCategory
  cleanupPolicy: DataCleanupPolicy
  expectedScale: DataExpectedScale
  queryBudget: { hotReadMaxMs: number; pageSize: number }
}

/** Static Dexie stores declared by the current CogniaDB schema. Kept explicit so review and
 * CI can detect both an ungoverned new table and a stale catalog entry. */
export const CORE_TABLE_NAMES = [
  "a2uiApps",
  "a2uiEventHistory",
  "a2uiSurfaces",
  "a2uiTemplates",
  "actionReviewReceipts",
  "adapterInstances",
  "agentCanonicalSessions",
  "agentCompatibilityRecords",
  "agentPlanEvents",
  "agentPlans",
  "agentTaskAttempts",
  "agentTasks",
  "agentTeamBoard",
  "agentTeamCheckpoints",
  "agentTeamChildRuns",
  "agentTeamContentObjects",
  "agentTeamDecisions",
  "agentTeamDeliveryGraphs",
  "agentTeamDeliveryNodes",
  "agentTeamEvidence",
  "agentTeamRetrospectives",
  "agentTeamRuns",
  "agentTeamSteeringReceipts",
  "agentTeamTrajectory",
  "agentTraces",
  "approvedBinaries",
  "automationAuditLog",
  "backgroundTasks",
  "backupHistory",
  "behaviorEvents",
  "browserAnnotations",
  "browserDomainGrants",
  "browserProfiles",
  "browserRecordings",
  "calibrationItems",
  "calibrationRuns",
  "cannedResponses",
  "canvasComments",
  "canvasDocuments",
  "canvasSessions",
  "canvasVersions",
  "capabilityGrants",
  "capturedItems",
  "cdpAuditEvents",
  "cdpGrants",
  "characters",
  "chatDrafts",
  "chatGoalEvents",
  "chatGoals",
  "chatInputHistory",
  "chatSearchState",
  "chatSearchText",
  "chatTemplates",
  "chatTranscriptIndexState",
  "chatTurnSummaries",
  "codeAdoptionTurns",
  "collabIssues",
  "collabWorkspaces",
  "collabPlans",
  "collabRuns",
  "connectorAttachments",
  "connectorAudit",
  "connectorCallbackBindings",
  "connectorCleanupJobs",
  "connectorConversationStates",
  "connectorDrafts",
  "connectorHeartbeats",
  "connectorInboundJobs",
  "contextComments",
  "conversationAssignmentEvents",
  "conversationLabels",
  "conversationOverrides",
  "deploymentProfiles",
  "evalAdjudications",
  "evalAssets",
  "evalCases",
  "evalConfigurationApplies",
  "evalDatasetVersions",
  "evalDatasets",
  "evalExperiments",
  "evalProjects",
  "evalRecommendations",
  "evalReviewBatches",
  "evalReviewVotes",
  "evalRunCaseResults",
  "evalRuns",
  "evalSamples",
  "evalScores",
  "evalTasks",
  "executionContextBundles",
  "executionRunBindings",
  "executionRunEvents",
  "executionRunInterrupts",
  "executionRuns",
  "externalIdentities",
  "feishuPrincipalBindRequests",
  "feishuPrincipals",
  "feishuTenants",
  "fleetSessions",
  "gatewayRequestLog",
  "githubIssueMirror",
  "governanceConflicts",
  "governanceDecisionEvents",
  "governanceDecisions",
  "governanceEvidence",
  "governanceLineage",
  "governanceProvenance",
  "goalTemplates",
  "hostDispatchQueue",
  "hostStateActions",
  "hostStateChannels",
  "hostStateMeta",
  "hostSyncCursors",
  "inboundDrafts",
  "inboundLedger",
  "inboundMaterializations",
  "inboxTelemetryEvents",
  "integrationAccounts",
  "integrationActionJobs",
  "integrationAudit",
  "integrationEvents",
  "integrationSubscriptions",
  "issueCounters",
  "issueEvents",
  "issueProjects",
  "issueRuns",
  "issues",
  "knowledgeBaseChunks",
  "knowledgeBaseIngestJobs",
  "knowledgeBaseSources",
  "knowledgeBases",
  "knowledgeNotes",
  "labels",
  "larkChatSurfaces",
  "larkEntryContexts",
  "larkMessageImports",
  "larkWebSessions",
  "loopEvents",
  "loops",
  "matrixPendingEncryptedEvents",
  "mcpAuditLog",
  "mcpCapabilityCache",
  "mcpServers",
  "mcpServerSummaries",
  "mcpSyncJobs",
  "memories",
  "memoryAuditEvents",
  "memoryEvidence",
  "memoryJobs",
  "messageMedia",
  "messageMediaRefs",
  "messages",
  "mobileOutboundQueue",
  "mobileStepReceipts",
  "modelsDevCatalog",
  "notifications",
  "ocrResults",
  "openApiImports",
  "openVsxCache",
  "openrouterCatalog",
  "opticalArchives",
  "orgMemberships",
  "orgs",
  "outboundQueue",
  "pairedDevices",
  "performanceCaptureAttachments",
  "performanceCaptureChunks",
  "performanceCaptureGaps",
  "performanceCaptures",
  "petAchievements",
  "petActivityLog",
  "petCharacterBindings",
  "petConversation",
  "petInventory",
  "petModelFiles",
  "petModels",
  "petProfile",
  "petSpritePacks",
  "platformIdentities",
  "pluginAnalytics",
  "pluginDexieMeta",
  "pluginMarketplaceSources",
  "pluginPermissions",
  "pluginReviews",
  "pluginSkillUsage",
  "plugins",
  "profileStoreMeta",
  "projectChunks",
  "projectEnvironmentVersions",
  "projectEnvironments",
  "projects",
  "promptPresets",
  "providerBalanceSnapshots",
  "providerCatalogAliases",
  "providerCatalogModels",
  "providerCatalogOfferings",
  "providerCatalogProviders",
  "providerCatalogRevisions",
  "providerCatalogState",
  "providerConnectionInventory",
  "providerCostDaily",
  "providerDiagnosticJobs",
  "providerDiagnosticSamples",
  "providerDiagnosticsRefreshState",
  "providerEndpointChanges",
  "providerLimits",
  "providerProfiles",
  "radarReports",
  "remoteControlAudit",
  "remoteControlRunStatus",
  "retrievalActivePointers",
  "retrievalEncryptedContent",
  "retrievalGenerations",
  "retrievalJobs",
  "retrievalMigrationJournal",
  "retrievalProfiles",
  "retrievalRuntimeState",
  "retrievalTombstones",
  "retrievalTraces",
  "runLearningProposals",
  "runRecords",
  "runRetrospectives",
  "sandboxConnections",
  "serviceConnections",
  "sessionAttachmentUploads",
  "sessionFolders",
  "sessionPeerMessages",
  "sessionState",
  "sessionUsage",
  "sessions",
  "settings",
  "sharedLinks",
  "siteArtifacts",
  "siteDeployments",
  "siteEnvironmentRevisions",
  "siteOperationEvents",
  "siteOperations",
  "siteProjects",
  "siteResources",
  "siteVersions",
  "skillRecordings",
  "skillResources",
  "skills",
  "subscriptionBalance",
  "subscriptionUsage",
  "syncTombstones",
  "teamPrObservations",
  "teams",
  "templateDefinitions",
  "templateDeviceBindings",
  "templateInstances",
  "templateMigrationJournal",
  "templatePackages",
  "terminalHistory",
  "toolRoutes",
  "traceAnnotations",
  "transportProfiles",
  "trustedPublishers",
  "trustedWorkspaces",
  "tts_provider_keys",
  "twinChunks",
  "twinDrafts",
  "twinJobs",
  "twinProfile",
  "twinSources",
  "twins",
  "unattendedExecAudit",
  "users",
  "vscodeExtensionRuntime",
  "wasmGrantLedger",
  "wikiArticles",
  "wikiArticlesStaging",
  "wikiBuildJobs",
  "wikiCorpora",
  "wikiCorpusManifest",
  "wikiLintResults",
  "wikiManifest",
  "wikiSections",
  "wikiSectionsStaging",
  "workflowDeployments",
  "workflowAnnotationSetRevisions",
  "workflowAnnotationSets",
  "workflowAppApiKeys",
  "workflowAppReleases",
  "workflowApps",
  "workflowBatchJobs",
  "workflowBatchRows",
  "workflowConversationMessages",
  "workflowConversationReleaseEvents",
  "workflowConversationSummaries",
  "workflowConversations",
  "workflowFanoutSubscriptions",
  "workflowFeedbackCandidates",
  "workInputBatches",
  "workSubmissions",
  "workflowFolders",
  "workflowHumanInputFiles",
  "workflowHumanInputRequests",
  "workflowHumanInputSubmissions",
  "workflowInvocations",
  "workflowKnowledgeArtifacts",
  "workflowProposalHistory",
  "workflowReviewSuggestions",
  "workflowReviews",
  "workflowRunEvents",
  "workflowRuns",
  "workflowTriggers",
  "workflowVersions",
  "workflowViewportBookmarks",
  "workflowWaitEvents",
  "workflowWaitpoints",
  "workflows",
  "workspaceMemberships",
] as const

export type CoreTableName = (typeof CORE_TABLE_NAMES)[number]

/** BackupPayloadV3 field (or adapter field) that round-trips each portable
 * table. Several Provider Profile Store tables intentionally share one
 * validated/redacted document. Secret-bearing tables are deliberately absent;
 * legacy packages carrying their old optional fields remain importable. */
export const PORTABLE_BACKUP_BINDINGS = {
  settings: "settings",
  characters: "characters",
  skills: "skills",
  skillResources: "skillResources",
  teams: "teams",
  promptPresets: "promptPresets",
  mcpServers: "mcpServers",
  sessions: "sessions",
  messages: "messages",
  sessionState: "sessionState",
  trustedWorkspaces: "trustedWorkspaces",
  canvasDocuments: "canvasDocuments",
  canvasVersions: "canvasVersions",
  contextComments: "contextComments",
  canvasSessions: "canvasSessions",
  a2uiApps: "a2uiApps",
  a2uiTemplates: "a2uiTemplates",
  a2uiEventHistory: "a2uiEventHistory",
  twinSources: "twinSources",
  twinChunks: "twinChunks",
  twinProfile: "twinProfile",
  twinDrafts: "twinDrafts",
  twinJobs: "twinJobs",
  memories: "memories",
  memoryEvidence: "memoryEvidence",
  memoryJobs: "memoryJobs",
  memoryAuditEvents: "memoryAuditEvents",
  retrievalProfiles: "retrievalProfiles",
  retrievalEncryptedContent: "retrievalEncryptedContent",
  plugins: "plugins",
  pluginPermissions: "pluginPermissions",
  pluginReviews: "pluginReviews",
  pluginAnalytics: "pluginAnalytics",
  templateDefinitions: "templateDefinitions",
  templatePackages: "templatePackages",
  templateInstances: "templateInstances",
  providerProfiles: "providerProfileStore",
  deploymentProfiles: "providerProfileStore",
  transportProfiles: "providerProfileStore",
  profileStoreMeta: "providerProfileStore",
} as const satisfies Partial<Record<CoreTableName, string>>

export const PORTABLE_BACKUP_TABLES = new Set<CoreTableName>(
  Object.keys(PORTABLE_BACKUP_BINDINGS) as CoreTableName[]
)

export const COMPANION_SYNC_TABLES = new Set<CoreTableName>([
  "characters",
  "skills",
  "sessions",
  "messages",
  "workflows",
  "twinProfile",
  "plugins",
  "adapterInstances",
  "settings",
  "conversationOverrides",
  "chatGoals",
  "agentPlans",
  "memories",
  "executionRuns",
  "workflowRuns",
  "mcpServers",
  "terminalHistory",
  "agentTeamBoard",
  "agentTasks",
  "agentTaskAttempts",
  "templateDefinitions",
  "templatePackages",
  "templateInstances",
  // ADR-0131 cross-shell inbox relay: drafts sync in full; outboundQueue
  // syncs as a status projection (`syncedFromHost: true`, no segments).
  "connectorDrafts",
  "outboundQueue",
])

/**
 * Public protocol names. `goals` is the stable wire alias for `chatGoals`, and
 * `plans` the alias for `agentPlans` (ADR-0045).
 */
export const COMPANION_SYNC_PROTOCOL_TABLE_NAMES = [
  "characters",
  "skills",
  "sessions",
  "messages",
  "workflows",
  "twinProfile",
  "plugins",
  "adapterInstances",
  "settings",
  "conversationOverrides",
  "goals",
  "plans",
  "memories",
  "executionRuns",
  "workflowRuns",
  "mcpServers",
  "terminalHistory",
  "agentTeamBoard",
  "agentTasks",
  "agentTaskAttempts",
  "templateDefinitions",
  "templatePackages",
  "templateInstances",
  "connectorDrafts",
  "outboundQueue",
] as const

export type CompanionSyncProtocolTableName = (typeof COMPANION_SYNC_PROTOCOL_TABLE_NAMES)[number]

const CACHE_TABLES = new Set<CoreTableName>([
  "a2uiSurfaces",
  "agentTeamBoard",
  "chatSearchState",
  "chatSearchText",
  "chatTranscriptIndexState",
  "collabIssues",
  "collabWorkspaces",
  "collabPlans",
  "collabRuns",
  "githubIssueMirror",
  "hostSyncCursors",
  "knowledgeBaseChunks",
  "modelsDevCatalog",
  "mcpCapabilityCache",
  "openVsxCache",
  "openrouterCatalog",
  "projectChunks",
  "providerCatalogAliases",
  "providerCatalogModels",
  "providerCatalogOfferings",
  "providerCatalogProviders",
  "providerCatalogRevisions",
  "providerCatalogState",
  "providerConnectionInventory",
  "remoteControlRunStatus",
  "retrievalActivePointers",
  "retrievalGenerations",
  "syncTombstones",
  "twinChunks",
  "vscodeExtensionRuntime",
  "wikiArticlesStaging",
  "wikiSectionsStaging",
])

const PROJECTION_TABLES = new Set<CoreTableName>([
  "agentCanonicalSessions",
  "agentCompatibilityRecords",
  "agentTeamBoard",
  "chatSearchText",
  "chatTurnSummaries",
  // ADR-0149 §6 — the collaboration server owns people, orgs and
  // membership. The client keeps a readable copy so a roster renders
  // without a round trip; it is never where a permission is decided.
  "externalIdentities",
  "hostStateChannels",
  "mcpServerSummaries",
  "messageMediaRefs",
  "orgMemberships",
  "orgs",
  "profileStoreMeta",
  "providerCostDaily",
  "remoteControlRunStatus",
  "retrievalActivePointers",
  "retrievalGenerations",
  "users",
  "workspaceMemberships",
])

// Cleanup is deliberately more conservative than role inference. A table may
// be a cache/queue/audit without being safe for a generic storage action (for
// example sync cursors, user-created recordings, and pending work). Only rows
// whose owning module has declared them rebuildable or disposable belong here.
const QUICK_CLEANUP_TABLES = new Set<CoreTableName>([
  "a2uiSurfaces",
  "chatSearchState",
  "chatSearchText",
  "chatTranscriptIndexState",
  "collabIssues",
  "collabWorkspaces",
  "collabPlans",
  "collabRuns",
  "githubIssueMirror",
  "knowledgeBaseChunks",
  "modelsDevCatalog",
  "mcpCapabilityCache",
  "mcpServerSummaries",
  "openVsxCache",
  "openrouterCatalog",
  "projectChunks",
  "providerCatalogAliases",
  "providerCatalogModels",
  "providerCatalogOfferings",
  "providerCatalogProviders",
  "providerCatalogRevisions",
  "providerCatalogState",
  "providerConnectionInventory",
  "remoteControlRunStatus",
  "twinChunks",
  "vscodeExtensionRuntime",
  "wikiArticlesStaging",
  "wikiSectionsStaging",
])

const DEEP_CLEANUP_TABLES = new Set<CoreTableName>([
  "agentTraces",
  "automationAuditLog",
  "backupHistory",
  "connectorAudit",
  "gatewayRequestLog",
  "inboxTelemetryEvents",
  "integrationAudit",
  "mcpAuditLog",
  "remoteControlAudit",
  "unattendedExecAudit",
])

// These names look like generic queues/audit logs, but the rows are part of a
// user-visible domain history or are the desktop source of truth. Keeping the
// overrides explicit prevents naming heuristics from silently changing their
// backup/retention semantics.
const AUTHORITATIVE_ROLE_OVERRIDES = new Set<CoreTableName>([
  "agentTasks",
  "browserRecordings",
  "chatInputHistory",
  "conversationOverrides",
  "evalTasks",
  "skillRecordings",
  "terminalHistory",
])

const AUDIT_TABLES = new Set<CoreTableName>([
  ...CORE_TABLE_NAMES.filter((name) =>
    /Audit|Events$|History$|Receipts$|Traces$|Trajectory$|Observations$|Recordings$|Usage$/.test(
      name
    )
  ),
  "governanceConflicts",
  "governanceDecisions",
  "governanceEvidence",
  "governanceLineage",
  "governanceProvenance",
  "hostStateActions",
])

const QUEUE_TABLES = new Set<CoreTableName>(
  CORE_TABLE_NAMES.filter((name) =>
    /Jobs$|Queue$|Tasks$|Interrupts$|Materializations$|BindRequests$/.test(name)
  )
)
QUEUE_TABLES.add("matrixPendingEncryptedEvents")
// Named for the work it carries rather than the queue it is, so the suffix
// heuristic above misses it. The row tracks dispatch responsibility only.
QUEUE_TABLES.add("workSubmissions")

const SECRET_TABLES = new Set<CoreTableName>(["tts_provider_keys"])

/** Stores whose rows hold encrypted user content rather than ids and metadata. */
const CONFIDENTIAL_TABLES = new Set<CoreTableName>([
  "collabIssues",
  "collabWorkspaces",
  "collabPlans",
  "collabRuns",
  "githubIssueMirror",
  "hostDispatchQueue",
  "issueEvents",
  "issueRuns",
  "issues",
  "matrixPendingEncryptedEvents",
  "workInputBatches",
  "executionContextBundles",
])

const GLOBAL_TABLES = new Set<CoreTableName>([
  "modelsDevCatalog",
  "openrouterCatalog",
  "providerCatalogAliases",
  "providerCatalogModels",
  "providerCatalogOfferings",
  "providerCatalogProviders",
  "providerCatalogRevisions",
  "providerCatalogState",
  "trustedPublishers",
])

const RUNTIME_TARGET_TABLES = new Set<CoreTableName>([
  "hostStateActions",
  "hostStateChannels",
  "hostStateMeta",
  "hostSyncCursors",
  "syncTombstones",
])

const VERY_LARGE_TABLES = new Set<CoreTableName>([
  "agentTraces",
  "behaviorEvents",
  "connectorAudit",
  "executionRunEvents",
  "gatewayRequestLog",
  "inboxTelemetryEvents",
  "memoryAuditEvents",
  "messages",
  "matrixPendingEncryptedEvents",
  "projectChunks",
  "retrievalEncryptedContent",
  "twinChunks",
  "workflowRunEvents",
])

const LARGE_TABLES = new Set<CoreTableName>([
  "a2uiEventHistory",
  "agentTeamTrajectory",
  "automationAuditLog",
  "browserRecordings",
  "codeAdoptionTurns",
  "evalSamples",
  "evalScores",
  "integrationEvents",
  "issueEvents",
  "mcpAuditLog",
  "messageMedia",
  "sessionUsage",
  "terminalHistory",
  "wikiArticles",
  "wikiSections",
])

const STORAGE_CATEGORY_OVERRIDES: Partial<Record<CoreTableName, StorageCategory>> = {
  settings: "settings",
  sessions: "session",
  messages: "chat",
  messageMediaRefs: "chat",
  chatTranscriptIndexState: "chat",
  chatTurnSummaries: "chat",
  sessionState: "chat",
  sessionPeerMessages: "session",
  characters: "character",
  skills: "skill",
  skillResources: "skill",
  teams: "team",
  mcpServers: "mcp",
  mcpCapabilityCache: "mcp",
  mcpServerSummaries: "mcp",
  mcpSyncJobs: "mcp",
  promptPresets: "preset",
  canvasDocuments: "canvas",
  canvasVersions: "canvas",
  canvasComments: "canvas",
  canvasSessions: "canvas",
  trustedWorkspaces: "trustedWorkspace",
  tts_provider_keys: "ttsKey",
  backupHistory: "backupHistory",
}

function ownerFor(name: CoreTableName): string {
  const prefix = name.match(
    /^(agentTeam|agent|workflow|provider|plugin|connector|integration|twin|wiki|eval|site|pet|browser|canvas|memory|retrieval|session|chat|template|knowledgeBase)/
  )?.[1]
  return prefix ?? "core"
}

function roleFor(name: CoreTableName): DataTableRole {
  if (AUTHORITATIVE_ROLE_OVERRIDES.has(name)) return "authoritative"
  if (QUEUE_TABLES.has(name)) return "queue"
  if (CACHE_TABLES.has(name)) return "cache"
  if (PROJECTION_TABLES.has(name)) return "projection"
  if (AUDIT_TABLES.has(name)) return "audit"
  return "authoritative"
}

function backupFor(
  name: CoreTableName,
  role: DataTableRole
): DataTableCatalogEntry["backupPolicy"] {
  if (PORTABLE_BACKUP_TABLES.has(name)) {
    return { mode: "portable", reason: "User-owned data represented by BackupPayloadV3." }
  }
  if (role === "cache" || role === "projection") {
    return {
      mode: "derived",
      reason: "Rebuilt from an authoritative source.",
      rebuild: `Rebuild ${name} from its owning module.`,
    }
  }
  if (role === "queue") {
    return { mode: "ephemeral", reason: "Operational work state is recovered or replayed locally." }
  }
  return {
    mode: "device-local",
    reason: "Contains device-scoped state or is not portable by contract.",
  }
}

const WORKFLOW_APP_ROW_EXPIRY: DataRetentionPolicy = {
  mode: "ttl",
  days: 30,
  enforcement: "central",
  executorId: "workflowAppData",
  reason:
    "Rows carry a release-frozen expiry and are removed by the central Workflow App data sweep.",
}

const RETENTION_OVERRIDES: Partial<Record<CoreTableName, DataRetentionPolicy>> = {
  connectorAudit: {
    mode: "ttl",
    days: 30,
    enforcement: "domain",
    reason:
      "Connector housekeeping applies 7-day diagnostic, 14-day operational, and 30-day security tiers.",
  },
  connectorHeartbeats: {
    mode: "ttl",
    days: 2,
    enforcement: "domain",
    reason: "Connector housekeeping prunes the dedicated heartbeat table after 48 hours.",
  },
  connectorInboundJobs: {
    mode: "ttl",
    days: 30,
    enforcement: "domain",
    reason:
      "Terminal inbound jobs are compacted immediately and retained for 7 or 30 days by outcome.",
  },
  matrixPendingEncryptedEvents: {
    mode: "cap",
    maxRows: 10_000,
    enforcement: "domain",
    reason:
      "The Matrix E2EE runtime caps active recovery rows per adapter and retains recovery-required rows until explicit recovery or adapter deletion.",
  },
  agentTraces: {
    mode: "ttl",
    days: 30,
    enforcement: "central",
    executorId: "agentTraces",
    reason: "The storage retention sweeper prunes spans through the global startTime index.",
  },
  // Deliberately permanent even though its subject (`agentTraces`) is not.
  // An annotation is hand-authored error analysis — the open-coded "first
  // failure" note and its axial-coding cluster label — so it is authoritative
  // user data, not telemetry, and outliving the span it describes is correct.
  // Do NOT give this table a TTL to "match" agentTraces: that deletes the
  // user's own analysis. Annotations whose trace has been pruned are surfaced
  // as orphaned by `listAnnotationsWithTraceState`.
  traceAnnotations: {
    mode: "permanent",
    enforcement: "explicit-delete",
    reason:
      "Hand-authored failure analysis is authoritative user data and deliberately outlives the 30-day span window it annotates.",
  },
  evalSamples: {
    mode: "ttl",
    enforcement: "central",
    executorId: "evalArtifacts",
    reason: "Rows carry expiresAt and are removed by the central eval-artifact sweep.",
  },
  evalAssets: {
    mode: "ttl",
    enforcement: "central",
    executorId: "evalArtifacts",
    reason: "Unreferenced rows carry expiresAt and are removed by the central eval-artifact sweep.",
  },
  ocrResults: {
    mode: "ttl",
    days: 30,
    enforcement: "central",
    executorId: "ocrResults",
    reason: "The storage retention sweeper prunes cached OCR output through the createdAt index.",
  },
  hostDispatchQueue: {
    mode: "ttl",
    days: 7,
    enforcement: "domain",
    reason:
      "The Host dispatch runtime deletes terminal payloads after the bounded recovery and diagnostics window.",
  },
  workInputBatches: {
    mode: "ttl",
    days: 30,
    enforcement: "central",
    executorId: "workSubmissions",
    reason:
      "Frozen model-side input carries expiresAt and is removed by the central work-submission sweep once a replay is no longer possible.",
  },
  executionContextBundles: {
    mode: "ttl",
    days: 30,
    enforcement: "central",
    executorId: "workSubmissions",
    reason:
      "Frozen execution context carries expiresAt and is removed by the central work-submission sweep alongside its input batch.",
  },
  sharedLinks: WORKFLOW_APP_ROW_EXPIRY,
  workflowBatchJobs: WORKFLOW_APP_ROW_EXPIRY,
  workflowConversations: WORKFLOW_APP_ROW_EXPIRY,
  workflowFeedbackCandidates: WORKFLOW_APP_ROW_EXPIRY,
  workflowHumanInputFiles: WORKFLOW_APP_ROW_EXPIRY,
  workflowKnowledgeArtifacts: WORKFLOW_APP_ROW_EXPIRY,
  workflowWaitEvents: WORKFLOW_APP_ROW_EXPIRY,
  terminalHistory: {
    mode: "cap",
    maxRows: 5_000,
    enforcement: "domain",
    reason: "The terminal history writer trims least-recently-used commands after insert.",
  },
  remoteControlAudit: {
    mode: "cap",
    maxRows: 1_000,
    enforcement: "domain",
    reason: "The remote-control audit writer trims oldest rows after append.",
  },
  unattendedExecAudit: {
    mode: "cap",
    maxRows: 1_000,
    enforcement: "domain",
    reason: "The unattended-execution audit writer trims oldest rows after append.",
  },
  sessionUsage: {
    mode: "ttl",
    days: 90,
    enforcement: "domain",
    reason: "Provider-cost initializers prune usage older than 90 days.",
  },
  outboundQueue: {
    mode: "ttl",
    days: 14,
    enforcement: "domain",
    reason: "The connector runtime prunes terminal outbound jobs after 14 days.",
  },
  actionReviewReceipts: {
    mode: "ttl",
    days: 90,
    enforcement: "domain",
    reason: "Receipts receive an indexed expiresAt when written and are pruned by their owner.",
  },
  behaviorEvents: {
    mode: "cap",
    enforcement: "domain",
    reason: "The behavior-event writer applies its caller-provided age and row caps.",
  },
  notifications: {
    mode: "cap",
    enforcement: "domain",
    reason: "The notification writer applies user-configured age and item limits after delivery.",
  },
}

function retentionFor(name: CoreTableName, role: DataTableRole): DataRetentionPolicy {
  const override = RETENTION_OVERRIDES[name]
  if (override) return override
  return {
    mode: "permanent",
    enforcement: "explicit-delete",
    reason:
      role === "authoritative"
        ? "Authoritative user data is retained until an explicit domain delete."
        : "No generic timestamp/cap contract is approved; the owner must delete rows explicitly.",
  }
}

function createEntry(name: CoreTableName): DataTableCatalogEntry {
  const role = roleFor(name)
  const accountScope: DataAccountScope = GLOBAL_TABLES.has(name)
    ? "global"
    : RUNTIME_TARGET_TABLES.has(name)
      ? "runtime-target"
      : "account"
  return {
    name,
    owner: ownerFor(name),
    role,
    sensitivity: SECRET_TABLES.has(name)
      ? "secret"
      : CONFIDENTIAL_TABLES.has(name)
        ? "confidential"
        : /messages|Drafts|Sources|Evidence|ContentObjects/.test(name)
          ? "confidential"
          : "internal",
    accountScope,
    backupPolicy: backupFor(name, role),
    syncPolicy: COMPANION_SYNC_TABLES.has(name)
      ? { mode: "companion-readonly", reason: "Desktop-authoritative offline mirror." }
      : { mode: "none", reason: "Not exposed through the Companion data plane." },
    retentionPolicy: retentionFor(name, role),
    deleteCascade: {
      account: accountScope !== "global",
      runtimeTarget: accountScope === "runtime-target",
      plugin: name.startsWith("plugin"),
      reason:
        accountScope === "global"
          ? "Global catalog data survives account deletion."
          : accountScope === "runtime-target"
            ? "Deleted with the owning RuntimeTarget or account database."
            : "Deleted with the owning account database.",
    },
    storageCategory: STORAGE_CATEGORY_OVERRIDES[name] ?? "other",
    cleanupPolicy: QUICK_CLEANUP_TABLES.has(name)
      ? "quick"
      : DEEP_CLEANUP_TABLES.has(name)
        ? "deep"
        : "protected",
    expectedScale: VERY_LARGE_TABLES.has(name)
      ? "very-large"
      : LARGE_TABLES.has(name)
        ? "large"
        : "medium",
    queryBudget: { hotReadMaxMs: VERY_LARGE_TABLES.has(name) ? 100 : 50, pageSize: 500 },
  }
}

export const DATA_TABLE_CATALOG: readonly DataTableCatalogEntry[] =
  CORE_TABLE_NAMES.map(createEntry)
const CATALOG_BY_NAME = new Map(DATA_TABLE_CATALOG.map((entry) => [entry.name, entry]))

/** Mandatory default for `<pluginId>:<table>` stores until phase 5 moves them
 * into per-plugin databases. Unknown non-plugin stores deliberately return
 * undefined so the governance gate fails closed. */
export function policyForTable(name: string): DataTableCatalogEntry | undefined {
  const exact = CATALOG_BY_NAME.get(name)
  if (exact) return exact
  if (!name.includes(":")) return undefined
  return {
    name,
    owner: name.slice(0, name.indexOf(":")),
    role: "authoritative",
    sensitivity: "confidential",
    accountScope: "plugin",
    backupPolicy: {
      mode: "device-local",
      reason: "Dynamic plugin data requires an explicit portable exporter.",
    },
    syncPolicy: {
      mode: "none",
      reason: "Plugin tables are never exposed to Companion sync by default.",
    },
    retentionPolicy: {
      mode: "permanent",
      enforcement: "explicit-delete",
      reason: "Retained until explicit plugin purge or plugin-owned cleanup.",
    },
    deleteCascade: {
      account: true,
      runtimeTarget: false,
      plugin: true,
      reason: "Purged with the owning account or plugin.",
    },
    storageCategory: "other",
    cleanupPolicy: "protected",
    expectedScale: "medium",
    queryBudget: { hotReadMaxMs: 100, pageSize: 500 },
  }
}

export function tableNamesForCategory(
  category: StorageCategory,
  runtimeTableNames: readonly string[] = CORE_TABLE_NAMES
): string[] {
  return runtimeTableNames.filter((name) => policyForTable(name)?.storageCategory === category)
}

/** Central retention executors requested by governed tables, de-duplicated in
 * catalog order so runtime scheduling is deterministic. */
export function centralRetentionExecutorIds(): string[] {
  return [
    ...new Set(
      DATA_TABLE_CATALOG.flatMap((entry) =>
        entry.retentionPolicy.enforcement === "central" && entry.retentionPolicy.executorId
          ? [entry.retentionPolicy.executorId]
          : []
      )
    ),
  ]
}
