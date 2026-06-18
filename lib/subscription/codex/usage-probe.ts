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
 * (or `null` when nothing resolved). A snapshot is persisted only when it
 * carries at least one meter — an `error`-only or empty snapshot is returned to
 * the caller but not written, so the history table never fills with blanks.
 */
export async function probeCodexUsage(
  accountId: string,
  deps: CodexProbeDeps = {}
): Promise<ProviderLimits | null> {
  const query = deps.query ?? ((id: string) => queryAccountLimits("codex", id))
  const persist = deps.persist ?? recordLimitsSnapshot

  const snapshot = await query(accountId)
  if (snapshot && snapshot.meters.length > 0) {
    await persist(snapshot)
  }
  return snapshot
}
