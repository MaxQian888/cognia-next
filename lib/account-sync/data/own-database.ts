/**
 * The database account sync may run against: the profile's own (ADR-0215
 * phase 3a, exclusive ownership of the synced tables).
 *
 * A companion mirror of another host lives in a database of its own
 * (`cognia-account-<id>-target-<target>`), filled by `lib/sync/companion-sync`
 * from that host, which syncs its own data itself. The engine never runs
 * there, nor while this window drives a remote host, so the mirror's writes
 * are never captured as this device's changes and the two never write the
 * same tables of one database.
 */

import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import { getDb, type CogniaDB } from "@/lib/db/schema"
import { subscribeRuntimeSnapshot, getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { subscribeRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

export interface OwnDatabaseDeps {
  db?: () => CogniaDB
  targetKind?: () => string | null | undefined
  remoteHostActive?: () => boolean
}

/** The profile's own database when it is the active one, else null. */
export function ownAccountDatabase(
  localAccountId: string,
  deps: OwnDatabaseDeps = {}
): CogniaDB | null {
  const targetKind = deps.targetKind ?? (() => getRuntimeSnapshot().target?.kind)
  const remoteHostActive = deps.remoteHostActive ?? isRemoteHostActive
  if (targetKind() === "companion" || remoteHostActive()) return null
  const db = (deps.db ?? getDb)()
  return db.name === encryptedAccountDatabaseName(localAccountId) ? db : null
}

/** Calls `listener` whenever the answer of `ownAccountDatabase` may have changed. */
export function subscribeDatabaseAuthority(listener: () => void): () => void {
  const stops = [
    subscribeRuntimeSnapshot(listener),
    subscribeRuntimeTargetContext(listener),
    subscribeActiveRemoteTransport(() => listener()),
  ]
  return () => {
    for (const stop of stops) stop()
  }
}
