import type { AccountRegistryState, LocalAccountRecord } from "./account-types"

export const ACCOUNT_REGISTRY_BOOT_TIMEOUT_MS = 15_000

export type AccountRegistryBootErrorCode = "registry-timeout" | "registry-unavailable"

export class AccountRegistryBootError extends Error {
  readonly name = "AccountRegistryBootError"

  constructor(
    readonly code: AccountRegistryBootErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export type AccountRegistryBootSnapshot = [LocalAccountRecord[], AccountRegistryState]

/** Bound only the registry read, before account provisioning or unlock can start. */
export async function readAccountRegistryForBoot(
  registry: { readBootSnapshot: (signal: AbortSignal) => Promise<AccountRegistryBootSnapshot> },
  timeoutMs = ACCOUNT_REGISTRY_BOOT_TIMEOUT_MS
): Promise<AccountRegistryBootSnapshot> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => registry.readBootSnapshot(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new AccountRegistryBootError(
            "registry-timeout",
            "Reading the local account registry timed out."
          )
          // Reject first so an abort-triggered DatabaseClosedError cannot hide
          // the actionable timeout code. A late read cannot continue boot.
          reject(error)
          controller.abort(error)
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    if (error instanceof AccountRegistryBootError) throw error
    throw new AccountRegistryBootError(
      "registry-unavailable",
      error instanceof Error ? error.message : "The local account registry is unavailable.",
      { cause: error }
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
