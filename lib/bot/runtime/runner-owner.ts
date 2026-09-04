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
