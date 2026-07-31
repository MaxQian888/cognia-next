// Helpers used by the Clear-data section of the settings dialog. Each helper
// is destructive — the UI requires the user to type "DELETE" to confirm.

import { getDb } from "@/lib/db/schema"

export type ClearableTable =
  "sessions" | "characters" | "skills" | "teams" | "promptPresets" | "mcpServers" | "settings"

/**
 * Clear the named tables. Sessions also clear their associated messages and
 * sessionState rows so the user doesn't end up with orphan history. Built-in
 * characters/skills/teams will be re-seeded automatically on next read.
 */
export async function clearTables(names: ClearableTable[]): Promise<void> {
  if (names.length === 0) return
  const db = getDb()
  const wantsSessions = names.includes("sessions")

  await db.transaction(
    "rw",
    [
      db.sessions,
      db.messages,
      db.sessionState,
      db.characters,
      db.skills,
      db.teams,
      db.promptPresets,
      db.mcpServers,
      db.settings,
    ],
    async () => {
      if (wantsSessions) {
        await db.messages.clear()
        await db.sessionState.clear()
        await db.sessions.clear()
      }
      if (names.includes("characters")) await db.characters.clear()
      if (names.includes("skills")) await db.skills.clear()
      if (names.includes("teams")) await db.teams.clear()
      if (names.includes("promptPresets")) await db.promptPresets.clear()
      if (names.includes("mcpServers")) await db.mcpServers.clear()
      if (names.includes("settings")) await db.settings.clear()
    }
  )
}

/**
 * Drop the entire database. The page must reload afterwards so Dexie can
 * re-open and re-run the seed step.
 */
export async function clearAll(): Promise<void> {
  const db = getDb()
  await db.delete()
}
