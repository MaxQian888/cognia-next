/**
 * Stage signal for the account unlock pipeline.
 *
 * Unlocking is not a toggle: it verifies a password (Argon2id on the desktop
 * host, PBKDF2 at 600k iterations on the main thread in a browser), prepares
 * the runtime target, then re-runs a FULL database boot — `lock()` closes the
 * cached Dexie connection, so the next unlock re-opens the schema, re-adopts
 * plugin tables and re-seeds. That is seconds of work, and two of those steps
 * can block indefinitely on another window holding the database.
 *
 * The lock screen used to render none of it: the button greyed out and nothing
 * else moved, so "still working", "wedged forever" and "the keystroke never
 * reached the form" all looked identical. This publishes where the pipeline
 * actually is so the screen can say so.
 *
 * A DOM CustomEvent rather than a store, for the same reason as
 * `lib/db/upgrade-blocked-signal.ts`: the publisher is store/lib code that must
 * not drag React into the node-env Jest project.
 */

export const ACCOUNT_UNLOCK_PROGRESS_EVENT = "cognia:account-unlock-progress" as const

export type AccountUnlockStage =
  /** Deriving the password hash and comparing it against the verifier. */
  | "verifying"
  /** Resolving / migrating the runtime target. Browser Vault runtimes only. */
  | "preparing-runtime"
  /** `ensureActiveDatabaseReady` — schema open, plugin tables, seed. */
  | "opening-database"
  /** Per-account local state activation and the store commit. */
  | "activating"
  /** Terminal: the gate is about to render the workspace. */
  | "ready"
  /** Terminal: the attempt failed and the screen is back to idle. */
  | "failed"

/** Working stages, in the order the pipeline runs them. `ready`/`failed` are terminal. */
const WORKING_STAGES = [
  "verifying",
  "preparing-runtime",
  "opening-database",
  "activating",
] as const satisfies readonly AccountUnlockStage[]

/**
 * The ladder for one runtime.
 *
 * `preparing-runtime` exists only where the Browser Vault is the credential
 * store — the desktop host resolves no runtime target during unlock, so
 * showing that row there would be a step the user waits on forever.
 */
export function unlockStagesFor(usesBrowserVault: boolean): AccountUnlockStage[] {
  return WORKING_STAGES.filter((stage) => usesBrowserVault || stage !== "preparing-runtime")
}

export interface AccountUnlockProgressDetail {
  stage: AccountUnlockStage
  accountId: string
}

export type AccountUnlockProgressHandler = (detail: AccountUnlockProgressDetail) => void

/** Announce the stage the unlock pipeline just entered. No-op outside a browser. */
export function publishUnlockStage(accountId: string, stage: AccountUnlockStage): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<AccountUnlockProgressDetail>(ACCOUNT_UNLOCK_PROGRESS_EVENT, {
      detail: { accountId, stage },
    })
  )
}

/** Subscribe to unlock stages. Returns an unsubscribe function. */
export function subscribeUnlockProgress(handler: AccountUnlockProgressHandler): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<AccountUnlockProgressDetail>).detail
    if (!detail) return
    handler(detail)
  }
  window.addEventListener(ACCOUNT_UNLOCK_PROGRESS_EVENT, listener)
  return () => window.removeEventListener(ACCOUNT_UNLOCK_PROGRESS_EVENT, listener)
}
