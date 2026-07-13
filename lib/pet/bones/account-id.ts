// Resolves the stable identifier the pet's deterministic appearance derives from.
//
// Precedence:
//   1. `settings.defaultAccountId` — the provider account (UUIDv7), the most
//      meaningful "this pet is yours" anchor across all three shells.
//   2. `settings.installUuid` — a locally-generated random UUID (no PII), written
//      once when no provider account is configured.
//
// `petAccountIdFrom` is pure (used by tests and the render path). `ensure...`
// is the small side-effecting edge that persists a fresh install UUID.

import type { AppSettings } from "@cognia/agent-config-types"

/** Pure: the account id to seed bones from, or null if none is available yet. */
export function petAccountIdFrom(settings: AppSettings | null | undefined): string | null {
  return settings?.defaultAccountId ?? settings?.installUuid ?? null
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
