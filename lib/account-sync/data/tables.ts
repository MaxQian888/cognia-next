/**
 * What account sync replicates, field by field (ADR-0215 §7, phase 3).
 *
 * Every field of every synced row type is classified here, and the maps are
 * typed against the row types: a field added to `ChatSession`, `StoredMessage`,
 * `Character`, `Skill` or `Memory` fails the typecheck until someone decides
 * whether it syncs. `local` fields stay on the device that wrote them:
 *
 * - device facts: paths, sandboxes, runtime and SDK session ids, connector
 *   bindings (connectors move with execution leases, phase 4), import mirrors
 *   of this machine's files, handoff locks, usage counters, the vector index;
 * - references to tables account sync does not carry yet (projects, folders,
 *   teams, squads, issues, knowledge bases, MCP servers, workflows, plugins,
 *   provider accounts), which would dangle on another device.
 *
 * Settings are the singleton split per key: a key syncs when
 * `SETTINGS_SYNC` classifies it `shared` (already cleared to cross devices and
 * free of credentials); `desktop-only` and `device-local` keys stay put until
 * they get an account-sync classification of their own.
 */

import type {
  AppSettings,
  Character,
  ChatSession,
  Skill,
  StoredMessage,
} from "@cognia/agent-config-types"
import { SETTINGS_SYNC } from "@cognia/agent-config-types/settings-sync"
import type { Memory } from "@/types/memory/memory"

import type { SyncedTableName } from "./types"

/** `key`: the row id, carried as the op's `id`, never as a field. */
export type FieldPolicy = "sync" | "local" | "key"

/**
 * The sync schema version (protocol §9): raise it when a synced field is
 * added or starts syncing. An op from a higher version is parked until this
 * build is updated, so an older build never drops what it cannot read.
 */
export const SYNC_SCHEMA_VERSION = 1

export interface TablePolicy {
  table: SyncedTableName
  cls: "content" | "settings"
  /** Field name → policy. */
  fields: Readonly<Record<string, FieldPolicy>>
  /** Rows that never leave the device, whatever their fields. */
  syncsRow: (row: Record<string, unknown>) => boolean
  /**
   * Whether a whole-row write is diffed against the previous row. Messages are
   * not: they are rewritten while streaming and written by one device, so every
   * synced field of a written message is sent, and the previous row (with its
   * whole transcript part list) is not decrypted on every write.
   */
  diff: boolean
}

const SESSION_FIELDS = {
  id: "key",
  title: "sync",
  titleAuto: "sync",
  kind: "sync",
  visibility: "sync",
  origin: "sync",
  characterId: "sync",
  disabledSkillIds: "sync",
  trialSkillId: "sync",
  memoryUse: "sync",
  memoryLearn: "sync",
  messageDisplayOverride: "sync",
  executionPolicy: "sync",
  // Reading provider ids and corpus bindings belong to this device's runtime.
  knowledgeReading: "local",
  permissionMode: "sync",
  pinned: "sync",
  manualOrder: "sync",
  manualOrderSection: "sync",
  lastMessagePreview: "sync",
  lastMessageAt: "sync",
  model: "sync",
  providerOverride: "sync",
  systemPrompt: "sync",
  scratchpad: "sync",
  roomSettings: "sync",
  activeBranchByGroup: "sync",
  parentSessionId: "sync",
  crossSessionInboundPolicy: "sync",
  branchedFromMessageId: "sync",
  branchKind: "sync",
  branchSeed: "sync",
  bareMode: "sync",
  debugMode: "sync",
  briefMode: "sync",
  outputStyle: "sync",
  customOutputStyle: "sync",
  compactionOverride: "sync",
  maxThinkingTokens: "sync",
  effort: "sync",
  thinkingLevel: "sync",
  toolFilter: "sync",
  archivedAt: "sync",
  createdAt: "sync",
  updatedAt: "sync",
  // References to tables account sync does not carry yet.
  projectId: "local",
  issueId: "local",
  teamId: "local",
  squadId: "local",
  folderId: "local",
  activePresetId: "local",
  accountId: "local",
  projectRole: "local",
  projectThread: "local",
  // This device's runtime and machine.
  transcriptRevision: "local",
  executionContext: "local",
  surfaceBinding: "local",
  surfaceBindingKey: "local",
  powerPolicy: "local",
  sandboxEnabled: "local",
  workspaceConfinementEnabled: "local",
  computerUseTarget: "local",
  sandboxTier: "local",
  sandboxTierFollowsDefault: "local",
  workingDir: "local",
  workingSet: "local",
  sdkSessionId: "local",
  runtimeTranscriptInvalidated: "local",
  runtimeTranscriptGeneration: "local",
  sdkSessionStorage: "local",
  externalAgentSession: "local",
  externalAgentModels: "local",
  externalAgentGatewaySessions: "local",
  forkedFromSdkSessionId: "local",
  attachedChild: "local",
  spawnedTask: "local",
  handoffSource: "local",
  cliHandoffReceipt: "local",
  handoffLock: "local",
  codexHandoff: "local",
  collaboration: "local",
  // Connector conversations run where their connector runs (phase 4).
  platformBinding: "local",
  platformConversationKey: "local",
  integrationBinding: "local",
  // A mirror of this machine's agent transcripts.
  importFrozen: "local",
  importSource: "local",
  importSourceLabel: "local",
  importSourceVersion: "local",
  importSourceRevision: "local",
  importGraphRootId: "local",
  importTombstonedAt: "local",
  importOwnership: "local",
  importRuntimeBinding: "local",
  importRelation: "local",
  importLifecycle: "local",
  importCanonicalState: "local",
  importLossReport: "local",
  importSourceDigest: "local",
  importDiverged: "local",
  importDivergedAt: "local",
} as const satisfies Record<keyof ChatSession, FieldPolicy>

const MESSAGE_FIELDS = {
  id: "key",
  sessionId: "sync",
  turnKey: "sync",
  role: "sync",
  parts: "sync",
  senderId: "sync",
  senderKind: "sync",
  metadata: "sync",
  createdAt: "sync",
  workingSetSnapshot: "local",
  projectId: "local",
  collaboration: "local",
  platformMessageId: "local",
} as const satisfies Record<keyof StoredMessage, FieldPolicy>

const CHARACTER_FIELDS = {
  id: "key",
  name: "sync",
  description: "sync",
  avatarColor: "sync",
  avatarEmoji: "sync",
  systemPrompt: "sync",
  modelRouting: "sync",
  executionPolicy: "sync",
  memoryPolicy: "sync",
  model: "sync",
  providerId: "sync",
  permissionMode: "sync",
  allowedTools: "sync",
  disallowedTools: "sync",
  skillIds: "sync",
  maxThinkingTokens: "sync",
  bareMode: "sync",
  debugMode: "sync",
  briefMode: "sync",
  outputStyle: "sync",
  customOutputStyle: "sync",
  compactionOverride: "sync",
  instructionsOverride: "sync",
  disablePluginTools: "sync",
  toolFilter: "sync",
  toolSearchRuntimeOverride: "sync",
  variant: "sync",
  a2uiEnabled: "sync",
  a2uiCatalogId: "sync",
  enableComputerUse: "sync",
  enableBrowserTools: "sync",
  enableOcr: "sync",
  enableBuiltInSkills: "sync",
  sourcePluginId: "sync",
  sourcePackId: "sync",
  clonedFromPackCharacterId: "sync",
  packVersionAtClone: "sync",
  pristineSnapshot: "sync",
  persona: "sync",
  voiceProfile: "sync",
  availableOnPlatforms: "sync",
  isBuiltIn: "sync",
  createdAt: "sync",
  updatedAt: "sync",
  // References to tables account sync does not carry yet.
  knowledgeBaseIds: "local",
  knowledgeReading: "local",
  mcpServerIds: "local",
  pluginSkillIds: "local",
  accountIdOverride: "local",
  embeddingProviderId: "local",
  twinId: "local",
  twinSettings: "local",
  platformDefaults: "local",
  // This device's machine.
  sandboxEnabled: "local",
  workspaceConfinementEnabled: "local",
  sandboxTier: "local",
  sandboxPolicy: "local",
  workingDir: "local",
  computerUseSettings: "local",
  computerUseTarget: "local",
  avatarImage: "local",
} as const satisfies Record<keyof Character, FieldPolicy>

const SKILL_FIELDS = {
  id: "key",
  slug: "sync",
  name: "sync",
  description: "sync",
  compatibility: "sync",
  metadata: "sync",
  invocationPolicy: "sync",
  frontmatterExtensions: "sync",
  codexOpenAiYaml: "sync",
  content: "sync",
  allowedTools: "sync",
  tags: "sync",
  isBuiltIn: "sync",
  source: "sync",
  status: "sync",
  category: "sync",
  version: "sync",
  author: "sync",
  license: "sync",
  canonicalId: "sync",
  marketplaceSkillId: "sync",
  marketplaceHash: "sync",
  kind: "sync",
  createdAt: "sync",
  updatedAt: "sync",
  workflowId: "local",
  usageCount: "local",
  lastUsedAt: "local",
  validationErrors: "local",
  // The skill as a folder on this machine, and its sync with that folder.
  nativeDirectory: "local",
  syncOrigin: "local",
  syncFingerprint: "local",
  lastSyncedAt: "local",
  lastSyncError: "local",
} as const satisfies Record<keyof Skill, FieldPolicy>

const MEMORY_FIELDS = {
  id: "key",
  scope: "sync",
  characterId: "sync",
  agentId: "sync",
  branch: "sync",
  pathPattern: "sync",
  type: "sync",
  text: "sync",
  key: "sync",
  tags: "sync",
  importance: "sync",
  createdAt: "sync",
  updatedAt: "sync",
  version: "sync",
  status: "sync",
  invalidatedAt: "sync",
  supersededById: "sync",
  pinned: "sync",
  provenance: "sync",
  sourceSessionId: "sync",
  sourceMessageId: "sync",
  sourceChannel: "sync",
  sourcePluginId: "sync",
  evidenceState: "sync",
  reviewStatus: "sync",
  conflictWithIds: "sync",
  contaminationState: "sync",
  sensitivity: "sync",
  confidence: "sync",
  expiresAt: "sync",
  staleness: "sync",
  trustState: "sync",
  sourceRevision: "sync",
  evidenceHash: "sync",
  extractor: "sync",
  retrievalFeedback: "sync",
  scopeRationale: "sync",
  projectMemoryKind: "sync",
  observedAt: "sync",
  validatedAt: "sync",
  revisionOf: "sync",
  revisionReason: "sync",
  revisedAt: "sync",
  compactedAt: "sync",
  beliefInputs: "sync",
  projectId: "local",
  // Each device keeps (and rebuilds) its own vector index and access stats.
  vectorDocId: "local",
  lastAccessedAt: "local",
  accessCount: "local",
} as const satisfies Record<keyof Memory, FieldPolicy>

/** The settings keys that sync: those `SETTINGS_SYNC` classifies `shared`. */
export const SYNCED_SETTINGS_KEYS: ReadonlySet<string> = new Set(
  Object.entries(SETTINGS_SYNC)
    .filter(([, entry]) => entry.category === "shared")
    .map(([key]) => key)
)

const SETTINGS_FIELDS: Readonly<Record<string, FieldPolicy>> = Object.fromEntries(
  Object.keys(SETTINGS_SYNC).map((key) => [key, SYNCED_SETTINGS_KEYS.has(key) ? "sync" : "local"])
) satisfies Partial<Record<keyof AppSettings, FieldPolicy>>

/** The row filter of tables whose every row syncs (callers may skip reading rows). */
export const syncsEveryRow = () => true
const always = syncsEveryRow

export const TABLE_POLICIES: Readonly<Record<SyncedTableName, TablePolicy>> = {
  sessions: {
    table: "sessions",
    cls: "content",
    fields: SESSION_FIELDS,
    syncsRow: always,
    diff: true,
  },
  messages: {
    table: "messages",
    cls: "content",
    fields: MESSAGE_FIELDS,
    syncsRow: always,
    diff: false,
  },
  characters: {
    table: "characters",
    cls: "content",
    fields: CHARACTER_FIELDS,
    // Every device seeds its own built-ins.
    syncsRow: (row) => row.isBuiltIn !== true,
    diff: true,
  },
  skills: {
    table: "skills",
    cls: "content",
    fields: SKILL_FIELDS,
    syncsRow: (row) => row.isBuiltIn !== true && row.source !== "builtin",
    diff: true,
  },
  memories: {
    table: "memories",
    cls: "content",
    fields: MEMORY_FIELDS,
    // A memory bound to a project stays with the project (projects do not sync yet).
    syncsRow: (row) => row.projectId === undefined || row.projectId === null,
    diff: true,
  },
  settings: {
    table: "settings",
    cls: "settings",
    fields: SETTINGS_FIELDS,
    syncsRow: always,
    diff: true,
  },
}

export const SYNCED_TABLES = Object.keys(TABLE_POLICIES) as SyncedTableName[]

export function isSyncedTable(name: string): name is SyncedTableName {
  return Object.hasOwn(TABLE_POLICIES, name)
}

/** The fields of `policy` that sync, in a stable order. */
export function syncedFields(policy: TablePolicy): string[] {
  return Object.keys(policy.fields)
    .filter((name) => policy.fields[name] === "sync")
    .sort()
}

/** The singleton row's primary key (`lib/db/settings.ts`). */
export const SETTINGS_ROW_ID = "singleton"
