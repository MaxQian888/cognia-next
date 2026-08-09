// Resolves the stable identifier the pet's deterministic appearance derives from.
//
// Precedence:
//   1. The default account for `settings.defaultProvider` (legacy singular
//      default remains readable until the next settings write).
//   2. `settings.installUuid` — a locally-generated random UUID (no PII), written
//      once when no provider account is configured.
//
// `petAccountIdFrom` is pure (used by tests and the render path). `ensure...`
// is the small side-effecting edge that persists a fresh install UUID.

import type { AppSettings, SubscriptionAccountProvider } from "@cognia/agent-config-types"

function isSubscriptionAccountProvider(
  value: string | undefined
): value is SubscriptionAccountProvider {
  return value === "anthropic" || value === "codex" || value === "opencode"
}

function subscriptionProviderFor(
  value: string | undefined
): SubscriptionAccountProvider | undefined {
  if (value === "opencode-go") return "opencode"
  return isSubscriptionAccountProvider(value) ? value : undefined
}

/** Pure: the account id to seed bones from, or null if none is available yet. */
export function petAccountIdFrom(settings: AppSettings | null | undefined): string | null {
  if (!settings) return null
  const provider = subscriptionProviderFor(settings.defaultProvider)
  const providerDefault = provider ? settings.defaultAccountIds?.[provider] : undefined
  const legacyDefault = provider ? settings.defaultAccountId : undefined
  return providerDefault ?? legacyDefault ?? settings.installUuid ?? null
}

/**
 * Resolve the seed id, generating + persisting an install UUID if neither a
 * provider account nor a prior install UUID exists.
 *
 * @param save persists an `AppSettings` patch (the settings-store `save` action).
 */
export async function ensurePetAccountId(
  settings: AppSettings | null | undefined,
  save: (patch: Partial<AppSettings>) => Promise<unknown> | unknown
): Promise<string> {
  const existing = petAccountIdFrom(settings)
  if (existing) return existing
  const installUuid = crypto.randomUUID()
  await save({ installUuid })
  return installUuid
}
