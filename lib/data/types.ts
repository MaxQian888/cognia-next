// Type contracts for the v3 backup-package format. Modeled on Cognia's
// `lib/storage/persistence/types.ts` but stripped to cognia-next's domain
// (no projects/knowledge/workflows/etc).
//
// Versioned independently of the Dexie schema so users can carry data between
// app versions without surprise migrations: the importer reads `manifest.version`
// and `manifest.schemaVersion` and refuses anything it doesn't understand.

import type {
  AppSettings,
  Character,
  ChatSession,
  McpServer,
  Skill,
  SkillResource,
  StoredMessage,
  SystemPromptPreset,
  Team,
} from "@/lib/claude/types"
import type { TrustedWorkspace } from "@/lib/db/trusted-workspaces"
import type { SessionStateRow, TtsProviderKeyRow } from "@/lib/db/schema"
import type {
  CanvasDocumentRow,
  CanvasVersionRow,
  CanvasCommentRow,
  CanvasSessionRow,
} from "@/lib/db/canvas-types"
import type { A2UIAppRow, A2UITemplateRow, A2UIEventHistoryRow } from "@/lib/db/a2ui-types"
import type { TwinChunk, TwinDraft, TwinJob, TwinProfile, TwinSource } from "@/types/twin"
import type { LocalStorageSnapshot } from "./snapshots/types"

/** Schema version currently emitted by `buildBackupPackage`. */
export const EXPORT_SCHEMA_VERSION = 3 as const

export type BackupPersistenceBackend = "web-dexie" | "tauri-dexie"

/**
 * The header attached to every plaintext or encrypted backup. Covers what,
 * when, and from where; the integrity block is a SHA-256 of the serialized
 * payload, recomputed on import to detect tampering or truncation.
 */
export interface BackupManifestV3 {
  version: "3.0"
  schemaVersion: 3
  /** Stable UUID per export — useful for cross-correlating logs. */
  traceId: string
  /** ISO 8601 timestamp at export time. */
  exportedAt: string
  /** App version that wrote the file, free-form. */
  appVersion: string
  backend: BackupPersistenceBackend
  integrity: { algorithm: "SHA-256"; checksum: string }
  /** Present only when the file is wrapped in `EncryptedEnvelopeV1`. */
  encryption?: { enabled: true; format: "encrypted-envelope-v1" }
}

/**
 * The actual payload — every Dexie-backed user-data table plus the singleton
 * settings row. Every field is optional so partial exports ("settings only")
 * and partial imports both work.
 *
 * Built-in rows (characters/skills/teams with `isBuiltIn === true`) are
 * intentionally NOT filtered out at this layer — the caller decides. The
 * importer skips writes against locally-built-in rows regardless.
 */
export interface BackupPayloadV3 {
  settings?: AppSettings
  characters?: Character[]
  skills?: Skill[]
  skillResources?: SkillResource[]
  teams?: Team[]
  promptPresets?: SystemPromptPreset[]
  mcpServers?: McpServer[]
  sessions?: ChatSession[]
  messages?: StoredMessage[]
  sessionState?: SessionStateRow[]
  trustedWorkspaces?: TrustedWorkspace[]
  ttsProviderKeys?: TtsProviderKeyRow[]
  /** Canvas tables — added in cognia-next when the Canvas guild lands. */
  canvasDocuments?: CanvasDocumentRow[]
  canvasVersions?: CanvasVersionRow[]
  canvasComments?: CanvasCommentRow[]
  canvasSessions?: CanvasSessionRow[]
  /** A2UI tables (schema v13). Surfaces are NOT exported — they're
   * runtime-derived; only saved apps + user templates + the debugger
   * event log round-trip through backups. */
  a2uiApps?: A2UIAppRow[]
  a2uiTemplates?: A2UITemplateRow[]
  a2uiEventHistory?: A2UIEventHistoryRow[]
  /**
   * Zustand-persist faces that live in `localStorage` (external agents,
   * custom modes, agent teams, custom themes, artifacts, canvas prefs, …).
   * Single field for forward-compatibility: adding a new persist store to
   * the backup never bumps `BackupPayloadV3` again — only the snapshot
   * registry changes. Keyed by Zustand persist `name`.
   */
  localStorageSnapshots?: Record<string, LocalStorageSnapshot>
  /**
   * Plugin tables (schema v15). Additive — old envelopes that omit these
   * fields parse identically to before. The row types are intentionally
   * loose (`unknown[]`) at this layer so adding/changing plugin fields
   * later doesn't ripple through the backup type. The plugin install state
   * round-trips through these arrays under the same `applyBackupPackage`
   * merge logic as every other domain table.
   */
  plugins?: unknown[]
  pluginPermissions?: unknown[]
  pluginReviews?: unknown[]
  pluginAnalytics?: unknown[]
  pluginScheduledJobs?: unknown[]
  /**
   * Digital-twin tables (schema v14). Always-additive: legacy v3 envelopes
   * that pre-date the twin subsystem omit these fields, and the importer
   * treats `undefined` as "no rows to apply".
   *
   * `twinSources.redactionMapEnc` is encrypted with the source device's
   * stronghold key — round-tripping into a fresh device that doesn't share
   * the key leaves the placeholders intact (the redacted form is what the
   * runtime uses anyway), but the redaction map can no longer be reversed.
   * `applyBackupPackage` surfaces this via the import summary.
   */
  twinSources?: TwinSource[]
  twinChunks?: TwinChunk[]
  /**
   * Single-row-per-twin; the importer overwrites by `id` (== twinId) so a
   * fresh device doesn't end up with two profile rows for the same twin.
   */
  twinProfile?: TwinProfile[]
  twinDrafts?: TwinDraft[]
  twinJobs?: TwinJob[]
}

/** The on-disk plaintext shape. JSON-serialized verbatim. */
export interface BackupPackageV3 {
  version: "3.0"
  manifest: BackupManifestV3
  payload: BackupPayloadV3
}

/**
 * On-disk shape when the user opts into encryption. The plaintext is a
 * serialized `BackupPackageV3`; `checksum` is the SHA-256 of that plaintext
 * (lets us verify integrity after decryption without re-deriving the key).
 */
export interface EncryptedEnvelopeV1 {
  version: "enc-v1"
  algorithm: "AES-GCM"
  kdf: {
    algorithm: "PBKDF2"
    hash: "SHA-256"
    iterations: number
    /** Base64 — 16 bytes. */
    salt: string
  }
  /** Base64 — 12 bytes. */
  iv: string
  /** Base64 — AES-GCM ciphertext including the auth tag. */
  ciphertext: string
  /** Manifest minus `integrity` (which only makes sense for plaintext). */
  manifest: Omit<BackupManifestV3, "integrity">
  /** SHA-256 of the plaintext payload JSON. */
  checksum: string
}

/** Strategy used by the importer when an incoming row's id collides locally. */
export type ImportMergeStrategy = "skip" | "overwrite" | "duplicate"

export interface ImportOptions {
  mergeStrategy: ImportMergeStrategy
  /** Apply the `sessions` + `messages` + `sessionState` slice. Off by default. */
  includeSessions: boolean
  /** Carry the API key field over too. Off by default. */
  includeApiKey: boolean
}

/**
 * Per-table counters reported back to the UI after an import. The UI shows
 * this in the confirmation dialog so the user sees the blast radius before
 * committing — and after, as a receipt.
 */
export interface ImportSummary {
  added: Record<string, number>
  overwritten: Record<string, number>
  skipped: Record<string, number>
  /** Imported rows whose id matched a local built-in row (always preserved). */
  builtInsSkipped: Record<string, number>
  /**
   * Per-snapshot outcome for the `localStorage` face (external agents,
   * custom modes, …). Absent when the package didn't carry any snapshots.
   */
  localStorage?: LocalStorageImportReport
  /**
   * Tauri-only: result of replaying `syncToAgent()` for each known external
   * agent after the Dexie + localStorage faces were applied. Lets the UI
   * tell the user which agents were re-projected to disk and which were
   * skipped (e.g. read-only adapter, agent not installed).
   */
  syncResults?: SyncProjectionReport[]
}

export interface LocalStorageImportReport {
  /** Persist keys that were applied. */
  written: string[]
  /** Persist keys present in the package that no module knows how to apply. */
  skipped: string[]
  /** Persist keys whose write threw — the rollback path will list them. */
  errors: { key: string; error: string }[]
  /** Persist keys that we restored from `preSnap` after a failure. */
  restoredFromPreSnap?: string[]
}

export interface SyncProjectionReport {
  agentId: string
  ok: boolean
  /** A short reason string when `ok=false`; `undefined` on success. */
  reason?: string
  /** When `ok=true`, the count of servers projected. */
  count?: number
}

export function emptySummary(): ImportSummary {
  return {
    added: {},
    overwritten: {},
    skipped: {},
    builtInsSkipped: {},
  }
}

/** Options consumed by `buildBackupPackage`. */
export interface ExportOptions {
  /** Include sessions + messages + sessionState in the payload. */
  includeSessions: boolean
  /** Include `settings.apiKey` in the payload. Off by default — secrets shouldn't ride along. */
  includeApiKey: boolean
  /** Include built-in characters/skills/teams. Off by default — they re-seed locally. */
  includeBuiltIns?: boolean
}

// ---- Errors ---------------------------------------------------------------

/**
 * Thrown by `migrateEnvelope` when the input is an `EncryptedEnvelopeV1`. The
 * caller is expected to prompt the user for a passphrase (or try the auto-key)
 * and call `decryptBackupPackage` before retrying.
 */
export class IsEncryptedError extends Error {
  readonly envelope: EncryptedEnvelopeV1
  constructor(envelope: EncryptedEnvelopeV1) {
    super("Backup is encrypted; decrypt before importing.")
    this.name = "IsEncryptedError"
    this.envelope = envelope
  }
}

/**
 * Thrown when the input doesn't look like any backup format we understand
 * (wrong shape, missing `version`/`schemaVersion`, or a future major).
 */
export class UnsupportedSchemaVersionError extends Error {
  readonly found: unknown
  constructor(found: unknown) {
    super(
      `Unsupported backup schema: ${describe(found)}. This build accepts schemaVersion=${EXPORT_SCHEMA_VERSION}.`
    )
    this.name = "UnsupportedSchemaVersionError"
    this.found = found
  }
}

/**
 * Thrown when the SHA-256 checksum stored in `manifest.integrity` (or in the
 * encrypted envelope) doesn't match the recomputed checksum of the payload.
 */
export class IntegrityCheckFailedError extends Error {
  readonly expected: string
  readonly actual: string
  constructor(expected: string, actual: string) {
    super("Backup integrity verification failed: checksum mismatch.")
    this.name = "IntegrityCheckFailedError"
    this.expected = expected
    this.actual = actual
  }
}

function describe(found: unknown): string {
  if (found === null) return "null"
  if (typeof found === "object") {
    const obj = found as { version?: unknown; schemaVersion?: unknown }
    return `version=${String(obj.version)}, schemaVersion=${String(obj.schemaVersion)}`
  }
  return typeof found
}
