// Full-fidelity snapshot / restore of the per-provider subscription vaults.
//
// Lifted out of `components/settings/subscription/import-export-buttons.tsx`
// (2026-06-07) so the WebDAV cloud-sync pipeline and the manual export/import
// dialogs share one implementation — the snapshot shape feeding
// `buildSubscriptionPackage` must never drift between the two paths.

import {
  getAccount,
  getActiveAccount,
  getProviderPreset,
  listAccounts,
  listPresets,
  saveAccount,
  saveProviderPreset,
  setActiveAccount,
  setDefaultPreset,
  setProviderPreset,
} from "@/lib/subscription/core/transport"
import type { Account, ProviderId, ProviderVault } from "@/types/subscription"
import { ALL_PROVIDER_IDS } from "@/types/subscription"

/**
 * Snapshot every provider's vault (full credential bytes + presets + active
 * pointer). Providers with nothing to record are omitted.
 */
export async function snapshotVaults(): Promise<Partial<Record<ProviderId, ProviderVault>>> {
  const result: Partial<Record<ProviderId, ProviderVault>> = {}
  for (const provider of ALL_PROVIDER_IDS) {
    const summaries = await listAccounts(provider)
    // `getProviderPreset` returns the resolved default preset, so its id is the
    // vault's `defaultPresetId`.
    const [activeSnapshot, presets, defaultPreset] = await Promise.all([
      getActiveAccount(provider),
      listPresets(provider),
      getProviderPreset(provider),
    ])
    if (summaries.length === 0) {
      // Still record the empty vault when there's an active pointer / presets.
      if (activeSnapshot.activeAccountId || presets.length > 0) {
        result[provider] = {
          schemaVersion: 3,
          accounts: [],
          activeAccountId: activeSnapshot.activeAccountId,
          presets,
          defaultPresetId: defaultPreset?.id,
        }
      }
      continue
    }
    const fullAccounts: Account[] = []
    for (const summary of summaries) {
      const account = await getAccount(provider, summary.id)
      if (account) fullAccounts.push(account)
    }
    result[provider] = {
      schemaVersion: 3,
      accounts: fullAccounts,
      activeAccountId: activeSnapshot.activeAccountId,
      presets,
      defaultPresetId: defaultPreset?.id,
    }
  }
  return result
}

/**
 * Write snapshotted vaults back into the keyring, one account / preset at a
 * time (upserts — existing accounts with the same id are replaced, others are
 * left alone). Returns the number of accounts written.
 */
export async function applyVaults(
  vaults: Partial<Record<ProviderId, ProviderVault>>
): Promise<{ accountCount: number }> {
  let accountCount = 0
  for (const provider of Object.keys(vaults) as ProviderId[]) {
    const vault = vaults[provider]
    if (!vault) continue
    for (const account of vault.accounts) {
      await saveAccount(provider, account)
      accountCount += 1
    }
    // v3 preset library + default pointer.
    for (const preset of vault.presets ?? []) {
      await saveProviderPreset(provider, preset)
    }
    if (vault.defaultPresetId !== undefined) {
      await setDefaultPreset(provider, vault.defaultPresetId ?? null)
    }
    // Legacy v2 backups carried a single `preset`; fold it in via the shim so
    // older exports still restore.
    if ((vault.presets === undefined || vault.presets.length === 0) && vault.preset !== undefined) {
      await setProviderPreset(provider, vault.preset ?? null)
    }
    if (vault.activeAccountId !== undefined) {
      await setActiveAccount(provider, vault.activeAccountId ?? null)
    }
  }
  return { accountCount }
}
