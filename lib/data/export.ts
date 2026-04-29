// Reads every table the user owns out of Dexie and assembles a portable
// JSON envelope. Built-in rows (characters/skills/teams seeded by the app)
// are filtered out — they'd just be re-seeded on import.

import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { EXPORT_SCHEMA_VERSION, type ExportEnvelope, type ExportOptions } from "./export-schema"

const APP_VERSION = "0.1.0"

export async function buildExportEnvelope(opts: ExportOptions): Promise<ExportEnvelope> {
  const db = getDb()

  const [settingsRow, characters, skills, teams, promptPresets, mcpServers, sessions, messages] =
    await Promise.all([
      getSettings(),
      db.characters.toArray(),
      db.skills.toArray(),
      db.teams.toArray(),
      db.promptPresets.toArray(),
      db.mcpServers.toArray(),
      opts.includeSessions ? db.sessions.toArray() : Promise.resolve([]),
      opts.includeSessions ? db.messages.toArray() : Promise.resolve([]),
    ])

  // Strip the API key unless the user opted in.
  const settings = { ...settingsRow }
  if (!opts.includeApiKey) {
    delete settings.apiKey
  }

  const env: ExportEnvelope = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    appVersion: APP_VERSION,
    settings,
    characters: characters.filter((c) => !c.isBuiltIn),
    skills: skills.filter((s) => !s.isBuiltIn),
    teams: teams.filter((t) => !t.isBuiltIn),
    promptPresets,
    mcpServers,
  }
  if (opts.includeSessions) {
    env.sessions = sessions
    env.messages = messages
  }
  return env
}

/** Stable filename suffix (`cognia-export-2026-04-28.json`). */
export function defaultExportFileName(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `cognia-export-${y}-${m}-${d}.json`
}
