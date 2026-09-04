import { PROFILE_STORE_SCHEMA_VERSION } from "@cognia/provider-types"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { getDeviceMetadata } from "@/lib/device/device-identity"
import { redactMcpServerForExport } from "@/lib/mcp/credentials"
import { deepStripSecrets } from "@/lib/settings/profile-transfer"
import { isTauri } from "@/lib/tauri"
import { artifactsSnapshot } from "./snapshots/artifacts"
import { readAllSnapshots } from "./snapshots/helpers"
import { browserSnapshotStorage, SNAPSHOT_MODULES } from "./snapshots/registry"
import type { SnapshotEnv, SnapshotStorage } from "./snapshots/types"
import { createPagedTablePageIterator, type PagedReadable } from "./paged-table-reader"
import {
  createBackupStream,
  type BackupStreamSection,
  type BackupStreamManifestV4,
} from "./stream-format"
import type { ExportOptions } from "./types"
import { exportPortableRetrievalKeys, type PortableExportStore } from "./retrieval-key-backup"

type RowFilter<T> = (row: T) => boolean | Promise<boolean>
const APP_VERSION = "0.1.0"

function newTraceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  const rand = () => Math.random().toString(16).slice(2, 10)
  return `${rand()}-${rand().slice(0, 4)}-${rand().slice(0, 4)}-${rand().slice(0, 4)}-${rand()}${rand().slice(0, 4)}`
}

export interface BuildBackupStreamExtras {
  pageSize?: number
  maxChunkBytes?: number
  encryption?: { passphrase: string }
  storage?: SnapshotStorage | null
  warn?: SnapshotEnv["warn"]
  profileDekStore?: PortableExportStore
}

/**
 * Build an additive v4 byte stream. Unlike `buildBackupPackage`, this API does
 * not create a `BackupPayloadV3`; each IndexedDB page is released after the
 * consumer pulls the corresponding encoded record.
 */
export async function* buildBackupStream(
  options: ExportOptions,
  extras: BuildBackupStreamExtras = {}
): AsyncIterable<Uint8Array> {
  const db = getDb()
  const device = (await getDeviceMetadata()) ?? undefined
  const manifest: BackupStreamManifestV4 = {
    traceId: newTraceId(),
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    backend: isTauri() ? "tauri-dexie" : "web-dexie",
    sourceSchemaVersion: db.verno,
    ...(device ? { device } : {}),
  }
  yield* createBackupStream({
    manifest,
    sections: buildBackupSections(options, extras),
    encryption: extras.encryption,
    maxChunkBytes: extras.maxChunkBytes,
  })
}

/** Public page seam used by future file, WebDAV, and restore adapters. */
export async function* buildBackupSections(
  options: ExportOptions,
  extras: BuildBackupStreamExtras = {}
): AsyncIterable<BackupStreamSection> {
  const db = getDb()
  const iterate = createPagedTablePageIterator({ pageSize: extras.pageSize ?? 500, concurrency: 1 })
  const includeBuiltIns = options.includeBuiltIns ?? false
  const includeCoreData = options.includeCoreData ?? true
  const includeMemories = includeCoreData && (options.includeMemories ?? true)
  const includePlugins = options.includePlugins ?? true
  const includeSettings = options.includeSettings ?? true
  const includeLocalStorage = options.includeLocalStorage ?? true

  if (includeSettings) {
    const settingsRow = await getSettings()
    const settings = options.includeApiKey ? { ...settingsRow } : deepStripSecrets(settingsRow)
    yield { section: "settings", rows: [settings] }
  }

  if (includeCoreData) {
    yield* tableSections("characters", db.characters, iterate, (row) =>
      includeBuiltIns ? true : !row.isBuiltIn
    )
    yield* tableSections("skills", db.skills, iterate, (row) =>
      includeBuiltIns ? true : !row.isBuiltIn
    )
    const skillPortable = createBoundedLookup<string, boolean>(async (skillId) => {
      const skill = await db.skills.get(skillId)
      return !!skill && (includeBuiltIns || !skill.isBuiltIn)
    })
    yield* tableSections("skillResources", db.skillResources, iterate, (row) =>
      skillPortable(row.skillId)
    )
    yield* tableSections("teams", db.teams, iterate, (row) =>
      includeBuiltIns ? true : !row.isBuiltIn
    )
    yield* tableSections("promptPresets", db.promptPresets, iterate)
    let emittedMcp = false
    for await (const page of iterate(db.mcpServers)) {
      if (page.length === 0) continue
      emittedMcp = true
      const redacted = page.map(redactMcpServerForExport)
      yield { section: "mcpServers", rows: redacted.map((entry) => entry.server) }
      const manifests = redacted.flatMap((entry) =>
        entry.references.length > 0
          ? [{ serverId: entry.server.id, references: entry.references }]
          : []
      )
      if (manifests.length > 0) yield { section: "mcpCredentialManifest", rows: manifests }
    }
    if (!emittedMcp) yield { section: "mcpServers", rows: [] }
    yield* tableSections("trustedWorkspaces", db.trustedWorkspaces, iterate)
    yield* tableSections("artifacts", db.artifacts, iterate)
    yield* tableSections("artifactVersions", db.artifactVersions, iterate)
    yield* tableSections("canvasDocuments", db.canvasDocuments, iterate)
    yield* tableSections("canvasVersions", db.canvasVersions, iterate)
    yield* tableSections("contextComments", db.contextComments, iterate)
    yield* tableSections("canvasSessions", db.canvasSessions, iterate)
    yield* tableSections("a2uiApps", db.a2uiApps, iterate, (row) =>
      includeBuiltIns ? true : !row.isBuiltIn
    )
    yield* tableSections("a2uiTemplates", db.a2uiTemplates, iterate)
    yield* tableSections("a2uiEventHistory", db.a2uiEventHistory, iterate)
    yield* tableSections("twinSources", db.twinSources, iterate)
    yield* tableSections("twinChunks", db.twinChunks, iterate)
    yield* tableSections("twinProfile", db.twinProfile, iterate)
    yield* tableSections("twinDrafts", db.twinDrafts, iterate)
    yield* tableSections("twinJobs", db.twinJobs, iterate)
    yield* tableSections("chatTemplates", db.chatTemplates, iterate)
    yield* tableSections("petProfile", db.petProfile, iterate)
    yield* tableSections("petAchievements", db.petAchievements, iterate)
    yield* tableSections("petInventory", db.petInventory, iterate)
    yield* tableSections("petCharacterBindings", db.petCharacterBindings, iterate)
    yield* tableSections("petModels", db.petModels, iterate)
    yield* tableSections("scheduledTasks", db.scheduledTasks, iterate)
    yield* tableSections("templateDefinitions", db.templateDefinitions, iterate)
    yield* tableSections("templatePackages", db.templatePackages, iterate)
    yield* tableSections("templateInstances", db.templateInstances, iterate)
  }

  if (includeMemories) {
    yield* tableSections("memories", db.memories, iterate)
    yield* tableSections("memoryEvidence", db.memoryEvidence, iterate)
    yield* tableSections("memoryJobs", db.memoryJobs, iterate)
    yield* tableSections("memoryAuditEvents", db.memoryAuditEvents, iterate)
  }

  if (includeCoreData || options.includeSessions) {
    yield* tableSections("retrievalProfiles", db.retrievalProfiles, iterate)
    yield* tableSections(
      "retrievalEncryptedContent",
      db.retrievalEncryptedContent,
      iterate,
      (row) =>
        row.kind !== "lexical_segment" &&
        (row.entityType === "memory"
          ? includeMemories
          : row.entityType === "compaction_checkpoint"
            ? options.includeSessions
            : includeCoreData)
    )
    if (extras.encryption?.passphrase) {
      const envelopes = await exportPortableRetrievalKeys(
        extras.encryption.passphrase,
        extras.profileDekStore
      )
      yield { section: "retrievalProfileDeks", rows: envelopes }
    }
  }

  if (options.includeSessions) {
    const sessionPortable = createBoundedLookup<string, boolean>(async (sessionId) => {
      const session = await db.sessions.get(sessionId)
      return !!session && isSessionExposed(session, "standard-export")
    })
    yield* tableSections("sessions", db.sessions, iterate, (row) =>
      isSessionExposed(row, "standard-export")
    )
    yield* tableSections("messages", db.messages, iterate, (row) => sessionPortable(row.sessionId))
    yield* tableSections("sessionState", db.sessionState, iterate, (row) =>
      sessionPortable(row.sessionId)
    )
  }

  if (includePlugins) {
    const pluginPortable = createBoundedLookup<string, boolean>(async (pluginId) => {
      const plugin = await db.plugins.get(pluginId)
      return !!plugin && (includeBuiltIns || plugin.source !== "builtin")
    })
    yield* tableSections("plugins", db.plugins, iterate, (row) =>
      includeBuiltIns ? true : row.source !== "builtin"
    )
    yield* tableSections("pluginPermissions", db.pluginPermissions, iterate, (row) =>
      pluginPortable(row.pluginId)
    )
    yield* tableSections("pluginReviews", db.pluginReviews, iterate, (row) =>
      pluginPortable(row.pluginId)
    )
    yield* tableSections("pluginAnalytics", db.pluginAnalytics, iterate, (row) =>
      pluginPortable(row.pluginId)
    )
  }

  if (includeSettings) {
    const profileMeta = await db.profileStoreMeta.get("singleton")
    yield {
      section: "providerProfileStore",
      rows: [
        {
          document: "manifest",
          value: {
            schemaVersion: PROFILE_STORE_SCHEMA_VERSION,
            profileVersion: profileMeta?.profileVersion ?? 0,
          },
        },
      ],
    }
    yield* taggedTableSections("providerProfile", db.providerProfiles, iterate)
    yield* taggedTableSections("deploymentProfile", db.deploymentProfiles, iterate)
    yield* taggedTableSections("transportProfile", db.transportProfiles, iterate)
  }

  if (includeLocalStorage) {
    const storage = extras.storage === undefined ? browserSnapshotStorage() : extras.storage
    if (storage) {
      const modules =
        options.includeArtifacts === false
          ? SNAPSHOT_MODULES.filter((module) => module.key !== artifactsSnapshot.key)
          : SNAPSHOT_MODULES
      const { snapshots } = readAllSnapshots(modules, { storage, warn: extras.warn })
      for (const [key, snapshot] of Object.entries(snapshots)) {
        yield { section: "localStorageSnapshots", rows: [{ key, snapshot }] }
      }
    }
  }
}

async function* taggedTableSections<T, TKey>(
  document: string,
  table: PagedReadable<T, TKey>,
  iterate: <TRow, TPrimaryKey>(source: PagedReadable<TRow, TPrimaryKey>) => AsyncIterable<TRow[]>
): AsyncIterable<BackupStreamSection> {
  for await (const page of iterate(table)) {
    if (page.length > 0) {
      yield {
        section: "providerProfileStore",
        rows: page.map((value) => ({ document, value })),
      }
    }
  }
}

async function* tableSections<T, TKey>(
  section: string,
  table: PagedReadable<T, TKey>,
  iterate: <TRow, TPrimaryKey>(source: PagedReadable<TRow, TPrimaryKey>) => AsyncIterable<TRow[]>,
  filter?: RowFilter<T>
): AsyncIterable<BackupStreamSection> {
  let emitted = false
  for await (const page of iterate(table)) {
    const rows: T[] = []
    for (const row of page) {
      if (!filter || (await filter(row))) rows.push(row)
    }
    if (rows.length > 0) {
      emitted = true
      yield { section, rows }
    }
  }
  if (!emitted) yield { section, rows: [] }
}

function createBoundedLookup<TKey, TValue>(
  load: (key: TKey) => Promise<TValue>,
  maxEntries = 1_024
): (key: TKey) => Promise<TValue> {
  const cache = new Map<TKey, TValue>()
  return async (key) => {
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const value = await load(key)
    cache.set(key, value)
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value as TKey)
    return value
  }
}
