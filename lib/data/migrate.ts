// Schema-version boundary for backup imports. Accepts:
//   • EncryptedEnvelopeV1   → throws IsEncryptedError so the caller can prompt
//   • v1 ExportEnvelope     → wraps in synthetic v3 manifest (lossless)
//   • v3 BackupPackage      → recomputes & validates the integrity checksum
//   • anything else         → throws UnsupportedSchemaVersionError
//
// The function intentionally accepts `unknown` so it can be called on raw
// `JSON.parse` output without first trusting the file.

import { sha256Hex } from "./crypto"
import {
  EXPORT_SCHEMA_VERSION,
  IntegrityCheckFailedError,
  IsEncryptedError,
  UnsupportedSchemaVersionError,
  type BackupManifestV3,
  type BackupPackageV3,
  type BackupPayloadV3,
  type EncryptedEnvelopeV1,
} from "./types"

/** Cheap structural sniff for a `BackupPackageV3`. */
function isBackupPackageV3(input: unknown): input is BackupPackageV3 {
  if (!input || typeof input !== "object") return false
  const obj = input as { version?: unknown; manifest?: unknown; payload?: unknown }
  if (obj.version !== "3.0") return false
  if (!obj.manifest || typeof obj.manifest !== "object") return false
  if (!obj.payload || typeof obj.payload !== "object") return false
  const manifest = obj.manifest as { schemaVersion?: unknown; version?: unknown }
  return manifest.version === "3.0" && manifest.schemaVersion === EXPORT_SCHEMA_VERSION
}

/** Cheap structural sniff for an `EncryptedEnvelopeV1`. */
export function isEncryptedEnvelope(input: unknown): input is EncryptedEnvelopeV1 {
  if (!input || typeof input !== "object") return false
  const obj = input as { version?: unknown; ciphertext?: unknown; kdf?: unknown }
  return (
    obj.version === "enc-v1" &&
    typeof obj.ciphertext === "string" &&
    !!obj.kdf &&
    typeof obj.kdf === "object"
  )
}

/** Sniff for the legacy v1 ExportEnvelope (`schemaVersion: 1` flat object). */
function isExportEnvelopeV1(input: unknown): input is V1Shape {
  if (!input || typeof input !== "object") return false
  const obj = input as { schemaVersion?: unknown }
  return obj.schemaVersion === 1
}

/** Loose mirror of the old v1 type for migration purposes only. */
interface V1Shape {
  schemaVersion: 1
  exportedAt: number
  appVersion?: string
  settings?: BackupPayloadV3["settings"]
  characters?: BackupPayloadV3["characters"]
  skills?: BackupPayloadV3["skills"]
  teams?: BackupPayloadV3["teams"]
  promptPresets?: BackupPayloadV3["promptPresets"]
  mcpServers?: BackupPayloadV3["mcpServers"]
  sessions?: BackupPayloadV3["sessions"]
  messages?: BackupPayloadV3["messages"]
}

/**
 * Stable JSON serialization for checksum computation. Keys are sorted
 * recursively so two payloads with the same content but different key
 * insertion order produce the same hash. The serialized form is what we
 * hash and what we sign on disk; the on-the-wire JSON file uses the same
 * canonical form so importers don't need to reorder keys before verifying.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(obj[key])
        return acc
      }, {})
  }
  return value
}

/**
 * Convert the raw `JSON.parse` of an import file to a current-shape
 * `BackupPackageV3`, validating the integrity checksum if present.
 */
export async function migrateEnvelope(input: unknown): Promise<BackupPackageV3> {
  if (isEncryptedEnvelope(input)) {
    throw new IsEncryptedError(input)
  }

  if (isBackupPackageV3(input)) {
    const pkg = input
    const expected = pkg.manifest.integrity.checksum
    const actual = await sha256Hex(canonicalStringify(pkg.payload))
    if (expected && actual !== expected) {
      throw new IntegrityCheckFailedError(expected, actual)
    }
    return pkg
  }

  if (isExportEnvelopeV1(input)) {
    return wrapV1AsV3(input)
  }

  throw new UnsupportedSchemaVersionError(input)
}

/**
 * Wrap a legacy v1 envelope as a v3 package by lifting the flat fields into
 * a `payload` block and synthesizing a manifest. The integrity checksum is
 * computed over the freshly-canonicalized payload.
 */
async function wrapV1AsV3(env: V1Shape): Promise<BackupPackageV3> {
  const payload: BackupPayloadV3 = {
    settings: env.settings,
    characters: env.characters,
    skills: env.skills,
    teams: env.teams,
    promptPresets: env.promptPresets,
    mcpServers: env.mcpServers,
    sessions: env.sessions,
    messages: env.messages,
  }

  const manifest: BackupManifestV3 = {
    version: "3.0",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    traceId: synthTraceId(env.exportedAt),
    exportedAt: new Date(env.exportedAt).toISOString(),
    appVersion: env.appVersion ?? "0.0.0",
    backend: "web-dexie",
    integrity: {
      algorithm: "SHA-256",
      checksum: await sha256Hex(canonicalStringify(payload)),
    },
  }

  return { version: "3.0", manifest, payload }
}

/** Stable but recognizable trace id for migrated v1 files. */
function synthTraceId(exportedAt: number): string {
  // Random UUID-shaped string keeps tooling happy. We don't need cryptographic
  // uniqueness here — just something the user can paste into a bug report.
  const seed = Number.isFinite(exportedAt) ? exportedAt : Date.now()
  const hex = (seed >>> 0).toString(16).padStart(8, "0")
  return `${hex}-v1xx-migrated-from-v1xxxxxx`.slice(0, 36)
}

export const __TESTING__ = { wrapV1AsV3, sortKeys, isExportEnvelopeV1, isBackupPackageV3 }
