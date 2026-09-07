/**
 * `botInstallations` companion sync handler.
 *
 * Mirrors the Host's PROJECTION (`projectBotInstallationRow`): identity,
 * scope, status, trigger overrides and timestamps, with `config` and
 * `credentialBindings` emptied and `triggerState` dropped entirely.
 *
 * Two rails on apply, and neither trusts the Host to have applied its own:
 *
 *   - every incoming row is FORCED to the projection shape, so the "a mirror
 *     never drives a local scheduler" invariant holds even against a Host that
 *     sent more than it should. `syncBotTriggerSchedules` reads
 *     `syncedFromHost` and refuses, which is what stops a device that mirrored
 *     another machine's installations from firing that machine's crons.
 *   - an installation with an in-flight relayed mutation is SKIPPED. The
 *     client flipped its trigger optimistically and shipped the authoritative
 *     write through the durable queue, and a delta that predates the Host
 *     applying it would flip the switch back under the user's finger.
 */

import { pendingBotInstallationIds } from "@/lib/bot/control-writes/pending-installations"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function normalizeMirroredInstallation(row: BotInstallationRow): BotInstallationRow {
  const next: BotInstallationRow = {
    ...row,
    config: {},
    credentialBindings: {},
    syncedFromHost: true,
  }
  // Deleted rather than emptied. `{}` under `triggerState` reads as "this
  // installation has a runner state and it is blank", and the poll cursor a
  // reader would take from it is the one that rewinds the Host.
  delete next.triggerState
  return next
}

export async function applyBotInstallationRows(rows: BotInstallationRow[]): Promise<void> {
  if (rows.length === 0) return
  const pending = await pendingBotInstallationIds()
  const writable = pending.size === 0 ? rows : rows.filter((row) => !pending.has(row.id))
  if (writable.length > 0) {
    await getDb().botInstallations.bulkPut(writable.map(normalizeMirroredInstallation))
  }
}

export function syncBotInstallations(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<BotInstallationRow>(
    {
      table: "botInstallations",
      getTable: () => getDb().botInstallations,
      applyRows: applyBotInstallationRows,
    },
    transport,
    cursor
  )
}
