import type { StorageCategory } from "@/lib/storage/types"

export type DataTableRole = "authoritative" | "projection" | "cache" | "audit" | "queue"
export type DataSensitivity = "public" | "internal" | "confidential" | "secret"
export type DataAccountScope = "global" | "account" | "runtime-target" | "plugin"
export type DataBackupMode = "portable" | "device-local" | "derived" | "ephemeral"
export type DataSyncMode = "none" | "companion-readonly"
export type DataCleanupPolicy = "protected" | "quick" | "deep"
export type DataExpectedScale = "small" | "medium" | "large" | "very-large"
export type DataRetentionEnforcement = "central" | "domain" | "explicit-delete"
export type DataContentProtection = "encrypted-content" | "metadata-only" | "secret-externalized"

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
  contentProtection: DataContentProtection
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
  "accountContentMigrations",
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
  "agentTeamTasks",
  "agentTeamTrajectory",
  "agentTeammates",
  "agentTeams",
  "agentTraces",
  "approvedBinaries",
  "artifactVersions",
  "artifacts",
  "automationAuditLog",
  "backgroundTasks",
  "backupHistory",
  "behaviorEvents",
  "browserAnnotations",
  "browserDomainGrants",
  "browserProfiles",
  "browserRecordings",
  "browserSubmissions",
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
  "chatResultIndex",
  "chatResultIndexState",
  "chatSearchState",
  "chatSearchText",
  "chatTemplates",
  "chatTranscriptIndexState",
  "chatTurnSummaries",
  "codeAdoptionTurns",
  "collabIssues",
  "collabChatApprovals",
  "collabChatAttachments",
  "collabChatEvents",
  "collabChatInvites",
  "collabChatMemberships",
  "collabChatSessions",
  "collabChatSyncStates",
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
  "evalObservations",
  "evalOnlineBudget",
  "evalOnlinePolicies",
  "evalOnlineQueue",
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
  "externalAgentConfigHeads",
  "externalAgentConfigRevisions",
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
  "mentionLinks",
  "mentionLinkState",
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
  "projectMiningRuns",
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
  "siteBuildLogs",
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
  "storageLayout",
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
  "threadHandoffTickets",
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
  artifacts: "artifacts",
  artifactVersions: "artifactVersions",
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
  // v215 — Squad definitions. The phone reached the RUNS of a squad long
  // before it could see the squad itself, so a paired device listed nothing
  // to run. Definitions, roster and tasks all cross.
  "agentTeams",
  "agentTeammates",
  "agentTeamTasks",
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
  "agentTeams",
  "agentTeammates",
  "agentTeamTasks",
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
  // Browser Companion side-notes (v199). A projection, not a record: the
  // session it points at owns the instruction and the page text, and this row
  // holds only what the extension's recent list cannot get from anywhere else.
  // Losing it costs a history list, never a task.
  "browserSubmissions",
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
// A history-backfill run is a lease, a keyset cursor and three counters, held
// under the same protocol `claimMemoryJob` uses. The claims it produces are
// ordinary portable memories, so the run row itself is recoverable work state.
QUEUE_TABLES.add("projectMiningRuns")

const SECRET_TABLES = new Set<CoreTableName>(["tts_provider_keys"])

const SECRET_EXTERNALIZED_TABLES = new Set<CoreTableName>(["tts_provider_keys"])

const AUTO_INCREMENT_METADATA_TABLES = new Set<CoreTableName>([
  "chatInputHistory",
  "petActivityLog",
  "petConversation",
  "providerLimits",
  "subscriptionBalance",
  "subscriptionUsage",
])

const USER_CONTENT_TABLES = new Set<CoreTableName>([
  // Squad definitions carry per-teammate system prompts and the task the squad
  // was created for, all user-authored. `agentTeamRuns` alongside them is
  // metadata-only because it records execution, not instructions.
  "agentTeams",
  "agentTeammates",
  "agentTeamTasks",
  "sessions",
  "sessionState",
  "chatDrafts",
  "messages",
  "promptPresets",
  "artifacts",
  "artifactVersions",
  "canvasComments",
  "canvasDocuments",
  "canvasSessions",
  "canvasVersions",
  "contextComments",
  "twins",
  "twinSources",
  "twinChunks",
  "twinProfile",
  "twinDrafts",
  "memories",
  "memoryEvidence",
  "knowledgeBases",
  "knowledgeBaseSources",
  "knowledgeBaseChunks",
  "retrievalEncryptedContent",
  "retrievalTraces",
  "connectorAttachments",
  "connectorConversationStates",
  "connectorDrafts",
  "connectorInboundJobs",
  "inboundLedger",
  "outboundQueue",
  "ocrResults",
  "agentTraces",
  "wikiArticles",
  "wikiArticlesStaging",
  "wikiCorpora",
  "wikiSections",
  "wikiSectionsStaging",
  "workflows",
  "workflowVersions",
  "workflowRuns",
  "workflowRunEvents",
  "workflowInvocations",
  "workflowHumanInputFiles",
  "workflowHumanInputRequests",
  "workflowHumanInputSubmissions",
  "workflowKnowledgeArtifacts",
  "workflowConversations",
  "workflowConversationMessages",
  "workflowConversationSummaries",
])

/** Stores whose rows hold encrypted user content rather than ids and metadata. */
const CONFIDENTIAL_TABLES = new Set<CoreTableName>([
  "collabIssues",
  // Host-owned external-agent configurations. Not `secret` — the credential
  // VALUES live in the keyring and only opaque refs are stored here — but a
  // revision still carries the command line, argv, environment variable names
  // and endpoint URLs of a process this host will spawn.
  "externalAgentConfigHeads",
  "externalAgentConfigRevisions",
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
  // Complete build outputs as `Uint8Array` — the single largest row shape in
  // the app. Bounded by `lib/sites/artifact-gc.ts`, not by row count.
  "siteArtifacts",
  // Several rows per operation, several operations per build, kept for the
  // life of the Site.
  "siteOperationEvents",
  // Up to 512 KiB of captured build output per version.
  "siteBuildLogs",
  "agentTeamTrajectory",
  // One row per artifact revision, each holding a full copy of the content —
  // the reason artifacts could not stay in a 5 MB localStorage blob.
  "artifactVersions",
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
  artifacts: "artifact",
  artifactVersions: "artifact",
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
    /^(agentTeam|agent|artifact|workflow|provider|plugin|connector|integration|twin|wiki|eval|site|pet|browser|canvas|memory|retrieval|session|chat|template|knowledgeBase)/
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
  // ADR-0115 gives the memory and retrieval control planes differentiated
  // windows: 30 days for a job that succeeded or produced nothing, 90 for one
  // that failed or was quarantined, 180 for content-free audit. The catalog
  // records the OUTER bound of each table, because a policy that understates
  // what the code keeps is a policy that lies.
  memoryJobs: {
    mode: "ttl",
    days: 90,
    enforcement: "central",
    executorId: "memoryGovernance",
    reason:
      "ADR-0115 durable job retention. `pruneMemoryGovernanceData` keeps a succeeded or no-output job for 30 days and a failed, skipped or cancelled one for 90, and caps retained completed rows so a busy profile cannot grow without bound.",
  },
  memoryAuditEvents: {
    mode: "ttl",
    days: 180,
    enforcement: "central",
    executorId: "memoryGovernance",
    reason:
      "ADR-0115 content-free audit retention. The ledger carries only actions, reasons and counters, so 180 days is the window a user needs to answer why a memory exists. Also the only bound on a table registered as very-large.",
  },
  retrievalJobs: {
    mode: "ttl",
    days: 90,
    enforcement: "central",
    executorId: "retrievalControl",
    reason:
      "ADR-0115 shared job retention, matching `memoryJobs`. `pruneRetrievalControlData` applies the same 30/90 split and row cap.",
  },
  retrievalTraces: {
    mode: "ttl",
    days: 90,
    enforcement: "central",
    executorId: "retrievalControl",
    reason:
      "Content-free recall traces. Each row expires on its own `expiresAt`, which the memory domain sets to 14 days; 90 is the outer bound for domains that keep them longer, plus a row cap.",
  },
  siteArtifacts: {
    mode: "ttl",
    days: 30,
    enforcement: "central",
    executorId: "siteArtifacts",
    reason:
      "ADR-0084 requires artifact retention to preserve every version referenced by a deployment or an unfinished operation. The central sweeper prunes archives outside that set, outside the per-Site rollback window, and older than the window.",
  },
  siteBuildLogs: {
    mode: "ttl",
    days: 30,
    enforcement: "domain",
    reason:
      "Captured build stdout/stderr, trimmed to 256 KiB per stream. Deleted with the archive it explains by `lib/sites/artifact-gc.ts`, and with its Site by `deleteSiteProjectMetadata`.",
  },
  siteOperationEvents: {
    mode: "cap",
    maxRows: 20_000,
    enforcement: "domain",
    reason:
      "The durable operation journal. Trimmed with its owning Site by `deleteSiteProjectMetadata`; the cap bounds a profile that never deletes a Site.",
  },
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
  evalObservations: {
    mode: "ttl",
    days: 90,
    enforcement: "central",
    executorId: "evalOnline",
    reason:
      "Verdicts about production traces outlive the 30-day span window on purpose — a quality trend is the point — but not forever; the online sweep prunes them through createdAt.",
  },
  evalOnlineQueue: {
    mode: "ttl",
    days: 30,
    enforcement: "central",
    executorId: "evalOnline",
    reason:
      "Two windows, and the LONGER one is declared here because it is the table's real bound: settled work items are kept 7 days so a skipped-for-budget decision can still be explained, while work left unsettled by a session that never came back is reaped at 30. Declaring the 7 would understate the table by 4x.",
  },
  evalOnlineBudget: {
    mode: "ttl",
    days: 90,
    enforcement: "central",
    executorId: "evalOnline",
    reason:
      "Per-day spend rows are the audit trail for what a policy cost; kept a quarter, then swept.",
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
  // The expiry sweep (`sweepExpiredThreadHandoffTickets`) RETIRES a stranded
  // ticket — it rewrites `state` to `aborted` and appends to `history`. It
  // never deletes, and nothing else does either, so the journal is permanent
  // by construction. Declared explicitly because the inherited default says
  // "retained until an explicit domain delete" and this table has no such
  // delete to wait for.
  threadHandoffTickets: {
    mode: "permanent",
    enforcement: "explicit-delete",
    reason:
      "Two-role cross-host handoff journal (ADR-0103). Expired tickets are retired in place by the sweep, not removed; rows leave only with the owning account database.",
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

/**
 * Explicit content-protection decisions, checked BEFORE the derivation below.
 *
 * The derivation ends in a substring match over the table NAME, which is both
 * over- and under-inclusive: it is the home for tables the heuristic gets
 * wrong, and for any table whose classification deserves to be stated rather
 * than inferred.
 */
const CONTENT_PROTECTION_OVERRIDES: Partial<Record<CoreTableName, DataContentProtection>> = {
  // Bookkeeping for the encryption migration itself: an id, an account id, a
  // status, a table-name list and a timestamp. It matches `/Content/` purely by
  // spelling. Encrypting it would also mean the resume path could not read its
  // own journal without the cipher it is in the middle of installing.
  accountContentMigrations: "metadata-only",
  // An observation carries `Score.reasoning` — a judge's prose about what the
  // user asked and what the agent answered. The name matches none of the
  // content-ish spellings the heuristic looks for, so it would default to
  // `metadata-only` and store that rationale in the clear.
  evalObservations: "encrypted-content",
  // Ids, a state, a reservation and a skip reason. No content, and it is read
  // on the trace-completion path where a cipher round-trip would be a cost for
  // nothing.
  evalOnlineQueue: "metadata-only",
  // Selectors, sampling rates and a USD cap — configuration the operator wrote,
  // not conversation.
  evalOnlinePolicies: "metadata-only",
  // Three numbers and a day key.
  evalOnlineBudget: "metadata-only",
}

/**
 * Decide whether a table's rows are encrypted at rest.
 *
 * The tail of this is a heuristic — a substring match over the table name —
 * and a heuristic must not be the last word on whether user content is stored
 * in the clear. Two things keep it honest: {@link CONTENT_PROTECTION_OVERRIDES}
 * for stating a decision outright, and the baseline in
 * `content-protection-baseline.json`, which pins the answer for every existing
 * table so a NEW one cannot inherit `metadata-only` by accident — the gate in
 * `table-catalog.test.ts` fails until its classification is declared.
 */
function contentProtectionFor(
  name: CoreTableName,
  sensitivity: DataSensitivity,
  accountScope: DataAccountScope
): DataContentProtection {
  const override = CONTENT_PROTECTION_OVERRIDES[name]
  if (override) return override
  if (SECRET_EXTERNALIZED_TABLES.has(name)) return "secret-externalized"
  if (AUTO_INCREMENT_METADATA_TABLES.has(name) || accountScope === "global") {
    return "metadata-only"
  }
  if (
    USER_CONTENT_TABLES.has(name) ||
    sensitivity === "confidential" ||
    /Content|Artifact|Canvas|Wiki|Trace|Log/.test(name)
  ) {
    return "encrypted-content"
  }
  return "metadata-only"
}

function createEntry(name: CoreTableName): DataTableCatalogEntry {
  const role = roleFor(name)
  const sensitivity: DataSensitivity = SECRET_TABLES.has(name)
    ? "secret"
    : CONFIDENTIAL_TABLES.has(name) || USER_CONTENT_TABLES.has(name)
      ? "confidential"
      : /messages|Drafts|Sources|Evidence|ContentObjects/.test(name)
        ? "confidential"
        : "internal"
  const accountScope: DataAccountScope = GLOBAL_TABLES.has(name)
    ? "global"
    : RUNTIME_TARGET_TABLES.has(name)
      ? "runtime-target"
      : "account"
  return {
    name,
    owner: ownerFor(name),
    role,
    sensitivity,
    contentProtection: contentProtectionFor(name, sensitivity, accountScope),
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
    contentProtection: "encrypted-content",
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
