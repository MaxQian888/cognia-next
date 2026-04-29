// Envelope shape for the user-facing JSON export/import format. Versioned
// independently of the Dexie schema so the user can carry data between app
// versions without surprise migrations: the import code branches on
// schemaVersion and refuses anything it doesn't understand.

import type {
  AppSettings,
  Character,
  ChatSession,
  McpServer,
  Skill,
  StoredMessage,
  SystemPromptPreset,
  Team,
} from "@/lib/claude/types"

export const EXPORT_SCHEMA_VERSION = 1 as const

/**
 * Self-contained snapshot of the user's local data. Every field is optional so
 * partial exports (e.g., "settings only") and partial imports both work.
 *
 * `settings.apiKey` is optional and only included when the user explicitly
 * opts in at export time — secrets shouldn't ride along by default.
 */
export interface ExportEnvelope {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION
  exportedAt: number
  appVersion: string
  settings?: AppSettings
  /** Only user-created rows (built-ins are skipped). */
  characters?: Character[]
  skills?: Skill[]
  teams?: Team[]
  promptPresets?: SystemPromptPreset[]
  mcpServers?: McpServer[]
  sessions?: ChatSession[]
  messages?: StoredMessage[]
}

export interface ExportOptions {
  /** Include sessions + messages in the envelope. Off by default. */
  includeSessions: boolean
  /** Include the Anthropic API key inside settings. Off by default. */
  includeApiKey: boolean
}

export type ImportMergeStrategy = "skip" | "overwrite" | "duplicate"

export interface ImportOptions {
  mergeStrategy: ImportMergeStrategy
  includeSessions: boolean
  includeApiKey: boolean
}

/**
 * Per-table counters reported back to the UI after an import. The UI shows
 * this in the confirmation dialog so the user sees the blast radius before
 * committing.
 */
export interface ImportSummary {
  added: Record<string, number>
  overwritten: Record<string, number>
  skipped: Record<string, number>
  /** Imported rows whose id matched a local built-in row (always preserved). */
  builtInsSkipped: Record<string, number>
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(found: unknown) {
    super(
      `Unsupported export schemaVersion: ${String(found)}. This build accepts ${EXPORT_SCHEMA_VERSION}.`
    )
    this.name = "UnsupportedSchemaVersionError"
  }
}

export function emptySummary(): ImportSummary {
  return {
    added: {},
    overwritten: {},
    skipped: {},
    builtInsSkipped: {},
  }
}
