// Reads every Dexie table the user owns and assembles a `BackupPackageV3`.
// Built-in rows (characters/skills/teams seeded by the app) are filtered by
// default — they'd just be re-seeded on import — but `includeBuiltIns: true`
// can override for "true full snapshot" use cases.

import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
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

const APP_VERSION = "0.1.0"

function newTraceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  // Fallback: random hex chunk. Enough uniqueness for the user's own files.
  const rand = () => Math.random().toString(16).slice(2, 10)
  return `${rand()}-${rand().slice(0, 4)}-${rand().slice(0, 4)}-${rand().slice(0, 4)}-${rand()}${rand().slice(0, 4)}`
}

/**
 * Read every table and assemble the v3 payload. The payload is canonicalized
 * (keys sorted recursively) before its SHA-256 is computed so the manifest's
 * checksum field is stable across JS engines and table-iteration orders.
 */
export async function buildBackupPackage(opts: ExportOptions): Promise<BackupPackageV3> {
  const db = getDb()
  const includeBuiltIns = opts.includeBuiltIns ?? false

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
    ttsProviderKeys,
    canvasDocuments,
    canvasVersions,
    canvasComments,
    canvasSessions,
  ] = await Promise.all([
    getSettings(),
    db.characters.toArray(),
    db.skills.toArray(),
    db.skillResources.toArray(),
    db.teams.toArray(),
    db.promptPresets.toArray(),
    db.mcpServers.toArray(),
    opts.includeSessions ? db.sessions.toArray() : Promise.resolve([]),
    opts.includeSessions ? db.messages.toArray() : Promise.resolve([]),
    opts.includeSessions ? db.sessionState.toArray() : Promise.resolve([]),
    db.trustedWorkspaces.toArray(),
    db.tts_provider_keys.toArray(),
    db.canvasDocuments.toArray(),
    db.canvasVersions.toArray(),
    db.canvasComments.toArray(),
    db.canvasSessions.toArray(),
  ])

  // Strip the API key unless the user opted in.
  const settings = { ...settingsRow }
  if (!opts.includeApiKey) {
    delete settings.apiKey
  }

  const filteredCharacters = includeBuiltIns ? characters : characters.filter((c) => !c.isBuiltIn)
  const filteredSkills = includeBuiltIns ? skills : skills.filter((s) => !s.isBuiltIn)
  const filteredTeams = includeBuiltIns ? teams : teams.filter((t) => !t.isBuiltIn)
  // Resources of skipped built-in skills are also skipped, otherwise the
  // import would have orphan rows pointing at missing skills.
  const keptSkillIds = new Set(filteredSkills.map((s) => s.id))
  const filteredSkillResources = includeBuiltIns
    ? skillResources
    : skillResources.filter((r) => keptSkillIds.has(r.skillId))

  const payload: BackupPayloadV3 = {
    settings,
    characters: filteredCharacters,
    skills: filteredSkills,
    skillResources: filteredSkillResources,
    teams: filteredTeams,
    promptPresets,
    mcpServers,
    trustedWorkspaces,
    ttsProviderKeys,
    canvasDocuments,
    canvasVersions,
    canvasComments,
    canvasSessions,
  }
  if (opts.includeSessions) {
    payload.sessions = sessions
    payload.messages = messages
    payload.sessionState = sessionState
  }

  const checksum = await sha256Hex(canonicalStringify(payload))
  const manifest: BackupManifestV3 = {
    version: "3.0",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    traceId: newTraceId(),
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    backend: isTauri() ? "tauri-dexie" : "web-dexie",
    integrity: { algorithm: "SHA-256", checksum },
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
