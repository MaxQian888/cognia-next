/**
 * Headless account bootstrap (ADR-0059 T-B3 / F3 brain side).
 *
 * The brain serves exactly one local account (`COGNIA_LOCAL_ACCOUNT_ID`,
 * default mirrors `HEADLESS_LOCAL_ACCOUNT_ID` in
 * `src-tauri/src/bin/cognia-server.rs`). This module creates it in the
 * `LocalAccountRegistry` on first boot, activates its Dexie database, and
 * unlocks it through the guarded host-unlock — required because
 * `desktop-sync-source` rejects pulls unless `unlockedAccountId` matches the
 * request's `account_id`.
 */
import { LocalAccountRegistry } from "@/lib/accounts/account-db"
import type { PasswordVerifierRecord } from "@/lib/accounts/account-types"
import { unlockAccountForHost, useAccountStore } from "@/stores/account/account-store"

/** Must stay in lockstep with `HEADLESS_LOCAL_ACCOUNT_ID` in cognia-server.rs. */
export const HEADLESS_LOCAL_ACCOUNT_ID = "local_acct_a"

/**
 * A syntactically-valid verifier that can never verify: the headless account
 * is host-owned (unlock = host identity), so no password exists. Marked with
 * a distinct algorithm so the desktop UI could special-case it later.
 */
function hostOwnedVerifier(): PasswordVerifierRecord {
  const randomHex = (bytes: number) =>
    Array.from({ length: bytes }, () => Math.floor(Math.random() * 256))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  return {
    algorithm: "headless-host-owned",
    salt: randomHex(16),
    hash: randomHex(32),
    params: {},
  }
}

export interface EnsureHeadlessAccountOptions {
  /** Injected registry (tests). */
  registry?: LocalAccountRegistry
  /** Injected raw key (tests/embedding); defaults to the supervisor env. */
  accountContentKey?: Uint8Array
}

/**
 * Create-if-missing + activate + host-unlock the brain's account. Returns
 * the account id for convenience.
 */
export async function ensureHeadlessAccount(
  accountId: string = HEADLESS_LOCAL_ACCOUNT_ID,
  opts: EnsureHeadlessAccountOptions = {}
): Promise<string> {
  const registry = opts.registry ?? new LocalAccountRegistry()
  const accounts = await registry.listAccounts()
  if (!accounts.some((account) => account.id === accountId)) {
    await registry.createAccount({
      id: accountId,
      displayName: "Headless brain",
      passwordVerifier: hostOwnedVerifier(),
      activate: true,
    })
  } else {
    await registry.setActiveAccountId(accountId)
  }
  const accountState = useAccountStore.getState()
  if (!accountState.locked && accountState.unlockedAccountId === accountId) return accountId
  const ownsAccountContentKey = opts.accountContentKey === undefined
  const accountContentKey = opts.accountContentKey ?? decodeHeadlessAccountContentKey()
  try {
    await unlockAccountForHost(accountId, accountContentKey)
  } finally {
    if (ownsAccountContentKey) accountContentKey.fill(0)
  }
  return accountId
}

function decodeHeadlessAccountContentKey(): Uint8Array {
  const raw = process.env.COGNIA_ACCOUNT_CONTENT_KEY
  delete process.env.COGNIA_ACCOUNT_CONTENT_KEY
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("COGNIA_ACCOUNT_CONTENT_KEY must contain exactly 32 bytes as hexadecimal.")
  }
  return Uint8Array.from(raw.match(/.{2}/g)!, (pair) => Number.parseInt(pair, 16))
}
