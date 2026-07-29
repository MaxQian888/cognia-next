import type { Table } from "dexie"

import { getDb } from "@/lib/db/schema"
import { listByStatus } from "@/lib/db/mobile-outbound-queue"
import type { Transport } from "@/lib/tauri/transport-types"
import type { AppSettings } from "@cognia/agent-config-types"
import { CROSS_PLATFORM_SETTING_KEYS } from "@cognia/agent-config-types/settings-sync"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Settings fields that are safe to mirror from the host onto a paired client.
 *
 * The singleton `AppSettings` row mixes portable preferences (theme, language,
 * model defaults) with desktop-only / device-local state (filesystem
 * `defaultWorkingDir`, `networkProxy`, `apiKey`, OCR provider config, …). A
 * blind whole-row `bulkPut` would clobber the client's own device-local fields
 * with the host's, so we merge only this subset.
 *
 * The list is no longer written here: it is derived from the one classification
 * table in `packages/agent-config-types/src/settings-sync.ts`, which also
 * generates the Rust write-allowlist. They used to be two hand-maintained lists
 * and had drifted badly — ~51 fields were writable up but never mirrored back
 * (so the phone's appearance, TTS, notification and search preferences silently
 * diverged from the desktop's forever), and the WebRTC/signaling fields were
 * classified in exactly the wrong direction.
 */
export { CROSS_PLATFORM_SETTING_KEYS }

/**
 * Statuses that mean "this client's edit has not reached the host yet".
 *
 * `sent` rows are excluded because the host already has the value — its next
 * delta is the newer truth. `deadlettered` is excluded on purpose too: those
 * writes will never be retried, so masking them would pin the client to a value
 * the host is never going to hold, and the two would stay out of step forever.
 * Letting the host's value land is the honest resolution, and the offline
 * banner is already telling the user that write failed permanently.
 */
const IN_FLIGHT_STATUSES = ["pending", "sending", "failed"] as const

/**
 * Keys this client has edited but not yet handed to the host.
 *
 * Fails open (empty set ⇒ nothing is masked): if the queue cannot be read we do
 * not know of any in-flight write, and blocking the whole settings mirror on a
 * transient Dexie error would be a worse failure than one flicker.
 */
async function inFlightSettingKeys(): Promise<Set<string>> {
  try {
    const batches = await Promise.all(IN_FLIGHT_STATUSES.map((status) => listByStatus(status)))
    const keys = new Set<string>()
    for (const job of batches.flat()) {
      if (job.command !== "app_settings_update") continue
      const patch = (job.payload as { patch?: Record<string, unknown> }).patch
      if (patch) for (const key of Object.keys(patch)) keys.add(key)
    }
    return keys
  } catch {
    return new Set<string>()
  }
}

/**
 * Merge the mirrored fields from the host's settings row onto this client's
 * singleton, preserving its own device-local fields. `rows` is the singleton
 * delta (0 or 1 row) from `sync_pull`.
 *
 * Fields with a write still sitting in the outbound queue are skipped. Without
 * that, editing settings offline looked broken: the phone wrote optimistically,
 * the edits queued, and the first pull after reconnecting overwrote them with
 * the host's older values — so the UI visibly snapped back to the old setting,
 * then changed again once the queue drained.
 */
async function applySettingsRows(rows: AppSettings[]): Promise<void> {
  const incoming = rows[0]
  if (!incoming) return
  const db = getDb()
  const [current, inFlight] = await Promise.all([
    db.settings.get("singleton"),
    inFlightSettingKeys(),
  ])
  const merged: Record<string, unknown> = {
    ...(current ?? { id: "singleton" as const }),
    id: "singleton",
  }
  for (const key of CROSS_PLATFORM_SETTING_KEYS) {
    if (inFlight.has(key)) continue
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
