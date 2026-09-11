import type { ResolvedProvider, ProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"
import { listProviderModels, getProviderModel } from "@/lib/ai/operations/handlers/discovery"
import { restBaseOf } from "@/lib/ai/operations/handlers/http"
import type { ProviderOperationPersistence } from "@/lib/ai/operations/persistence"
import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"
import { getSubscriptionProvider } from "./provider-registry"
import { resolveManagedSubscriptionCredential } from "./managed-key-credential"
import { useAccountStore } from "@/stores/account/account-store"
import { getAccount, getActiveAccount, getProviderPreset, listPresets } from "./transport"

export class SubscriptionModelDiscoveryError extends Error {
  constructor(readonly code: "unavailable" | "credentialsRequired" | "invalidBaseUrl") {
    super(code)
    this.name = "SubscriptionModelDiscoveryError"
  }
}

export interface SubscriptionModelDiscoveryInput {
  definition: SubscriptionProviderDefinition
  accountId?: string
  /** Preview inputs stay in memory; the plugin never receives the key. */
  preview?: { apiKey: string; baseUrl?: string; presetId?: string | null }
  signal?: AbortSignal
}

const settings: ProviderSettingsSnapshot = {
  providers: {},
  customProviders: [],
  defaultProvider: undefined,
}
// Preview and settings refresh publish only the caller-approved metadata. An
// abandoned form must not populate a persistent inventory for an unsaved key.
const transientPersistence: ProviderOperationPersistence = {
  readInventory: async () => undefined,
  writeInventory: async () => {},
  writeSnapshots: async () => {},
  lastError: undefined,
}

function assertAvailable(input: SubscriptionModelDiscoveryInput) {
  input.signal?.throwIfAborted()
  const definition = input.definition
  if (
    definition.available === false ||
    (definition.source === "plugin" && getSubscriptionProvider(definition.id) !== definition)
  ) {
    throw new SubscriptionModelDiscoveryError("unavailable")
  }
}

async function resolve(input: SubscriptionModelDiscoveryInput): Promise<ResolvedProvider> {
  assertAvailable(input)
  const { definition, preview } = input
  let credentials
  if (preview) {
    const apiKey = preview.apiKey.trim()
    if (!apiKey || /\s/.test(apiKey))
      throw new SubscriptionModelDiscoveryError("credentialsRequired")
    const boundId = input.accountId
      ? (await getAccount(definition.id, input.accountId))?.presetId
      : preview.presetId
    const bound = boundId
      ? (await listPresets(definition.id)).find((entry) => entry.id === boundId)
      : null
    const preset = bound ?? (await getProviderPreset(definition.id))
    const baseURL = preset?.baseUrl?.trim() || preview.baseUrl?.trim() || definition.baseUrl
    try {
      const url = new URL(baseURL ?? "")
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error()
    } catch {
      throw new SubscriptionModelDiscoveryError("invalidBaseUrl")
    }
    credentials = {
      apiKey,
      baseURL: restBaseOf({ protocol: definition.protocol ?? "openai", baseURL }),
      headers: Object.fromEntries(
        Object.entries(preset?.extraHeaders ?? {}).filter(
          ([name]) => !name.toLowerCase().startsWith("x-cognia-")
        )
      ),
      apiFlavor: definition.apiFlavor,
    }
  } else {
    credentials = await resolveManagedSubscriptionCredential(definition, input.accountId)
    if (!credentials) throw new SubscriptionModelDiscoveryError("credentialsRequired")
  }
  assertAvailable(input)
  return {
    kind: "resolved",
    providerId: definition.id,
    protocol: definition.protocol ?? "openai",
    ...credentials,
    model: definition.models?.[0],
    isCustomProvider: false,
    useProxy: false,
  }
}

async function assertUnchanged(input: SubscriptionModelDiscoveryInput, provider: ResolvedProvider) {
  const current = await resolve(input)
  if (JSON.stringify(current) !== JSON.stringify(provider)) {
    throw new DOMException("Subscription account or endpoint changed", "AbortError")
  }
}

async function sessionIdentity(input: SubscriptionModelDiscoveryInput) {
  return {
    unlockedAccountId: useAccountStore.getState().unlockedAccountId,
    activeAccountId:
      !input.preview && !input.accountId
        ? (await getActiveAccount(input.definition.id)).activeAccountId
        : input.accountId,
  }
}

async function assertSessionUnchanged(
  input: SubscriptionModelDiscoveryInput,
  before: Awaited<ReturnType<typeof sessionIdentity>>
) {
  const after = await sessionIdentity(input)
  if (
    before.unlockedAccountId !== after.unlockedAccountId ||
    before.activeAccountId !== after.activeAccountId
  ) {
    throw new DOMException("Subscription account changed", "AbortError")
  }
  assertAvailable(input)
}

export async function discoverSubscriptionModels(input: SubscriptionModelDiscoveryInput) {
  const identity = await sessionIdentity(input)
  const provider = await resolve(input)
  await assertSessionUnchanged(input, identity)
  const result = await listProviderModels({
    provider,
    settings,
    subscription: input.definition,
    refresh: true,
    signal: input.signal,
    persistence: transientPersistence,
  })
  await assertUnchanged(input, provider)
  await assertSessionUnchanged(input, identity)
  return result
}

export async function getSubscriptionModel(
  input: SubscriptionModelDiscoveryInput & { model: string }
) {
  const identity = await sessionIdentity(input)
  const provider = await resolve(input)
  await assertSessionUnchanged(input, identity)
  const result = await getProviderModel({
    provider,
    settings,
    subscription: input.definition,
    model: input.model,
    signal: input.signal,
    persistence: transientPersistence,
  })
  await assertUnchanged(input, provider)
  await assertSessionUnchanged(input, identity)
  return result
}
