import type { Table } from "dexie"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { AppSettings } from "@/lib/claude/types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Settings fields that are safe to mirror from the desktop onto a phone.
 *
 * The singleton `AppSettings` row mixes portable preferences (theme,
 * language, model defaults) with desktop-only / device-local state
 * (filesystem `defaultWorkingDir`, `networkProxy`, `apiKey`, wallpapers,
 * imported VSCode themes, OCR provider config, …). A blind whole-row
 * `bulkPut` would clobber the phone's own device-local fields with the
 * desktop's. We instead merge only this allowlist over the phone's current
 * row, leaving everything else the phone set locally untouched.
 */
export const CROSS_PLATFORM_SETTING_KEYS = [
  "profile",
  "theme",
  "language",
  "fontScale",
  "density",
  "radius",
  "motion",
  "typographyExt",
  "a11y",
  "autoMode",
  "defaultModel",
  "defaultSystemPrompt",
  "defaultMaxThinkingTokens",
  "permissionMode",
  "bareMode",
  "debugMode",
  "briefMode",
  "conversationTitle",
  "conversationTimeline",
] as const satisfies readonly (keyof AppSettings)[]

/**
 * Merge the allowlisted cross-platform fields from the desktop's settings
 * row onto the phone's local singleton, preserving the phone's device-local
 * fields. `rows` is the singleton delta (0 or 1 row) from `sync_pull`.
 */
async function applySettingsRows(rows: AppSettings[]): Promise<void> {
  const incoming = rows[0]
  if (!incoming) return
  const db = getDb()
  const current = (await db.settings.get("singleton")) ?? { id: "singleton" as const }
  const merged: Record<string, unknown> = { ...current, id: "singleton" }
  for (const key of CROSS_PLATFORM_SETTING_KEYS) {
    if (incoming[key] !== undefined) merged[key] = incoming[key]
  }
  await db.settings.put(merged as unknown as AppSettings)
}

/**
 * Sync the singleton AppSettings row. The desktop emits the row whenever
 * the caller's cursor predates the row's `updatedAt` (or on the first pull
 * when `since === 0`). Only the cross-platform subset is applied — see
 * {@link CROSS_PLATFORM_SETTING_KEYS} — so the phone keeps its own
 * device-local preferences.
 */
export function syncAppSettings(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<AppSettings>(
    {
      table: "settings",
      // `settings` is typed `Table<AppSettings, "singleton">`; widen the key
      // type so it satisfies `runSyncHandler`'s `Table<TRow, string>`.
      getTable: () => getDb().settings as unknown as Table<AppSettings, string>,
      applyRows: applySettingsRows,
    },
    transport,
    cursor
  )
}
