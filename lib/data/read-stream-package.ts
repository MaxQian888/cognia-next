/** Bridges authenticated v4 records into the existing atomic restore pipeline. */
import { readBackupStream } from "./stream-format"
import { BackupSourceCollector, type SessionAssetSourceChunk } from "./session-assets-backup"
import type { ApplyBackupExtras } from "./apply-package"
import type { BackupPackageV3, BackupPayloadV3 } from "./types"
import type { ProfilesExport } from "@cognia/provider-types/profile-migration"

const SHAPES: Record<
  keyof BackupPayloadV3,
  "rows" | "singleton" | "profiles" | "snapshots" | "binary"
> = {
  settings: "singleton",
  providerProfileStore: "profiles",
  ttsProviderKeys: "rows",
  trustedWorkspaces: "rows",
  localStorageSnapshots: "snapshots",
  sessions: "rows",
  messages: "rows",
  sessionAssets: "rows",
  sessionAssetSourceChunks: "binary",
  messageMedia: "rows",
  messageMediaChunks: "binary",
  retrievalTombstones: "rows",
  sessionState: "rows",
  scheduledTasks: "rows",
  petProfile: "singleton",
  petCharacterBindings: "rows",
  petAchievements: "rows",
  petInventory: "rows",
  petModels: "rows",
  characters: "rows",
  skills: "rows",
  skillResources: "rows",
  teams: "rows",
  promptPresets: "rows",
  chatTemplates: "rows",
  templateDefinitions: "rows",
  templatePackages: "rows",
  templateInstances: "rows",
  mcpServers: "rows",
  mcpCredentialManifest: "rows",
  artifacts: "rows",
  artifactVersions: "rows",
  canvasDocuments: "rows",
  canvasVersions: "rows",
  canvasComments: "rows",
  contextComments: "rows",
  canvasSessions: "rows",
  a2uiApps: "rows",
  a2uiTemplates: "rows",
  a2uiEventHistory: "rows",
  plugins: "rows",
  pluginPermissions: "rows",
  pluginReviews: "rows",
  pluginAnalytics: "rows",
  twinSources: "rows",
  twinChunks: "rows",
  twinProfile: "rows",
  twinDrafts: "rows",
  twinJobs: "rows",
  memories: "rows",
  memoryEvidence: "rows",
  memoryJobs: "rows",
  memoryAuditEvents: "rows",
  retrievalProfiles: "rows",
  retrievalEncryptedContent: "rows",
  retrievalProfileDeks: "rows",
}

export interface ReadStreamPackageResult {
  pkg: BackupPackageV3
  extras: Pick<ApplyBackupExtras, "attachmentSources" | "previewSources">
}

export async function readStreamPackage(
  source: AsyncIterable<Uint8Array>,
  passphrase?: string
): Promise<ReadStreamPackageResult> {
  const payload: Record<string, unknown> = Object.create(null)
  const attachmentSources = new BackupSourceCollector()
  const previewSources = new BackupSourceCollector()
  let pkg: BackupPackageV3 | undefined
  let profiles: ProfilesExport | undefined
  let profileManifestSeen = false
  for await (const event of readBackupStream(source, { passphrase })) {
    if (event.kind === "header") {
      pkg = {
        version: "3.0",
        manifest: {
          ...event.manifest,
          version: "3.0",
          schemaVersion: 3,
          // The v4 reader verifies the complete authenticated chain before returning this adapter.
          integrity: { algorithm: "SHA-256", checksum: "v4-authenticated-stream" },
        },
        payload,
      }
      continue
    }
    if (event.kind !== "chunk") continue
    const { section, rows } = event
    if (!Object.hasOwn(SHAPES, section))
      throw new TypeError(`Unsupported backup section: ${section}`)
    const shape = SHAPES[section as keyof BackupPayloadV3]
    if (shape === "binary") {
      const collector = section === "sessionAssetSourceChunks" ? attachmentSources : previewSources
      for (const row of rows) collector.append(row as SessionAssetSourceChunk)
    } else if (shape === "singleton") {
      if (rows.length > 1 || (rows.length && Object.hasOwn(payload, section)))
        throw new TypeError(`Duplicate singleton backup section: ${section}`)
      if (rows.length) payload[section] = rows[0]
    } else if (shape === "profiles") {
      profiles ??= {
        schemaVersion: 0,
        profileVersion: 0,
        providerProfiles: [],
        deploymentProfiles: [],
        transportProfiles: [],
        legacyAliases: {},
      }
      for (const row of rows) {
        const entry = row as { document: string; value: unknown }
        if (!entry || typeof entry !== "object")
          throw new TypeError("Invalid profile backup document")
        if (entry.document === "manifest") {
          if (profileManifestSeen || !entry.value || typeof entry.value !== "object")
            throw new TypeError("Invalid profile backup manifest")
          profileManifestSeen = true
          const value = entry.value as { schemaVersion: number; profileVersion: number }
          profiles.schemaVersion = value.schemaVersion
          profiles.profileVersion = value.profileVersion
        } else {
          const field = {
            providerProfile: "providerProfiles",
            deploymentProfile: "deploymentProfiles",
            transportProfile: "transportProfiles",
          }[entry.document]
          if (!field) throw new TypeError("Unsupported profile backup document")
          ;(profiles[field as "providerProfiles"] as unknown[]).push(entry.value)
        }
      }
      payload[section] = profiles
    } else if (shape === "snapshots") {
      const snapshots = (payload[section] ??= Object.create(null)) as Record<string, unknown>
      for (const row of rows) {
        const entry = row as { key: string; snapshot: unknown }
        if (!entry || typeof entry.key !== "string" || Object.hasOwn(snapshots, entry.key))
          throw new TypeError("Invalid or duplicate local storage snapshot")
        snapshots[entry.key] = entry.snapshot
      }
    } else {
      const target = (payload[section] ??= []) as unknown[]
      for (const row of rows) target.push(row)
    }
  }
  if (profiles) {
    for (const deployment of profiles.deploymentProfiles)
      if (deployment.legacyProviderId)
        profiles.legacyAliases[deployment.legacyProviderId] = deployment.id
  }
  if (!pkg || (profiles && !profileManifestSeen)) throw new TypeError("Backup stream is incomplete")
  return {
    pkg,
    extras: {
      attachmentSources: attachmentSources.finish(),
      previewSources: previewSources.finish(),
    },
  }
}
