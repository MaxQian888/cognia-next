import type { ProviderId } from "@/types/subscription"

/** Stable persisted key for one vault account's quota-network permission. */
export function limitsQueryAccountKey(provider: ProviderId, accountId: string): string {
  return `${provider}:${encodeURIComponent(accountId)}`
}

/** Missing settings are intentionally disabled. */
export function isLimitsQueryEnabled(
  enabledAccounts: readonly string[] | undefined,
  provider: ProviderId,
  accountId: string
): boolean {
  if (!accountId) return false
  return enabledAccounts?.includes(limitsQueryAccountKey(provider, accountId)) === true
}

/** Return a de-duplicated immutable policy list with one account toggled. */
export function setLimitsQueryEnabled(
  enabledAccounts: readonly string[] | undefined,
  provider: ProviderId,
  accountId: string,
  enabled: boolean
): string[] {
  const key = limitsQueryAccountKey(provider, accountId)
  const current = [...new Set(enabledAccounts ?? [])]
  if (enabled) return current.includes(key) ? current : [...current, key]
  return current.filter((entry) => entry !== key)
}
