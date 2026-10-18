import { transport } from "@/lib/tauri"
import { useAccountStore } from "@/stores/account/account-store"
import type {
  SiwcConnectionSummary,
  SiwcLoginAttempt,
  SiwcLoginProgress,
  SiwcModel,
  SiwcSignOutResult,
} from "@/types/subscription/siwc"

function reference(value: string): string {
  if (!value.trim()) throw new Error("SIWC reference must not be empty")
  return value
}

function unlockedAccountId(): string {
  const accountId = useAccountStore.getState().unlockedAccountId
  if (!accountId?.trim()) throw new Error("A local account must be unlocked before using SIWC")
  return accountId
}

function accountScope() {
  const localAccountId = unlockedAccountId()
  let unchanged = true
  const unsubscribe = useAccountStore.subscribe((state) => {
    if (state.unlockedAccountId !== localAccountId) unchanged = false
  })
  return {
    localAccountId,
    current: () => unchanged && useAccountStore.getState().unlockedAccountId === localAccountId,
    close: unsubscribe,
  }
}

async function scoped<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const scope = accountScope()
  try {
    const result = await transport.call<T>(command, {
      ...args,
      localAccountId: scope.localAccountId,
    })
    if (!scope.current()) {
      throw new Error("The unlocked local account changed during the SIWC operation")
    }
    return result
  } finally {
    scope.close()
  }
}

/** A read-only projection: no keychain creation, renewal, or legacy vault enumeration. */
export function listSiwcConnections(): Promise<SiwcConnectionSummary[]> {
  return scoped("siwc_list_connections")
}

/** The Host opens the browser. Authorization URLs and all tokens remain native. */
export async function beginSiwcLogin(connectionId?: string): Promise<SiwcLoginAttempt> {
  const args = connectionId !== undefined ? { connectionId: reference(connectionId) } : {}
  const scope = accountScope()
  try {
    const attempt = await transport.call<SiwcLoginAttempt>("siwc_begin_login", {
      localAccountId: scope.localAccountId,
      ...args,
    })
    if (!scope.current()) {
      // Begin can finish after unmount before the component knows its attempt ID.
      await cancelSiwcLogin(attempt.attemptId, scope.localAccountId).catch(() => undefined)
      throw new Error("The unlocked local account changed during the SIWC operation")
    }
    return attempt
  } finally {
    scope.close()
  }
}

export async function pollSiwcLogin(attemptId: string): Promise<SiwcLoginProgress> {
  return scoped("siwc_poll_login", { attemptId: reference(attemptId) })
}

/** Cleanup is deliberately allowed in the original scope after a switch/lock. */
export async function cancelSiwcLogin(attemptId: string, localAccountId: string): Promise<void> {
  await transport.call("siwc_cancel_login", {
    localAccountId: reference(localAccountId),
    attemptId: reference(attemptId),
  })
}

export async function refreshSiwcConnection(connectionId: string): Promise<SiwcConnectionSummary> {
  return scoped("siwc_refresh_connection", { connectionId: reference(connectionId) })
}

export async function signOutSiwcConnection(connectionId: string): Promise<SiwcSignOutResult> {
  return scoped("siwc_sign_out", { connectionId: reference(connectionId) })
}

export async function deleteSiwcConnection(connectionId: string): Promise<void> {
  return scoped("siwc_delete_connection", { connectionId: reference(connectionId) })
}

export async function listSiwcModels(connectionId: string): Promise<SiwcModel[]> {
  return scoped("siwc_list_models", { connectionId: reference(connectionId) })
}
