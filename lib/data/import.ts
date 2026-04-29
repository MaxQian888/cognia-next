// Validates an ExportEnvelope and applies it to the local Dexie database
// under one of three merge strategies:
//   - skip:      keep the local row, drop the import row (default; safest)
//   - overwrite: replace the local row with the import row (id-keyed)
//   - duplicate: assign a fresh id to the import row and add alongside
//
// Built-in rows (characters/skills/teams with isBuiltIn === true) are NEVER
// overwritten regardless of strategy — they're managed by the app's own seed.

import { getDb } from "@/lib/db/schema"
import {
  EXPORT_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  emptySummary,
  type ExportEnvelope,
  type ImportOptions,
  type ImportSummary,
} from "./export-schema"
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

interface BuiltInRow {
  id: string
  isBuiltIn?: boolean
}

function newId(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export function validateEnvelope(input: unknown): asserts input is ExportEnvelope {
  if (!input || typeof input !== "object") {
    throw new Error("Import file is not a JSON object.")
  }
  const env = input as { schemaVersion?: unknown }
  if (env.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(env.schemaVersion)
  }
}

/**
 * Apply the envelope to local storage under the chosen merge strategy.
 * Wraps every write in one Dexie transaction so a partial failure rolls
 * back; returns a summary the UI can show.
 */
export async function importEnvelope(
  envelope: ExportEnvelope,
  opts: ImportOptions
): Promise<ImportSummary> {
  const summary = emptySummary()
  const db = getDb()

  await db.transaction(
    "rw",
    [
      db.settings,
      db.characters,
      db.skills,
      db.teams,
      db.promptPresets,
      db.mcpServers,
      db.sessions,
      db.messages,
    ],
    async () => {
      // --- settings (singleton) -------------------------------------------
      if (envelope.settings) {
        const existing = await db.settings.get("singleton")
        const incoming: AppSettings = { ...envelope.settings, id: "singleton" }
        if (!opts.includeApiKey) delete incoming.apiKey
        if (!existing) {
          await db.settings.put(incoming)
          incrementCounter(summary.added, "settings")
        } else if (opts.mergeStrategy === "skip") {
          incrementCounter(summary.skipped, "settings")
        } else {
          await db.settings.put({ ...existing, ...incoming })
          incrementCounter(summary.overwritten, "settings")
        }
      }

      // --- characters / skills / teams (skip built-ins) -------------------
      await applyCollection<Character>({
        rows: envelope.characters,
        table: db.characters,
        kind: "characters",
        opts,
        summary,
        idPrefix: "char",
      })
      await applyCollection<Skill>({
        rows: envelope.skills,
        table: db.skills,
        kind: "skills",
        opts,
        summary,
        idPrefix: "skill",
      })
      await applyCollection<Team>({
        rows: envelope.teams,
        table: db.teams,
        kind: "teams",
        opts,
        summary,
        idPrefix: "team",
      })

      // --- presets / MCP servers (no built-in flag) -----------------------
      await applyCollection<SystemPromptPreset>({
        rows: envelope.promptPresets,
        table: db.promptPresets,
        kind: "promptPresets",
        opts,
        summary,
        idPrefix: "preset",
        respectBuiltIn: false,
      })
      await applyCollection<McpServer>({
        rows: envelope.mcpServers,
        table: db.mcpServers,
        kind: "mcpServers",
        opts,
        summary,
        idPrefix: "mcp",
        respectBuiltIn: false,
      })

      // --- sessions + messages (off by default) ---------------------------
      if (opts.includeSessions) {
        await applyCollection<ChatSession>({
          rows: envelope.sessions,
          table: db.sessions,
          kind: "sessions",
          opts,
          summary,
          idPrefix: "s",
          respectBuiltIn: false,
        })
        // Messages are keyed by id, but the user really cares about whether
        // their conversation history is intact. We treat the strategy the
        // same way: skip / overwrite / duplicate, all keyed by id.
        await applyCollection<StoredMessage>({
          rows: envelope.messages,
          table: db.messages,
          kind: "messages",
          opts,
          summary,
          idPrefix: "m",
          respectBuiltIn: false,
        })
      }
    }
  )

  return summary
}

interface ApplyArgs<T extends { id: string }> {
  rows: T[] | undefined
  table: { get(id: string): Promise<T | undefined>; put(row: T): Promise<unknown> }
  kind: string
  opts: ImportOptions
  summary: ImportSummary
  idPrefix: string
  /** Default true. When true, local rows with isBuiltIn=true are never overwritten. */
  respectBuiltIn?: boolean
}

async function applyCollection<T extends { id: string }>(args: ApplyArgs<T>): Promise<void> {
  const { rows, table, kind, opts, summary, idPrefix } = args
  const respectBuiltIn = args.respectBuiltIn ?? true
  if (!rows || rows.length === 0) return

  for (const row of rows) {
    const existing = await table.get(row.id)
    if (existing && respectBuiltIn && (existing as BuiltInRow).isBuiltIn) {
      incrementCounter(summary.builtInsSkipped, kind)
      continue
    }
    if (!existing) {
      await table.put(row)
      incrementCounter(summary.added, kind)
      continue
    }
    switch (opts.mergeStrategy) {
      case "skip":
        incrementCounter(summary.skipped, kind)
        break
      case "overwrite":
        await table.put(row)
        incrementCounter(summary.overwritten, kind)
        break
      case "duplicate": {
        const copy = { ...row, id: newId(idPrefix) }
        // Drop the built-in flag on duplicates to avoid surprise read-only rows.
        if ("isBuiltIn" in copy) {
          ;(copy as Record<string, unknown>).isBuiltIn = false
        }
        await table.put(copy as T)
        incrementCounter(summary.added, kind)
        break
      }
    }
  }
}

function incrementCounter(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}
