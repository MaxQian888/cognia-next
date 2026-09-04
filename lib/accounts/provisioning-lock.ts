/**
 * Serialize "stand up the account with THIS id" across every context that
 * shares the origin: a second browser tab, a second Tauri webview, the E2E
 * runner's extra page.
 *
 * Account creation is two writes that must not interleave. `provisionBrowserVault`
 * REPLACES the vault record (a fresh DEK, wrapped under a fresh recovery key)
 * and the registry row is added afterwards. With a generated account id the two
 * writers never meet, but the disposable development account and the E2E
 * account both use a FIXED id, and first-run in two tabs is the ordinary way to
 * hit that:
 *
 *   tab A  vault.put(dev-local, K_A) then registry.add(dev-local) -> unlocked
 *   tab B  vault.put(dev-local, K_B) then registry.add(dev-local) -> duplicate,
 *          and the rollback deletes the vault tab A is holding open
 *
 * Tab A is left signed in against a vault that no longer exists, and everything
 * it wrote under K_A is unreadable even after the vault is stood up again.
 *
 * Web Locks is the right primitive because the collision is cross-context and
 * the critical section is asynchronous. The connector runtime already uses it
 * for its own single-owner guard (`install-connector-runtime.ts`). The
 * in-process fallback below is not a substitute, because it only serializes
 * callers in THIS context, but it is what keeps the ordering honest in jsdom
 * and on a runtime without the API, where there is no second context to race.
 */

const LOCK_PREFIX = "cognia-account-provision"

/** In-process tail per id, for runtimes with no Web Locks (jsdom, old webviews). */
const chains = new Map<string, Promise<unknown>>()

/**
 * Ids this context is already inside the critical section for.
 *
 * The lock is taken at two nested depths on purpose: `load()` holds it while it
 * decides between adopting and provisioning, and `createAccount` holds it
 * around its own check-then-provision. Web Locks are not re-entrant, so without
 * this the inner request would queue behind the outer one and neither would
 * ever be granted.
 */
const held = new Set<string>()

function lockManager(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
}

/**
 * Run `critical` while holding the provisioning lock for `accountId`.
 *
 * Resolves with whatever `critical` returns and rejects with whatever it
 * throws, because the lock is a mutex and never an error boundary. It is
 * released as soon as `critical` settles, rejection included.
 *
 * Callers must re-read the registry INSIDE the critical section. Holding the
 * lock says nothing about what happened before it was granted, and the loser of
 * the race is precisely the caller whose earlier read is now stale.
 *
 * Re-entrant for the SAME id in the same context: a nested call runs straight
 * through rather than queueing behind the outer holder, which would deadlock.
 */
export async function withAccountProvisioningLock<T>(
  accountId: string,
  critical: () => Promise<T>
): Promise<T> {
  const name = `${LOCK_PREFIX}:${accountId}`
  if (held.has(name)) return critical()

  const enter = async (): Promise<T> => {
    held.add(name)
    try {
      return await critical()
    } finally {
      held.delete(name)
    }
  }

  const locks = lockManager()
  if (locks?.request) {
    return (await locks.request(name, enter)) as T
  }

  // Chain onto whatever is already queued for this id, taking the same turn
  // whether the predecessor resolved or rejected. A failed attempt must not
  // wedge every later one.
  const previous = chains.get(name) ?? Promise.resolve()
  const run = previous.then(enter, enter)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  chains.set(name, settled)
  void settled.then(() => {
    // Drop the entry only while this is still the tail, so a later waiter that
    // has already chained onto it keeps its place in line.
    if (chains.get(name) === settled) chains.delete(name)
  })
  return run
}

/** Test seam: drop the in-process chains between cases. */
export function __resetAccountProvisioningLocksForTests(): void {
  chains.clear()
  held.clear()
}
