// Reads the catalog-declared portable Dexie subset represented by the v3
// envelope and assembles a `BackupPackageV3`.
// Built-in rows (characters/skills/teams seeded by the app) are filtered by
// default — they'd just be re-seeded on import — but `includeBuiltIns: true`
// can override for "true full snapshot" use cases.

import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { getDeviceMetadata } from "@/lib/device/device-identity"
import { isTauri } from "@/lib/tauri"
import { canonicalStringify } from "./migrate"
import { sha256Hex } from "./crypto"
import {
  EXPORT_SCHEMA_VERSION,
  type BackupManifestV3,
  type BackupPackageV3,
  type BackupPayloadV3,
  type ExportOptions,
} from "./types"
import { browserSnapshotStorage, SNAPSHOT_MODULES } from "./snapshots/registry"
import { artifactsSnapshot } from "./snapshots/artifacts"
import { readAllSnapshots } from "./snapshots/helpers"
import type { SnapshotEnv, SnapshotStorage } from "./snapshots/types"
import { collectMessageMediaHashes } from "@/lib/db/message-media-refs"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { listAllCanvasCommentRows } from "@/lib/db/context-comments"
import { exportStoredProfilesRedacted } from "@/lib/db/provider-profiles"
import { deepStripSecrets } from "@/lib/settings/profile-transfer"
import { createPagedTableReader } from "./paged-table-reader"
import { redactMcpServerForExport } from "@/lib/mcp/credentials"

import { exportSessionAssetRecords, exportMessageMediaRecords } from "./session-assets-backup"

const APP_VERSION = "0.1.0"

function newTraceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  // Fallback: random hex chunk. Enough uniqueness for the user's own files.
  const rand = () => Math.random().toString(16).slice(2, 10)
  return `${rand()}-${rand().slice(0, 4)}-${rand().slice(0, 4)}-${rand().slice(0, 4)}-${rand()}${rand().slice(0, 4)}`
}

/** Optional knobs for tests / non-browser callers. */
export interface BuildBackupExtras {
  /** Override `localStorage` source. Defaults to `browserSnapshotStorage()`. */
  storage?: SnapshotStorage | null
  /** Forwarded to snapshot read warnings. */
  warn?: SnapshotEnv["warn"]
}

/**
 * Read every v3-portable table and assemble the payload. The payload is canonicalized
 * (keys sorted recursively) before its SHA-256 is computed so the manifest's
 * checksum field is stable across JS engines and table-iteration orders.
 */
export async function buildBackupPackage(
  opts: ExportOptions,
  extras: BuildBackupExtras = {}
): Promise<BackupPackageV3> {
  await assertLegacyBackupFits(opts)
  const db = getDb()
  const includeBuiltIns = opts.includeBuiltIns ?? false
  const includeSettings = opts.includeSettings ?? true
  const includeCoreData = opts.includeCoreData ?? true
  const includeMemories = includeCoreData && (opts.includeMemories ?? true)
  const includePlugins = opts.includePlugins ?? true
  const includeLocalStorage = opts.includeLocalStorage ?? true
  const readTable = createPagedTableReader({ pageSize: 500, concurrency: 4 })

  const [
    settingsRow,
    characters,
    skills,
    skillResources,
    teams,
    promptPresets,
    mcpServers,
    sessions,
    messages,
    sessionState,
    trustedWorkspaces,
    artifacts,
    artifactVersions,
    canvasDocuments,
    canvasVersions,
    canvasComments,
    contextComments,
    canvasSessions,
    a2uiApps,
    a2uiTemplates,
    a2uiEventHistory,
    twinSources,
    twinChunks,
    twinProfile,
    twinDrafts,
    twinJobs,
    memories,
    memoryEvidence,
    memoryJobs,
    memoryAuditEvents,
    retrievalProfiles,
    retrievalEncryptedContent,
    retrievalTombstones,
    plugins,
    pluginPermissions,
    pluginReviews,
    pluginAnalytics,
    chatTemplates,
    scheduledTasks,
    petProfile,
    petAchievements,
    petInventory,
    petCharacterBindings,
    petModels,
    templateDefinitions,
    templatePackages,
    templateInstances,
    providerProfileStore,
  ] = await Promise.all([
    getSettings(),
    readTable(db.characters),
    readTable(db.skills),
    readTable(db.skillResources),
    readTable(db.teams),
    readTable(db.promptPresets),
    readTable(db.mcpServers),
    opts.includeSessions ? readTable(db.sessions) : Promise.resolve([]),
    opts.includeSessions ? readTable(db.messages) : Promise.resolve([]),
    opts.includeSessions ? readTable(db.sessionState) : Promise.resolve([]),
    readTable(db.trustedWorkspaces),
    readTable(db.artifacts),
    readTable(db.artifactVersions),
    readTable(db.canvasDocuments),
    readTable(db.canvasVersions),
    listAllCanvasCommentRows(),
    readTable(db.contextComments),
    readTable(db.canvasSessions),
    readTable(db.a2uiApps),
    readTable(db.a2uiTemplates),
    readTable(db.a2uiEventHistory),
    readTable(db.twinSources),
    readTable(db.twinChunks),
    readTable(db.twinProfile),
    readTable(db.twinDrafts),
    readTable(db.twinJobs),
    includeMemories ? readTable(db.memories) : Promise.resolve([]),
    includeMemories ? readTable(db.memoryEvidence) : Promise.resolve([]),
    includeMemories ? readTable(db.memoryJobs) : Promise.resolve([]),
    includeMemories ? readTable(db.memoryAuditEvents) : Promise.resolve([]),
    includeCoreData || opts.includeSessions ? readTable(db.retrievalProfiles) : Promise.resolve([]),
    includeCoreData || opts.includeSessions
      ? readTable(db.retrievalEncryptedContent)
      : Promise.resolve([]),
    includeCoreData || opts.includeSessions
      ? readTable(db.retrievalTombstones)
      : Promise.resolve([]),
    readTable(db.plugins),
    readTable(db.pluginPermissions),
    readTable(db.pluginReviews),
    readTable(db.pluginAnalytics),
    readTable(db.chatTemplates),
    readTable(db.scheduledTasks),
    db.petProfile.get("global"),
    readTable(db.petAchievements),
    readTable(db.petInventory),
    readTable(db.petCharacterBindings),
    readTable(db.petModels),
    readTable(db.templateDefinitions),
    readTable(db.templatePackages),
    readTable(db.templateInstances),
    exportStoredProfilesRedacted(),
  ])

  // The setting face contains nested provider credentials. Reuse the settings
  // transfer scrubber so `includeApiKey: false` covers every nested key.
  const settings = (
    opts.includeApiKey ? { ...settingsRow } : deepStripSecrets(settingsRow)
  ) as typeof settingsRow

  const filteredCharacters = includeBuiltIns ? characters : characters.filter((c) => !c.isBuiltIn)
  const filteredSkills = includeBuiltIns ? skills : skills.filter((s) => !s.isBuiltIn)
  const filteredTeams = includeBuiltIns ? teams : teams.filter((t) => !t.isBuiltIn)
  // Resources of skipped built-in skills are also skipped, otherwise the
  // import would have orphan rows pointing at missing skills.
  const keptSkillIds = new Set(filteredSkills.map((s) => s.id))
  const filteredSkillResources = includeBuiltIns
    ? skillResources
    : skillResources.filter((r) => keptSkillIds.has(r.skillId))
  const filteredPlugins = includeBuiltIns
    ? plugins
    : plugins.filter((plugin) => plugin.source !== "builtin")
  const keptPluginIds = new Set(filteredPlugins.map((plugin) => plugin.id))
  const redactedMcp = mcpServers.map(redactMcpServerForExport)
  const portableRetrievalContent = retrievalEncryptedContent.filter(
    (row) =>
      row.kind !== "lexical_segment" &&
      (row.entityType === "memory"
        ? includeMemories
        : row.entityType === "compaction_checkpoint"
          ? opts.includeSessions
          : includeCoreData)
  )
  // Tombstones follow the same per-entity gating as the content they guard: a
  // memory tombstone belongs to the memory slice, a checkpoint tombstone to
  // the session slice. Dropping them here is what used to let a restore
  // resurrect hard-deleted rows.
  const portableRetrievalTombstones = retrievalTombstones.filter((row) =>
    row.entityType === "memory"
      ? includeMemories
      : row.entityType === "compaction_checkpoint"
        ? opts.includeSessions
        : includeCoreData
  )

  const payload: BackupPayloadV3 = {
    settings,
    characters: filteredCharacters,
    skills: filteredSkills,
    skillResources: filteredSkillResources,
    teams: filteredTeams,
    promptPresets,
    mcpServers: redactedMcp.map((entry) => entry.server),
    mcpCredentialManifest: redactedMcp
      .filter((entry) => entry.references.length > 0)
      .map((entry) => ({ serverId: entry.server.id, references: entry.references })),
    trustedWorkspaces,
    artifacts,
    artifactVersions,
    canvasDocuments,
    canvasVersions,
    canvasComments,
    contextComments,
    canvasSessions,
    // A2UI: built-in apps stay local; only user-created apps round-trip.
    a2uiApps: includeBuiltIns ? a2uiApps : a2uiApps.filter((a) => !a.isBuiltIn),
    a2uiTemplates,
    a2uiEventHistory,
    // Twin tables (schema v14): no built-in concept, so includeBuiltIns
    // is a no-op here. Profile is exported in full — the apply path will
    // overwrite by twinId so the import side never accumulates duplicates.
    twinSources,
    twinChunks,
    twinProfile,
    twinDrafts,
    twinJobs,
    ...(includeMemories ? { memories, memoryEvidence, memoryJobs, memoryAuditEvents } : {}),
    // The tombstone slice is gated on ITS OWN emptiness too: an export with
    // memories but no encrypted projections (retrieval sync never ran) must
    // still carry its tombstones, or the restore resurrects deleted rows —
    // the bug this field exists to prevent.
    ...(includeCoreData ||
    portableRetrievalContent.length > 0 ||
    portableRetrievalTombstones.length > 0
      ? {
          retrievalProfiles,
          retrievalEncryptedContent: portableRetrievalContent,
          retrievalTombstones: portableRetrievalTombstones,
        }
      : {}),
    plugins: filteredPlugins,
    pluginPermissions: pluginPermissions.filter((row) => keptPluginIds.has(row.pluginId)),
    pluginReviews: pluginReviews.filter((row) => keptPluginIds.has(row.pluginId)),
    pluginAnalytics: pluginAnalytics.filter((row) => keptPluginIds.has(row.pluginId)),
    // No built-in concept, so `includeBuiltIns` is a no-op here: every row is
    // something the user typed.
    chatTemplates,
    // Configuration only. Run history stays on the machine that ran it.
    scheduledTasks,
    // The desktop pet. The profile is the singleton nothing can rebuild; the
    // rest is what it has earned. Model FILES and sprite atlases stay behind
    // (Blobs do not survive JSON.stringify), so `petModels` travels as the
    // metadata around them, carrying the user's transform and motion tuning.
    // Always keyed, even with no pet on this machine. `JSON.stringify` drops
    // an undefined value, so an account that never hatched one ships nothing
    // extra, while the field stays part of the declared payload shape.
    petProfile,
    petAchievements,
    petInventory,
    petCharacterBindings,
    petModels,
    templateDefinitions,
    templatePackages,
    templateInstances,
    providerProfileStore,
  }
  if (opts.includeSessions) {
    const exportedSessions = filterExposedSessions(sessions, "standard-export")
    const exportedSessionIds = new Set(exportedSessions.map((session) => session.id))
    payload.sessions = exportedSessions
    payload.messages = messages.filter((message) => exportedSessionIds.has(message.sessionId))
    payload.sessionState = sessionState.filter((state) => exportedSessionIds.has(state.sessionId))
    for await (const record of exportSessionAssetRecords(exportedSessionIds)) {
      if (record.section === "sessionAssets") (payload.sessionAssets ??= []).push(...record.rows)
      else (payload.sessionAssetSourceChunks ??= []).push(...record.rows)
    }
    for await (const record of exportMessageMediaRecords(exportedSessionIds)) {
      if (record.section === "messageMedia") (payload.messageMedia ??= []).push(...record.rows)
      else (payload.messageMediaChunks ??= []).push(...record.rows)
    }
  }

  if (!includeSettings) delete payload.settings
  if (!includeSettings) delete payload.providerProfileStore
  if (!includeCoreData) {
    for (const key of [
      "characters",
      "skills",
      "skillResources",
      "teams",
      "promptPresets",
      "mcpServers",
      "mcpCredentialManifest",
      "trustedWorkspaces",
      "ttsProviderKeys",
      "artifacts",
      "artifactVersions",
      "canvasDocuments",
      "canvasVersions",
      "canvasComments",
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
      "retrievalProfileDeks",
      "chatTemplates",
      "scheduledTasks",
      "petProfile",
      "petAchievements",
      "petInventory",
      "petCharacterBindings",
      "petModels",
      "templateDefinitions",
      "templatePackages",
      "templateInstances",
    ] satisfies (keyof BackupPayloadV3)[]) {
      delete payload[key]
    }
  }
  if (!includePlugins) {
    delete payload.plugins
    delete payload.pluginPermissions
    delete payload.pluginReviews
    delete payload.pluginAnalytics
  }

  // localStorage-backed Zustand persist faces (external agents, custom
  // modes, agent teams, custom themes, artifacts, canvas prefs, …). Each
  // module's `read` is non-throwing — a single corrupt persist key cannot
  // brick the build.
  const storage =
    includeLocalStorage && extras.storage === undefined
      ? browserSnapshotStorage()
      : includeLocalStorage
        ? extras.storage
        : null
  if (storage) {
    const env: SnapshotEnv = { storage, warn: extras.warn }
    const snapshotModules =
      opts.includeArtifacts === false
        ? SNAPSHOT_MODULES.filter((module) => module.key !== artifactsSnapshot.key)
        : SNAPSHOT_MODULES
    const { snapshots } = readAllSnapshots(snapshotModules, env)
    if (Object.keys(snapshots).length > 0) {
      payload.localStorageSnapshots = snapshots
    }
  }

  assertLegacyPayloadFits(payload)
  const checksum = await sha256Hex(canonicalStringify(payload))
  // Optional provenance — restore + history surface "which device wrote this".
  const device = (await getDeviceMetadata()) ?? undefined
  const manifest: BackupManifestV3 = {
    version: "3.0",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    traceId: newTraceId(),
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    backend: isTauri() ? "tauri-dexie" : "web-dexie",
    integrity: { algorithm: "SHA-256", checksum },
    ...(device ? { device } : {}),
  }

  return { version: "3.0", manifest, payload }
}

/** Pretty-printed JSON serialization of a backup package. */
export function serializePackage(pkg: BackupPackageV3): string {
  return JSON.stringify(pkg, null, 2)
}

/**
 * Stable filename: `cognia-backup-YYYY-MM-DD.cbk` (`.cbk` = cognia backup).
 * Encrypted variants append `.enc.cbk`. Set `mode` to control which.
 */
export function defaultExportFileName(
  now: Date = new Date(),
  mode: "plain" | "encrypted" = "plain"
): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  const ext = mode === "encrypted" ? "enc.cbk" : "cbk"
  return `cognia-backup-${y}-${m}-${d}.${ext}`
}

export const __TESTING__ = { APP_VERSION }

/** Legacy share/remote envelopes require a contiguous JSON string and AES buffer. */
export class BackupRequiresStreamError extends Error {
  constructor() {
    super(
      "This backup is too large for a share link or this remote destination. Export a local streaming backup from Settings → Data to retain every attachment."
    )
    this.name = "BackupRequiresStreamError"
  }
}

async function assertLegacyBackupFits(options: ExportOptions): Promise<void> {
  if (!options.includeSessions) return
  const db = getDb()
  const sessionIds = new Set(
    filterExposedSessions(await db.sessions.toArray(), "standard-export").map((row) => row.id)
  )
  const sizes = new Map<string, number>()
  let total = 0
  const add = (key: string, size: number) => {
    if (sizes.has(key)) return
    sizes.set(key, size)
    total += size
    // Base64, canonical JSON, ciphertext and transport serialization coexist in legacy callers.
  }
  await db.messageMediaRefs.each((ref) => {
    const asset = ref.sessionAsset
    if (asset && sessionIds.has(ref.sessionId) && asset.sourceRetained !== false)
      add(`source:${asset.contentHash}`, asset.byteSize)
  })
  if (total > 32 * 1024 * 1024) throw new BackupRequiresStreamError()
  const hashes = new Set<string>()
  if (sessionIds.size)
    await db.messages
      .where("sessionId")
      .anyOf([...sessionIds])
      .each((message) => {
        for (const hash of collectMessageMediaHashes(message.parts)) hashes.add(hash)
      })
  for (const hash of hashes) {
    const media = await db.messageMedia.get(hash)
    if (!media) continue // The source exporter reports missing bytes as an error.
    add(`media:${hash}`, media.byteSize)
    if (media.thumbBlob) add(`thumb:${hash}`, media.thumbBlob.size)
    if (media.originalBlob) add(`original:${hash}`, media.originalBlob.size)
    if (total > 32 * 1024 * 1024) throw new BackupRequiresStreamError()
  }
}

function assertLegacyPayloadFits(payload: unknown): void {
  let characters = 0
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      characters += value.length + 2
      if (characters > 64 * 1024 * 1024) throw new BackupRequiresStreamError()
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code < 32) characters += 5
        else if (code === 34 || code === 92) characters += 1
      }
    } else if (value && typeof value === "object") {
      characters += 2
      if (Array.isArray(value)) {
        for (const row of value) {
          characters += 1
          visit(row)
        }
      } else {
        for (const [key, row] of Object.entries(value)) {
          characters += key.length + 4
          visit(row)
        }
      }
    } else characters += 24
    if (characters > 64 * 1024 * 1024) throw new BackupRequiresStreamError()
  }
  visit(payload)
}
