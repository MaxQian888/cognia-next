import { isBuiltInProviderId } from "@cognia/provider-types"
import {
  getSubscriptionProvider,
  listSubscriptionProviders,
  validateSubscriptionProvider,
} from "./provider-registry"
import type { PluginSubscriptionProviderDefinition } from "@/types/subscription/provider-definition"
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
  listSubscriptionProviderIds,
  listPresets,
  saveAccount,
  saveProviderPreset,
  setActiveAccount,
  setDefaultPreset,
  setProviderPreset,
} from "@/lib/subscription/core/transport"
import type { Account, ProviderId, ProviderVault } from "@/types/subscription"

/**
 * Snapshot every provider's vault (full credential bytes + presets + active
 * pointer). Providers with nothing to record are omitted.
 */
export async function snapshotVaults(): Promise<Partial<Record<ProviderId, ProviderVault>>> {
  const result: Partial<Record<ProviderId, ProviderVault>> = {}
  for (const provider of await listSubscriptionProviderIds()) {
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
          schemaVersion: 4,
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
      schemaVersion: 4,
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
  vaults: Partial<Record<ProviderId, ProviderVault>>,
  customProviders?: PluginSubscriptionProviderDefinition[]
): Promise<{ accountCount: number }> {
  if (customProviders !== undefined) await restoreCustomSubscriptionProviders(customProviders)
  let accountCount = 0
  for (const provider of Object.keys(vaults) as ProviderId[]) {
    const vault = vaults[provider]
    if (!vault) continue
    for (const account of vault.accounts) {
      await saveAccount(provider, account)
      accountCount += 1
    }
    // Preset library + default pointer.
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

/** Export only user-owned setup fields, never plugin registrations or provider API keys. */
export async function snapshotCustomSubscriptionProviders(): Promise<
  PluginSubscriptionProviderDefinition[]
> {
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  return listSubscriptionProviders(useSettingsStore.getState().settings?.customProviders)
    .filter((definition) => definition.source === "custom")
    .map((definition) => ({
      id: definition.id,
      name: definition.name,
      baseUrl: definition.baseUrl!,
      protocol: definition.protocol!,
      models:
        definition.modelMetadata?.map((model) =>
          Object.entries(model).every(([key, value]) => key === "id" || value === undefined)
            ? model.id
            : model
        ) ?? definition.models!,
      ...(definition.apiFlavor ? { apiFlavor: definition.apiFlavor } : {}),
      ...(definition.modelApi ? { modelApi: definition.modelApi } : {}),
      ...(definition.apiKeyUrl ? { apiKeyUrl: definition.apiKeyUrl } : {}),
      ...(definition.usageUrl ? { usageUrl: definition.usageUrl } : {}),
      ...(definition.docsUrl ? { docsUrl: definition.docsUrl } : {}),
      ...(definition.description ? { description: definition.description } : {}),
    }))
}

async function restoreCustomSubscriptionProviders(
  definitions: PluginSubscriptionProviderDefinition[]
): Promise<void> {
  if (!Array.isArray(definitions)) throw new Error("Invalid custom subscription provider metadata")
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  const existing = useSettingsStore.getState().settings?.customProviders ?? []
  const seen = new Set<string>()
  // Validate every definition and collision before mutating settings or vaults.
  for (const definition of definitions) {
    validateSubscriptionProvider(definition)
    if (
      definition.id.includes(":") ||
      isBuiltInProviderId(definition.id) ||
      getSubscriptionProvider(definition.id) !== undefined ||
      seen.has(definition.id)
    ) {
      throw new Error("Subscription backup contains a reserved or duplicate custom provider id")
    }
    seen.add(definition.id)
    const current = existing.find((provider) => provider.id === definition.id)
    if (
      current &&
      (!current.subscription ||
        current.baseURL !== definition.baseUrl ||
        current.apiProtocol !== definition.protocol ||
        (current.apiFlavor ?? "chat") !== (definition.apiFlavor ?? "chat"))
    ) {
      throw new Error(
        `Custom subscription provider ${definition.id} conflicts with the current connection`
      )
    }
  }
  for (const definition of definitions) {
    const current = existing.find((provider) => provider.id === definition.id)
    await useSettingsStore.getState().upsertCustomProvider({
      ...current,
      id: definition.id,
      providerId: definition.id,
      isCustom: true,
      name: definition.name,
      customName: definition.name,
      baseURL: definition.baseUrl,
      apiProtocol: definition.protocol,
      apiFlavor: definition.apiFlavor,
      customModels: definition.models.map((model) =>
        typeof model === "string" ? model : model.id
      ),
      models: definition.models.map((model) => (typeof model === "string" ? model : model.id)),
      customModelMetadata: Object.fromEntries(
        definition.models.map((model) => {
          if (typeof model === "string") return [model, { id: model }]
          return [model.id, model]
        })
      ),
      defaultModel:
        current?.defaultModel ??
        (typeof definition.models[0] === "string" ? definition.models[0] : definition.models[0].id),
      enabled: current?.enabled ?? true,
      subscription: {
        apiKeyUrl: definition.apiKeyUrl,
        usageUrl: definition.usageUrl,
        docsUrl: definition.docsUrl,
        description: definition.description,
        modelApi: definition.modelApi,
      },
    })
  }
}
