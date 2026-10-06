/**
 * "Another device changed these tables here" (ADR-0215 phase 3a).
 *
 * The applier writes pulled ops straight into Dexie. Views that read through
 * `liveQuery` (the session list, characters, skills, memories) follow on their
 * own; views that load once and then keep state in a store (the open chat's
 * transcript, the settings store) need to hear about it. The engine host
 * publishes each applied batch's tables here, and those views subscribe.
 */

import type { SyncedTableName } from "./types"

export type RemoteChangesListener = (tables: ReadonlySet<SyncedTableName>) => void

const listeners = new Set<RemoteChangesListener>()

/** Tells every subscriber which synced tables a remote apply just changed. */
export function publishRemoteChanges(tables: ReadonlySet<SyncedTableName>): void {
  if (tables.size === 0) return
  for (const listener of [...listeners]) {
    try {
      listener(tables)
    } catch (error) {
      // One view failing to refresh must not keep the others stale.
      console.warn("account sync: a remote-change listener failed", error)
    }
  }
}

export function subscribeRemoteChanges(listener: RemoteChangesListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
