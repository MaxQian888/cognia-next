/**
 * In-flight Bot installation mutations, so a mirror pull cannot undo one.
 *
 * A thin client flips a trigger OPTIMISTICALLY in its local mirror and ships
 * the authoritative write to the Host through the durable
 * `mobileOutboundQueue`. Until the Host has applied it, a `sync_pull` of
 * `botInstallations` hands back the PRE-mutation row: the switch flips, flips
 * back a moment later, then flips again when the Host catches up. The sync
 * handler skips installations with a pending mutation for exactly that window.
 *
 * Two sources, for the same reason `pending-overrides.ts` consults two:
 *
 *   - an in-memory refcount, held from "about to enqueue" through "optimistic
 *     write done", which covers the gap before the queue row is persisted, and
 *   - the durable queue itself, which is what survives a reload.
 *
 * ## Armed ahead of its producer, on purpose
 *
 * Nothing enqueues `bot_trigger_set_armed` yet: `lib/bot/control-writes/remote.ts`
 * is shaped and dormant until the relay lands, so this set is empty today. It
 * is here now because the ORDER matters. The mirror is what arrives first, and
 * a fence added after the data it fences has a window where the bug is real.
 * That is the same reason `syncedFromHost` shipped before anything wrote it.
 */

import { getDb } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"

import { BOT_WRITE_COMMANDS } from "./route"

const inMemory = new Map<string, number>()

/** Hold an in-flight marker for `installationId`. Returns the release. */
export function markPendingBotInstallationMutation(installationId: string): () => void {
  inMemory.set(installationId, (inMemory.get(installationId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (inMemory.get(installationId) ?? 1) - 1
    if (next <= 0) inMemory.delete(installationId)
    else inMemory.set(installationId, next)
  }
}

/** Synchronous check of the in-memory marker only. */
export function hasPendingBotInstallationMutation(installationId: string): boolean {
  return inMemory.has(installationId)
}

/** Test seam: drop every in-memory marker. */
export function __resetPendingBotInstallationsForTests(): void {
  inMemory.clear()
}

const IN_FLIGHT_STATUSES: ReadonlySet<MobileOutboundJobRow["status"]> = new Set([
  "pending",
  "sending",
  "failed",
])

/**
 * Commands whose payload names an installation the mirror must not overwrite.
 *
 * A set rather than a single name so a fourth relayed installation write has
 * to decide whether it belongs here, the same way `NEEDS_RUNNER` in `route.ts`
 * forces the other classification.
 */
const INSTALLATION_COMMANDS: ReadonlySet<string> = new Set([BOT_WRITE_COMMANDS.setTriggerArmed])

function installationIdOf(row: MobileOutboundJobRow): string | undefined {
  const payload = row.payload as { installationId?: unknown } | undefined
  return typeof payload?.installationId === "string" ? payload.installationId : undefined
}

/**
 * Every installation id with an in-flight relayed mutation.
 *
 * Never throws: a Dexie failure degrades to the memory markers so the sync
 * handler still runs. A pull that skipped nothing is a flicker, and a pull that
 * threw is a table that stops updating.
 */
export async function pendingBotInstallationIds(): Promise<Set<string>> {
  const ids = new Set(inMemory.keys())
  try {
    const rows = await getDb().mobileOutboundQueue.toArray()
    for (const row of rows) {
      if (!INSTALLATION_COMMANDS.has(row.command)) continue
      if (!IN_FLIGHT_STATUSES.has(row.status)) continue
      const id = installationIdOf(row)
      if (id) ids.add(id)
    }
  } catch {
    // See above.
  }
  return ids
}
