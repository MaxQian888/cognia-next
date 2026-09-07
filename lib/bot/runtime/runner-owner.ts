/**
 * The lease owner this shell's delivery runner claims with.
 *
 * Two runners must never share an owner string, or each would happily re-claim
 * the other's live lease and the same delivery would run twice. Two runners on
 * the same shell and account, on the other hand, MUST share one, so a
 * remounted initializer resumes its own work instead of waiting out a lease it
 * set itself.
 *
 * Host kind plus account satisfies both: distinct across shells and accounts,
 * stable within one.
 */

import { detectPlatform } from "@/lib/platform/detect"

/** The account this shell is serving, or a marker when there is none yet. */
async function currentAccountId(): Promise<string> {
  try {
    const { useAccountStore } = await import("@/stores/account/account-store")
    const id = useAccountStore.getState().activeAccountId
    return id ?? "unbound"
  } catch {
    return "unbound"
  }
}

export async function getLocalAccountId(): Promise<string> {
  return `${detectPlatform()}:${await currentAccountId()}`
}

/**
 * How many runners this JS context currently holds.
 *
 * A counter, not a boolean, because a StrictMode remount briefly overlaps two
 * installs and decrementing keeps the answer honest across that window. Same
 * shape and same reason as the connector runtime's ownership counter.
 *
 * Read by the host arms that execute a relayed Bot write: those enqueue onto
 * `botEventDeliveries`, which only a process running a runner will ever drain,
 * so a write landing anywhere else would sit there unexecuted.
 *
 * Honest about its strength: this is not "exactly one owner". Several hosts may
 * drain the queue, and the per-delivery lease is what keeps that safe. It
 * answers the narrower question that matters here, "is a runner running over
 * THIS database in THIS process".
 */
let runnerOwnerCount = 0

/** Does this context currently run a Bot delivery runner? */
export function isBotRunnerOwnedHere(): boolean {
  return runnerOwnerCount > 0
}

/** Mark a runner started. Returns the matching release, which is idempotent. */
export function markBotRunnerOwned(): () => void {
  runnerOwnerCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    runnerOwnerCount = Math.max(0, runnerOwnerCount - 1)
  }
}

/** Test-only reset of the ownership counter. */
export function __resetBotRunnerOwnershipForTests(): void {
  runnerOwnerCount = 0
}
