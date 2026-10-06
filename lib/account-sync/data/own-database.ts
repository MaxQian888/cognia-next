/**
 * The database account sync may run against: the profile's own (ADR-0215
 * phase 3a, exclusive ownership of the synced tables).
 *
 * Where a profile keeps its own data depends on the shell. A native host
 * (desktop, the headless brain) has no client runtime target and uses
 * `cognia-account-<id>-encrypted-v1`. A browser or a phone running on its own
 * is a **standalone** target (`web-standalone`, `mobile-standalone`) with a
 * database of that target, `cognia-account-<id>-target-<target>-encrypted-v1`.
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
import type { RuntimeTarget } from "@/lib/runtime/runtime-target"
import { subscribeRuntimeSnapshot, getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { encryptedRuntimeTargetDatabaseName } from "@/lib/runtime/target-registry"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

export interface OwnDatabaseDeps {
  db?: () => CogniaDB
  target?: () => Pick<RuntimeTarget, "id" | "kind"> | null
  remoteHostActive?: () => boolean
}

/** The name of the profile's own database under `target`, or null when it holds another host's data. */
export function ownDatabaseName(
  localAccountId: string,
  target: Pick<RuntimeTarget, "id" | "kind"> | null
): string | null {
  if (!target) return encryptedAccountDatabaseName(localAccountId)
  // A companion mirrors another host; a legacy read-only target cannot be written.
  if (target.kind !== "standalone") return null
  try {
    return encryptedRuntimeTargetDatabaseName(localAccountId, target.id)
  } catch {
    // Not a valid target id: no database of this profile is named after it.
    return null
  }
}

/** The profile's own database when it is the active one, else null. */
export function ownAccountDatabase(
  localAccountId: string,
  deps: OwnDatabaseDeps = {}
): CogniaDB | null {
  const target = (deps.target ?? (() => getRuntimeSnapshot().target))()
  const remoteHostActive = deps.remoteHostActive ?? isRemoteHostActive
  if (remoteHostActive()) return null
  const name = ownDatabaseName(localAccountId, target)
  if (!name) return null
  const db = (deps.db ?? getDb)()
  return db.name === name ? db : null
}

/**
 * Calls `listener` whenever the answer of `ownAccountDatabase` may have changed.
 * Every switch of the active database (`activateAccountDatabase`,
 * `clearAccountDatabaseSelection`) is followed by a runtime snapshot naming the
 * new target, so the snapshot and the remote transport are the two signals.
 */
export function subscribeDatabaseAuthority(listener: () => void): () => void {
  const stops = [
    subscribeRuntimeSnapshot(listener),
    subscribeActiveRemoteTransport(() => listener()),
  ]
  return () => {
    for (const stop of stops) stop()
  }
}
