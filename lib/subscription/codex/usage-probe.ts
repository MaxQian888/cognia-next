// Codex usage probe — a thin wrapper over the unified limits runner that
// queries one Codex account's 5h/weekly windows and persists the snapshot.
//
// All real work (token + preset resolution, the `/wham/usage` fetch, mapping to
// meters) lives in `queryAccountLimits` + `codexLimitsSource`; persistence lives
// in `recordLimitsSnapshot`. This module only wires those together and gates
// persistence on a non-empty snapshot, so the scheduler stays declarative and
// fully testable offline.

import { recordLimitsSnapshot } from "@/lib/subscription/limits/store"
import { queryAccountLimits } from "@/lib/subscription/limits/runner"

import type { ProviderLimits } from "@/types/subscription"

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
  const query = deps.query ?? ((id: string) => queryAccountLimits("codex", id))
  const persist = deps.persist ?? recordLimitsSnapshot

  const snapshot = await query(accountId)
  if (snapshot && (snapshot.meters.length > 0 || snapshot.error)) {
    await persist(snapshot)
  }
  return snapshot
}
