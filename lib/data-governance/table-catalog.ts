import type { StorageCategory } from "@/lib/storage/types"

export type DataTableRole = "authoritative" | "projection" | "cache" | "audit" | "queue"
export type DataSensitivity = "public" | "internal" | "confidential" | "secret"
export type DataAccountScope = "global" | "account" | "runtime-target" | "plugin"
export type DataBackupMode = "portable" | "device-local" | "derived" | "ephemeral"
export type DataSyncMode = "none" | "companion-readonly"
export type DataCleanupPolicy = "protected" | "quick" | "deep"
export type DataExpectedScale = "small" | "medium" | "large" | "very-large"

export interface DataRetentionPolicy {
  mode: "permanent" | "ttl" | "cap"
  days?: number
  maxRows?: number
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

/** Static Dexie stores declared by CogniaDB v150. Kept explicit so review and
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
  "codeAdoptionTurns",
  "connectorAttachments",
  "connectorAudit",
  "connectorCallbackBindings",
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
  "executionRunBindings",
  "executionRunEvents",
  "executionRunInterrupts",
  "executionRuns",
  "feishuPrincipalBindRequests",
  "feishuPrincipals",
  "feishuTenants",
  "fleetSessions",
  "gatewayRequestLog",
  "goalTemplates",
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
  "knowledgeBaseChunks",
  "knowledgeBaseIngestJobs",
  "knowledgeBaseSources",
  "knowledgeBases",
  "knowledgeNotes",
  "larkChatSurfaces",
  "larkEntryContexts",
  "larkMessageImports",
  "larkWebSessions",
  "loopEvents",
  "loops",
  "mcpAuditLog",
  "mcpServers",
  "memories",
  "memoryAuditEvents",
  "memoryEvidence",
  "memoryJobs",
  "messageMedia",
  "messages",
  "mobileOutboundQueue",
  "modelsDevCatalog",
  "notifications",
  "ocrResults",
  "openVsxCache",
  "openrouterCatalog",
  "opticalArchives",
  "outboundQueue",
  "pairedDevices",
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
  "runRecords",
  "sandboxConnections",
  "sessionFolders",
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
  "workflowFanoutSubscriptions",
  "workflowFolders",
  "workflowInvocations",
  "workflowProposalHistory",
  "workflowRunEvents",
  "workflowRuns",
  "workflowTriggers",
  "workflowVersions",
  "workflowViewportBookmarks",
  "workflows",
] as const

export type CoreTableName = (typeof CORE_TABLE_NAMES)[number]

/** Tables represented by BackupPayloadV3. Secret-bearing tables are
 * deliberately absent; legacy packages remain importable. */
export const PORTABLE_BACKUP_TABLES = new Set<CoreTableName>([
  "settings",
  "characters",
  "skills",
  "skillResources",
  "teams",
  "promptPresets",
  "mcpServers",
  "sessions",
  "messages",
  "sessionState",
  "trustedWorkspaces",
  "canvasDocuments",
  "canvasVersions",
  "contextComments",
  "canvasSessions",
  "a2uiApps",
  "a2uiTemplates",
  "a2uiEventHistory",
  "twinSources",
  "twinChunks",
  "twinProfile",
  "twinDrafts",
  "twinJobs",
  "memories",
  "memoryEvidence",
  "memoryJobs",
  "memoryAuditEvents",
  "plugins",
  "pluginPermissions",
  "pluginReviews",
  "pluginAnalytics",
  "templateDefinitions",
  "templatePackages",
  "templateInstances",
  "providerProfiles",
  "deploymentProfiles",
  "transportProfiles",
  "profileStoreMeta",
])

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
  "memories",
  "workflowRuns",
  "mcpServers",
  "terminalHistory",
  "agentTeamBoard",
  "agentTasks",
  "agentTaskAttempts",
  "templateDefinitions",
  "templatePackages",
  "templateInstances",
])

/** Public protocol names. `goals` is the stable wire alias for `chatGoals`. */
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
  "memories",
  "workflowRuns",
  "mcpServers",
  "terminalHistory",
  "agentTeamBoard",
  "agentTasks",
  "agentTaskAttempts",
  "templateDefinitions",
  "templatePackages",
  "templateInstances",
] as const

export type CompanionSyncProtocolTableName = (typeof COMPANION_SYNC_PROTOCOL_TABLE_NAMES)[number]

const CACHE_TABLES = new Set<CoreTableName>([
  "a2uiSurfaces",
  "agentTeamBoard",
  "chatSearchState",
  "chatSearchText",
  "hostSyncCursors",
  "knowledgeBaseChunks",
  "modelsDevCatalog",
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
  "conversationOverrides",
  "profileStoreMeta",
  "providerCostDaily",
  "remoteControlRunStatus",
])

const AUDIT_TABLES = new Set<CoreTableName>(
  CORE_TABLE_NAMES.filter((name) =>
    /Audit|Events$|History$|Receipts$|Traces$|Trajectory$|Observations$|Recordings$|Usage$/.test(
      name
    )
  )
)

const QUEUE_TABLES = new Set<CoreTableName>(
  CORE_TABLE_NAMES.filter((name) =>
    /Jobs$|Queue$|Tasks$|Interrupts$|Materializations$|BindRequests$/.test(name)
  )
)

const SECRET_TABLES = new Set<CoreTableName>(["tts_provider_keys"])

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

const RUNTIME_TARGET_TABLES = new Set<CoreTableName>(["hostSyncCursors", "syncTombstones"])

const VERY_LARGE_TABLES = new Set<CoreTableName>([
  "agentTraces",
  "behaviorEvents",
  "connectorAudit",
  "executionRunEvents",
  "gatewayRequestLog",
  "inboxTelemetryEvents",
  "memoryAuditEvents",
  "messages",
  "projectChunks",
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
  sessionState: "chat",
  characters: "character",
  skills: "skill",
  skillResources: "skill",
  teams: "team",
  mcpServers: "mcp",
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
    /^(agentTeam|agent|workflow|provider|plugin|connector|integration|twin|wiki|eval|site|pet|browser|canvas|memory|session|chat|template|knowledgeBase)/
  )?.[1]
  return prefix ?? "core"
}

function roleFor(name: CoreTableName): DataTableRole {
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

function retentionFor(role: DataTableRole): DataRetentionPolicy {
  if (role === "audit")
    return {
      mode: "cap",
      maxRows: 5_000,
      reason: "Bound high-write evidence while retaining recent diagnostics.",
    }
  if (role === "queue")
    return {
      mode: "ttl",
      days: 30,
      reason: "Completed operational work must not grow without bound.",
    }
  if (role === "cache" || role === "projection")
    return { mode: "ttl", days: 30, reason: "Derived rows can be rebuilt after expiry." }
  return {
    mode: "permanent",
    reason: "Authoritative user data is retained until an explicit domain delete.",
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
      : /messages|Drafts|Sources|Evidence|ContentObjects/.test(name)
        ? "confidential"
        : "internal",
    accountScope,
    backupPolicy: backupFor(name, role),
    syncPolicy: COMPANION_SYNC_TABLES.has(name)
      ? { mode: "companion-readonly", reason: "Desktop-authoritative offline mirror." }
      : { mode: "none", reason: "Not exposed through the Companion data plane." },
    retentionPolicy: retentionFor(role),
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
    cleanupPolicy:
      role === "cache" || role === "projection"
        ? "quick"
        : role === "audit" || role === "queue"
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
