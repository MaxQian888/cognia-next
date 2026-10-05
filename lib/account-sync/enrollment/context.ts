/**
 * Everything an enrollment flow needs for one profile's space: the session
 * (who), the API (where) and the vault (this device's secrets).
 */

import { SyncApi } from "../sync-api"
import type { SyncSession } from "../sync-session"
import { createAccountSyncVault, type AccountSyncVault } from "../vault-store"

export interface AccountSyncContext {
  session: Pick<SyncSession, "localAccountId" | "issuer" | "userId" | "spaceId" | "syncUrl">
  api: SyncApi
  vault: AccountSyncVault
  now: () => number
}

export interface ContextDeps {
  fetchImpl?: typeof fetch
  vault?: AccountSyncVault
  now?: () => number
}

export function createAccountSyncContext(
  session: SyncSession,
  deps: ContextDeps = {}
): AccountSyncContext {
  const now = deps.now ?? Date.now
  return {
    session,
    api: new SyncApi({
      baseUrl: session.syncUrl,
      spaceId: session.spaceId,
      accessToken: () => session.accessToken(),
      fetchImpl: deps.fetchImpl,
      now,
    }),
    vault:
      deps.vault ??
      createAccountSyncVault({ localAccountId: session.localAccountId, spaceId: session.spaceId }),
    now,
  }
}
