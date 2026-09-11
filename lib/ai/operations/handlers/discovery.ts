/**
 * `models.list` and `models.get`.
 *
 * One listing routine layers the same sources the settings model picker
 * uses (`buildProviderModelDiscoverySnapshot`): the static catalog entry,
 * the models.dev mirror, and a live remote listing when the vendor exposes
 * one. The remote lister is looked up by provider id, then by protocol, in
 * two maps. A built-in whose surface facts say "no models endpoint" (relays,
 * media-only vendors) never gets a remote call and answers from the catalog.
 */

import type { z } from "zod"
import type {
  modelsGetInput,
  modelsGetOutput,
  modelsListInput,
  modelsListOutput,
  ProviderModelCandidate,
  ProviderModelSource,
} from "@cognia/provider-types"
import { getBuiltInProviderCatalogEntry } from "@cognia/provider-types/built-in-provider-catalog"
import { LOCAL_PROVIDER_NAMES, type LocalProviderName } from "@cognia/provider-types/local-provider"
import { builtInProviderSurfaceFacts } from "@cognia/provider-core/operations/capability-matrix"
import {
  buildProviderModelDiscoverySnapshot,
  discoverCLIProxyAPIModels,
  discoverLocalProviderModels,
  discoverOpenAICompatibleModels,
  discoverOpenRouterModels,
  parseProviderModelWire,
  parseProviderModelsWire,
  type DiscoveredProviderModel,
} from "@cognia/provider-core/providers/model-discovery"
import { getCatalogModelsForProvider } from "@cognia/provider-core/providers/models-dev-sync"
import { discoverBedrockModelsViaSidecar } from "@/lib/claude/feature-call"
import type { ProviderSettingsSnapshot, ResolvedProvider } from "@/lib/ai/provider-consumption"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import type { SubscriptionProviderDefinition } from "@/types/subscription/provider-definition"

import { credentialAffinityOf } from "../credential-affinity"
import { ProviderOperationFailureError } from "../failure"
import { providerOperationPersistence, type ProviderOperationPersistence } from "../persistence"
import type {
  ProviderOperationHandlerRegistration,
  ProviderOperationProviderMatch,
} from "../registry"
import { providerRequest } from "./http"

export type ModelsListInput = z.infer<typeof modelsListInput>
export type ModelsGetInput = z.infer<typeof modelsGetInput>

/**
 * The contract listing. `source` names the highest-authority layer that
 * contributed, `freshness` says whether the vendor layer was fetched now
 * (`fresh`), reused from the stored listing (`stale`) or absent (`static`),
 * and `models` keeps each model's own provenance.
 */
export type ModelsListOutput = Omit<z.infer<typeof modelsListOutput>, "models"> & {
  models: DiscoveredProviderModel[]
}

export type ModelsGetOutput = Omit<z.infer<typeof modelsGetOutput>, "model"> & {
  model: DiscoveredProviderModel | null
  source: ModelsListOutput["source"]
  freshness: ModelsListOutput["freshness"]
}

/** How long a stored listing answers before a live call is made again. */
export const INVENTORY_TTL_MS = 60 * 60 * 1000

type RemoteLister = (
  provider: ResolvedProvider,
  signal: AbortSignal | undefined
) => Promise<ProviderModelCandidate[]>

function requireBaseURL(provider: ResolvedProvider): string {
  if (!provider.baseURL) {
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: `${provider.providerId} has no base URL to list models from`,
    })
  }
  return provider.baseURL
}

interface GoogleModelsWire {
  models?: Array<{
    name: string
    displayName?: string
    inputTokenLimit?: number
    outputTokenLimit?: number
    supportedGenerationMethods?: string[]
  }>
}

const anthropicLister: RemoteLister = async (provider, signal) => {
  const models = new Map<string, ProviderModelCandidate>()
  const cursors = new Set<string>()
  let path = "models"
  for (let page = 0; page < 100; page++) {
    signal?.throwIfAborted()
    const { json } = await providerRequest<Record<string, unknown>>(provider, { path, signal })
    const entries = parseProviderModelsWire(json)
    for (const model of entries) models.set(model.id, model)
    if (json.has_more === undefined || json.has_more === false) return [...models.values()]
    if (
      json.has_more !== true ||
      !entries.length ||
      typeof json.last_id !== "string" ||
      !json.last_id ||
      cursors.has(json.last_id)
    ) {
      throw new Error("Provider returned invalid models pagination")
    }
    cursors.add(json.last_id)
    path = `models?after_id=${encodeURIComponent(json.last_id)}`
  }
  throw new Error("Provider models pagination exceeded 100 pages")
}

const googleLister: RemoteLister = async (provider, signal) => {
  const { json } = await providerRequest<GoogleModelsWire>(provider, {
    path: "models?pageSize=200",
    signal,
  })
  return (json.models ?? [])
    .filter((model) => (model.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((model) => ({
      id: model.name.replace(/^models\//, ""),
      name: model.displayName ?? model.name,
      contextLength: model.inputTokenLimit,
      maxInputTokens: model.inputTokenLimit,
      maxOutputTokens: model.outputTokenLimit,
      supportsTools: true,
      supportsStreaming: true,
    }))
}

const openAiCompatibleLister: RemoteLister = (provider, signal) =>
  discoverOpenAICompatibleModels({
    baseURL: requireBaseURL(provider),
    apiKey: provider.apiKey,
    ...(signal ? { signal } : {}),
  })

const subscriptionOpenAiLister: RemoteLister = async (provider, signal) => {
  const { json } = await providerRequest(provider, { path: "models", signal })
  return parseProviderModelsWire(json)
}

const bedrockLister: RemoteLister = (provider, signal) =>
  discoverBedrockModelsViaSidecar(
    {
      protocol: "bedrock",
      apiKey: provider.apiKey,
      baseURL: provider.baseURL ?? provider.bedrock?.baseURL,
      bedrockAuthMode: provider.bedrock?.authMode,
      region: provider.bedrock?.region,
      accessKeyId: provider.bedrock?.accessKeyId,
      secretAccessKey: provider.bedrock?.secretAccessKey,
      sessionToken: provider.bedrock?.sessionToken,
      profile: provider.bedrock?.profile,
      roleArn: provider.bedrock?.roleArn,
      roleSessionName: provider.bedrock?.roleSessionName,
    },
    signal
  ).then((models) =>
    models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      provider: model.provider,
      supportsTools: true,
      supportsVision: model.supportsVision ?? false,
      supportsStreaming: model.supportsStreaming ?? true,
    }))
  )

const cliProxyLister: RemoteLister = (provider) => {
  const url = provider.baseURL ? new URL(provider.baseURL) : undefined
  return discoverCLIProxyAPIModels({
    apiKey: provider.apiKey ?? "",
    ...(url ? { host: url.hostname } : {}),
    ...(url?.port ? { port: Number(url.port) } : {}),
  })
}

function localLister(name: LocalProviderName): RemoteLister {
  return (provider) => discoverLocalProviderModels(name, provider.baseURL)
}

/** Vendor-specific listers, keyed by provider id. */
export const REMOTE_LISTERS_BY_PROVIDER: ReadonlyMap<string, RemoteLister> = new Map<
  string,
  RemoteLister
>([
  ["openrouter", (provider) => discoverOpenRouterModels(provider.apiKey)],
  ["cliproxyapi", cliProxyLister],
  ["bedrock", bedrockLister],
  ...LOCAL_PROVIDER_NAMES.map((name): [string, RemoteLister] => [name, localLister(name)]),
])

/** Protocol-generic listers. */
export const REMOTE_LISTERS_BY_PROTOCOL: ReadonlyMap<ResolvedProvider["protocol"], RemoteLister> =
  new Map<ResolvedProvider["protocol"], RemoteLister>([
    ["anthropic", anthropicLister],
    ["google", googleLister],
    ["openai", openAiCompatibleLister],
  ])

function remoteListerFor(
  provider: ResolvedProvider,
  subscription?: SubscriptionProviderDefinition
): RemoteLister | undefined {
  if (subscription?.source === "plugin" || subscription?.source === "custom") {
    if (!subscription.modelApi?.list) return undefined
    return provider.protocol === "anthropic" ? anthropicLister : subscriptionOpenAiLister
  }
  const entry = getBuiltInProviderCatalogEntry(provider.providerId)
  if (entry && !builtInProviderSurfaceFacts(entry).modelsEndpoint) return undefined
  return (
    REMOTE_LISTERS_BY_PROVIDER.get(provider.providerId) ??
    REMOTE_LISTERS_BY_PROTOCOL.get(provider.protocol)
  )
}

function catalogModelsOf(
  providerId: string,
  subscription?: SubscriptionProviderDefinition
): ProviderModelCandidate[] | undefined {
  if (subscription?.source === "plugin" || subscription?.source === "custom") {
    return subscription.modelMetadata ?? subscription.models?.map((id) => ({ id }))
  }
  return getBuiltInProviderCatalogEntry(providerId)?.models?.map((model) => ({ ...model }))
}

function subscriptionDefinitionOf(
  provider: ResolvedProvider,
  settings: ProviderSettingsSnapshot,
  subscription?: SubscriptionProviderDefinition
): SubscriptionProviderDefinition | undefined {
  const providerId = provider.providerId
  if (subscription && subscription.id !== providerId) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: "Subscription definition does not match the requested provider",
    })
  }
  const registered = subscription ?? getSubscriptionProvider(providerId)
  if (registered) return registered
  const custom = settings.customProviders.find((entry) => entry.id === providerId)
  if (!custom?.subscription) return undefined
  const protocol = custom.protocol ?? provider.protocol
  const modelApi = custom.subscription.modelApi
  if (
    (protocol !== "openai" && protocol !== "anthropic") ||
    (modelApi !== undefined &&
      (!modelApi ||
        typeof modelApi !== "object" ||
        Array.isArray(modelApi) ||
        typeof modelApi.list !== "boolean" ||
        (modelApi.retrieve !== undefined && typeof modelApi.retrieve !== "boolean") ||
        Object.keys(modelApi).some((key) => key !== "list" && key !== "retrieve")))
  ) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: "Custom subscription has an invalid model API declaration",
    })
  }
  return {
    id: providerId,
    name: custom.name,
    authMode: "api-key",
    source: "custom",
    protocol: protocol === "anthropic" ? "anthropic" : "openai",
    baseUrl: custom.baseURL ?? provider.baseURL,
    models: custom.models?.map((model) => model.id),
    modelMetadata: custom.models?.map((model) => ({ ...model })),
    modelApi,
    ...(custom.apiFlavor === "chat" || custom.apiFlavor === "responses"
      ? { apiFlavor: custom.apiFlavor }
      : {}),
  }
}

function assertSubscriptionActive(
  providerId: string,
  subscription?: SubscriptionProviderDefinition
) {
  if (subscription?.source === "plugin" && getSubscriptionProvider(providerId) !== subscription) {
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: "Subscription plugin is no longer active",
    })
  }
}

function curatedModelsOf(
  provider: ResolvedProvider,
  settings: ProviderSettingsSnapshot
): ProviderModelCandidate[] | undefined {
  if (!provider.isCustomProvider) return undefined
  const definition = settings.customProviders.find((custom) => custom.id === provider.providerId)
  return definition?.models?.map((model) => ({ ...model }))
}

export async function listProviderModels(input: {
  provider: ResolvedProvider
  settings: ProviderSettingsSnapshot
  /** Host-owned definition for an unsaved/custom subscription preview. */
  subscription?: SubscriptionProviderDefinition
  deploymentRef?: string
  /** `true` forces a live vendor listing, absent reuses a fresh stored one. */
  refresh?: boolean
  signal?: AbortSignal
  now?: number
  persistence?: Pick<ProviderOperationPersistence, "readInventory" | "writeInventory">
}): Promise<ModelsListOutput> {
  const { provider, settings } = input
  const persistence = input.persistence ?? providerOperationPersistence
  const now = input.now ?? Date.now()
  const deploymentRef = input.deploymentRef ?? provider.providerId
  const subscription = subscriptionDefinitionOf(provider, settings, input.subscription)
  assertSubscriptionActive(provider.providerId, subscription)
  input.signal?.throwIfAborted()
  const accountRef = credentialAffinityOf(
    JSON.stringify([
      provider.apiKey,
      provider.baseURL?.replace(/\/+$/, ""),
      provider.protocol,
      provider.headers,
    ])
  )
  const lister = remoteListerFor(provider, subscription)

  let remoteModels: ProviderModelCandidate[] | undefined
  let freshness: ModelsListOutput["freshness"] = "static"
  let remoteLastFetchedAt: number | undefined
  if (lister && !input.refresh) {
    // A listing taken under another account is never reused: a key rotation
    // or an organisation switch changes what the vendor lists.
    const stored = await persistence.readInventory(deploymentRef)
    if (
      stored?.models &&
      stored.accountRef === accountRef &&
      stored.expiresAt !== undefined &&
      stored.expiresAt > now
    ) {
      remoteModels = stored.models
      remoteLastFetchedAt = stored.checkedAt
      freshness = "stale"
    }
  }
  if (lister && !remoteModels) {
    try {
      remoteModels = await lister(provider, input.signal)
      input.signal?.throwIfAborted()
      assertSubscriptionActive(provider.providerId, subscription)
    } catch (error) {
      input.signal?.throwIfAborted()
      assertSubscriptionActive(provider.providerId, subscription)
      await persistence.writeInventory({
        id: `deployment:${deploymentRef}`,
        deploymentRef,
        providerRef: provider.providerId,
        status: "unavailable",
        checkedAt: now,
        availableUpstreamIds: [],
        accountRef,
        normalizedError: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    remoteLastFetchedAt = now
    freshness = "fresh"
    await persistence.writeInventory({
      id: `deployment:${deploymentRef}`,
      deploymentRef,
      providerRef: provider.providerId,
      status: "healthy",
      checkedAt: now,
      availableUpstreamIds: remoteModels.map((model) => model.id),
      accountRef,
      models: remoteModels,
      source: "remote-discovered",
      freshness: "fresh",
      expiresAt: now + INVENTORY_TTL_MS,
    })
  }
  input.signal?.throwIfAborted()
  assertSubscriptionActive(provider.providerId, subscription)
  const snapshot = buildProviderModelDiscoverySnapshot({
    providerId: provider.providerId,
    catalogModels: catalogModelsOf(provider.providerId, subscription),
    modelsDevModels: getCatalogModelsForProvider(provider.providerId),
    remoteModels,
    remoteLastFetchedAt,
    userCuratedModels:
      subscription?.source === "custom" ? undefined : curatedModelsOf(provider, settings),
    remoteOverridesCatalog: subscription?.source === "plugin" || subscription?.source === "custom",
  })
  return {
    models: snapshot.models,
    source: dominantSourceOf(snapshot.models, remoteModels !== undefined),
    freshness,
    fetchedAt: remoteLastFetchedAt ?? now,
  }
}

/** The highest-authority layer that contributed to a listing. */
export function dominantSourceOf(
  models: readonly DiscoveredProviderModel[],
  remoteContributed: boolean
): ProviderModelSource {
  if (remoteContributed) return "remote-discovered"
  const present = new Set(models.flatMap((model) => model.mergedSources))
  if (present.has("user-curated")) return "user-curated"
  if (present.has("models-dev")) return "models-dev"
  return "catalog-static"
}

function modelsListHandler(
  providerMatch: ProviderOperationProviderMatch,
  support: "native" | "derived"
): ProviderOperationHandlerRegistration<ModelsListInput, ModelsListOutput> {
  return {
    operationId: "models.list",
    providerMatch,
    support,
    handler: ({ provider, settings, request, signal }) =>
      listProviderModels({
        provider,
        settings,
        deploymentRef: request.deploymentRef,
        refresh: request.input?.refresh,
        signal,
      }),
  }
}

export async function getProviderModel(input: {
  provider: ResolvedProvider
  settings: ProviderSettingsSnapshot
  subscription?: SubscriptionProviderDefinition
  model: string
  deploymentRef?: string
  signal?: AbortSignal
  persistence?: Pick<ProviderOperationPersistence, "readInventory" | "writeInventory">
}): Promise<ModelsGetOutput> {
  const { provider, settings, signal, model: modelId } = input
  const subscription = subscriptionDefinitionOf(provider, settings, input.subscription)
  assertSubscriptionActive(provider.providerId, subscription)
  if (
    subscription?.modelApi?.retrieve ||
    (provider.providerId === "anthropic" && provider.protocol === "anthropic")
  ) {
    signal?.throwIfAborted()
    const { json } = await providerRequest(provider, {
      path: `models/${encodeURIComponent(modelId)}`,
      signal,
    })
    signal?.throwIfAborted()
    assertSubscriptionActive(provider.providerId, subscription)
    const retrieved = parseProviderModelWire(json)
    const snapshot = buildProviderModelDiscoverySnapshot({
      providerId: provider.providerId,
      catalogModels: catalogModelsOf(provider.providerId, subscription),
      modelsDevModels: getCatalogModelsForProvider(provider.providerId),
      remoteModels: [retrieved],
      remoteLastFetchedAt: Date.now(),
      userCuratedModels:
        subscription?.source === "custom" ? undefined : curatedModelsOf(provider, settings),
      remoteOverridesCatalog:
        subscription?.source === "plugin" || subscription?.source === "custom",
    })
    return {
      model: snapshot.models.find((model) => model.id === retrieved.id) ?? null,
      source: "remote-discovered",
      freshness: "fresh",
    }
  }
  const listed = await listProviderModels({
    provider,
    settings,
    subscription: input.subscription,
    deploymentRef: input.deploymentRef,
    signal,
    persistence: input.persistence,
  })
  const model = listed.models.find((candidate) => candidate.id === modelId) ?? null
  return { model, source: listed.source, freshness: listed.freshness }
}

export const modelsGetHandler: ProviderOperationHandlerRegistration<
  ModelsGetInput,
  ModelsGetOutput
> = {
  operationId: "models.get",
  providerMatch: { kind: "any" },
  support: "derived",
  handler: ({ provider, settings, request, signal }) =>
    getProviderModel({
      provider,
      settings,
      model: request.input.model,
      deploymentRef: request.deploymentRef,
      signal,
    }),
}

export const DISCOVERY_HANDLERS: ProviderOperationHandlerRegistration[] = [
  ...[...REMOTE_LISTERS_BY_PROVIDER.keys()].map((providerId) =>
    modelsListHandler({ kind: "provider", providerId }, "native")
  ),
  ...[...REMOTE_LISTERS_BY_PROTOCOL.keys()].map((protocol) =>
    modelsListHandler({ kind: "protocol", protocol }, "native")
  ),
  modelsListHandler({ kind: "any" }, "derived"),
  modelsGetHandler,
] as ProviderOperationHandlerRegistration[]
