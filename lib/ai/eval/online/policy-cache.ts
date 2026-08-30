/**
 * A synchronous view of the enabled online-evaluation policies.
 *
 * The trace transport runs on the completion path and cannot await a Dexie
 * read there, so policies are held in memory and refreshed out of band. The
 * cache is deliberately not workspace-scoped: `matchesOnlineEvalPolicy` already
 * scopes by `selector.workspaceId` / `selector.projectId`, and a span carries a
 * projectId rather than a workspace, so filtering here would need a lookup the
 * hot path must not make.
 *
 * Empty is the default and the off switch. With the Eval Lab flag down, or with
 * no policy rows, the cache stays empty and the transport short-circuits.
 */

import type { OnlineEvalPolicyV1 } from "@cognia/eval-core"
import { listOnlinePolicies } from "@/lib/db/eval-online"
import { isEvalLabEnabled } from "@/lib/ai/eval/feature-flags"

export interface OnlineEvalPolicyCacheDependencies {
  listPolicies: typeof listOnlinePolicies
  isEnabled: () => boolean
}

const defaultDependencies: OnlineEvalPolicyCacheDependencies = {
  listPolicies: listOnlinePolicies,
  isEnabled: () => isEvalLabEnabled(),
}

let cached: readonly OnlineEvalPolicyV1[] = []

/** Synchronous, allocation-free read for the transport. */
export function getCachedOnlineEvalPolicies(): readonly OnlineEvalPolicyV1[] {
  return cached
}

/**
 * Reload from Dexie. Returns the number of enabled policies now cached.
 *
 * Failures leave the PREVIOUS cache in place rather than clearing it: a
 * transient read error should not silently switch evaluation off, and it
 * should not switch it on either.
 */
export async function refreshOnlineEvalPolicyCache(
  dependencies: OnlineEvalPolicyCacheDependencies = defaultDependencies
): Promise<number> {
  if (!dependencies.isEnabled()) {
    cached = []
    return 0
  }
  try {
    const rows = await dependencies.listPolicies()
    cached = rows.filter((row) => row.enabled)
  } catch {
    return cached.length
  }
  return cached.length
}

/** Test/reset seam — the module holds process-wide state. */
export function __setOnlineEvalPolicyCacheForTests(policies: readonly OnlineEvalPolicyV1[]): void {
  cached = policies
}
