// Codex usage probe — a thin wrapper over the unified limits runner that
// queries one Codex account's 5h/weekly windows and persists the snapshot.
//
// All real work (token + preset resolution, the `/wham/usage` fetch, mapping to
// meters) lives in the limits runner + `codexLimitsSource`; persistence lives
// in `recordLimitsSnapshot`. This module only wires those together and gates
// persistence on a non-empty snapshot, so the scheduler stays declarative and
// fully testable offline.
//
// The query goes through the shared coalescer rather than calling the runner
// directly. Reaching for the runner meant the background loop was the one
// caller that saw no throttle and no provider block: it re-hit `/wham/usage` on
// its own cadence no matter what the endpoint had just answered, and it
// duplicated whatever the quota panel had already fetched seconds earlier.

import { recordLimitsSnapshot } from "@/lib/subscription/limits/store"
import { queryAccountLimitsCoalesced } from "@/lib/subscription/limits/coalesce"

import type { ProviderLimits } from "@/types/subscription"

/**
 * Newest `fetchedAt` this module has already written, per account.
 *
 * The probe now shares the coalescer with the quota panels, which means a tick
 * landing inside the throttle window is handed the PREVIOUS reading back rather
 * than a new one. `recordLimitsSnapshot` appends, so persisting that replay
 * would add a duplicate row on every such tick and push real history out of the
 * capped table.
 */
const lastPersistedAt = new Map<string, number>()

export interface CodexProbeDeps {
  /** Resolve + fetch the account's limits. Defaults to the unified runner. */
  query?: (accountId: string) => Promise<ProviderLimits | null>
  /** Persist a non-empty snapshot. Defaults to the Dexie store. */
  persist?: (snapshot: ProviderLimits) => Promise<unknown>
}

/**
 * Probe the active Codex account's usage windows once. Returns the snapshot
 * (or `null` when nothing resolved).
 *
 * A snapshot is persisted when it carries at least one meter OR an `error`.
 * Errors are written because the panel reads Dexie, not this return value: an
 * unpersisted error rendered as a blank panel, which is exactly how a 401 from
 * a stale bearer stayed invisible. An empty, error-free snapshot is still
 * dropped so the table never fills with true blanks; `recordLimitsSnapshot`
 * caps the table, so a persistently failing endpoint can't grow it unbounded.
 */
export async function probeCodexUsage(
  accountId: string,
  deps: CodexProbeDeps = {}
): Promise<ProviderLimits | null> {
  const query = deps.query ?? ((id: string) => queryAccountLimitsCoalesced("codex", id))
  const persist = deps.persist ?? recordLimitsSnapshot

  const snapshot = await query(accountId)
  if (snapshot && (snapshot.meters.length > 0 || snapshot.error)) {
    if (lastPersistedAt.get(accountId) !== snapshot.fetchedAt) {
      lastPersistedAt.set(accountId, snapshot.fetchedAt)
      await persist(snapshot)
    }
  }
  return snapshot
}

/** Test-only: forget which snapshots have been written. */
export function __resetCodexProbeDedupeForTesting(): void {
  lastPersistedAt.clear()
}
