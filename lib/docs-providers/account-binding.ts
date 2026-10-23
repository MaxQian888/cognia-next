/** Shared identity checks for picker results, fetches and staged citations. */
import { DocsProviderError } from "./types"
import type { DocsProviderAccount, DocsProviderAccountBinding, RemoteDocRef } from "./types"

export function bindRemoteDocRef(ref: RemoteDocRef, account: DocsProviderAccount): RemoteDocRef {
  assertRemoteDocBinding(ref, account.id, account.authorizationEpoch)
  return {
    ...ref,
    accountBinding: {
      accountId: account.id,
      ...(account.authorizationEpoch ? { authorizationEpoch: account.authorizationEpoch } : {}),
    },
  }
}

export function assertRemoteDocBinding(
  ref: RemoteDocRef,
  accountId: string,
  authorizationEpoch?: string
): void {
  const binding = ref.accountBinding
  if (
    binding &&
    (binding.accountId !== accountId || binding.authorizationEpoch !== authorizationEpoch)
  ) {
    throw new DocsProviderError("notAuthorized")
  }
}

export function accountMatchesBinding(
  account: DocsProviderAccount,
  binding: DocsProviderAccountBinding
): boolean {
  return (
    account.id === binding.accountId && account.authorizationEpoch === binding.authorizationEpoch
  )
}
