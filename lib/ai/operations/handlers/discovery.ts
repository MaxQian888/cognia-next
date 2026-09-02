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

import type { ProviderModelCandidate } from "@cognia/provider-types"
import { getBuiltInProviderCatalogEntry } from "@cognia/provider-types/built-in-provider-catalog"
import { LOCAL_PROVIDER_NAMES, type LocalProviderName } from "@cognia/provider-types/local-provider"
import { builtInProviderSurfaceFacts } from "@cognia/provider-core/operations/capability-matrix"
import {
  buildProviderModelDiscoverySnapshot,
  discoverCLIProxyAPIModels,
  discoverLocalProviderModels,
  discoverOpenAICompatibleModels,
  discoverOpenRouterModels,
  type DiscoveredProviderModel,
} from "@cognia/provider-core/providers/model-discovery"
import { getCatalogModelsForProvider } from "@cognia/provider-core/providers/models-dev-sync"
import { discoverBedrockModelsViaSidecar } from "@/lib/claude/feature-call"
import type { ProviderSettingsSnapshot, ResolvedProvider } from "@/lib/ai/provider-consumption"

import { credentialAffinityOf } from "../credential-affinity"
import { ProviderOperationFailureError } from "../failure"
import { providerOperationPersistence, type ProviderOperationPersistence } from "../persistence"
import type {
  ProviderOperationHandlerRegistration,
  ProviderOperationProviderMatch,
} from "../registry"
import { providerRequest } from "./http"

export interface ModelsListInput {
  /**
   * `true` forces a live vendor listing, `false` answers from the catalog
   * alone, and absent uses the stored listing of this deployment × account
   * while it is fresh.
   */
  remote?: boolean
}

export interface ModelsListOutput {
  models: DiscoveredProviderModel[]
  /** Where the vendor layer came from: a live call, the stored listing, or nothing. */
  source: "remote" | "cached" | "catalog"
  remoteLastFetchedAt?: number
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

interface AnthropicModelsWire {
  data?: Array<{ id: string; display_name?: string }>
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
  const { json } = await providerRequest<AnthropicModelsWire>(provider, { path: "models", signal })
  return (json.data ?? []).map((model) => ({
    id: model.id,
    name: model.display_name ?? model.id,
    supportsTools: true,
    supportsStreaming: true,
  }))
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
      maxOutputTokens: model.outputTokenLimit,
      supportsTools: true,
      supportsStreaming: true,
    }))
}

const openAiCompatibleLister: RemoteLister = (provider) =>
  discoverOpenAICompatibleModels({ baseURL: requireBaseURL(provider), apiKey: provider.apiKey })

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

function remoteListerFor(provider: ResolvedProvider): RemoteLister | undefined {
  const entry = getBuiltInProviderCatalogEntry(provider.providerId)
  if (entry && !builtInProviderSurfaceFacts(entry).modelsEndpoint) return undefined
  return (
    REMOTE_LISTERS_BY_PROVIDER.get(provider.providerId) ??
    REMOTE_LISTERS_BY_PROTOCOL.get(provider.protocol)
  )
}

function catalogModelsOf(providerId: string): ProviderModelCandidate[] | undefined {
  return getBuiltInProviderCatalogEntry(providerId)?.models?.map((model) => ({ ...model }))
}

function curatedModelsOf(
  provider: ResolvedProvider,
  settings: ProviderSettingsSnapshot
): ProviderModelCandidate[] | undefined {
  if (!provider.isCustomProvider) return undefined
  const definition = settings.customProviders.find((custom) => custom.id === provider.providerId)
  return definition?.models?.map((model) => ({
    id: model.id,
    name: model.name,
    contextLength: model.contextLength,
  }))
}

export async function listProviderModels(input: {
  provider: ResolvedProvider
  settings: ProviderSettingsSnapshot
  deploymentRef?: string
  remote?: boolean
  signal?: AbortSignal
  now?: number
  persistence?: ProviderOperationPersistence
}): Promise<ModelsListOutput> {
  const { provider, settings } = input
  const persistence = input.persistence ?? providerOperationPersistence
  const now = input.now ?? Date.now()
  const deploymentRef = input.deploymentRef ?? provider.providerId
  const accountRef = credentialAffinityOf(provider.apiKey)
  const lister = input.remote === false ? undefined : remoteListerFor(provider)

  let remoteModels: ProviderModelCandidate[] | undefined
  let source: ModelsListOutput["source"] = "catalog"
  let remoteLastFetchedAt: number | undefined
  if (lister && input.remote === undefined) {
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
      source = "cached"
    }
  }
  if (lister && !remoteModels) {
    try {
      remoteModels = await lister(provider, input.signal)
    } catch (error) {
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
    source = "remote"
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
  const snapshot = buildProviderModelDiscoverySnapshot({
    providerId: provider.providerId,
    catalogModels: catalogModelsOf(provider.providerId),
    modelsDevModels: getCatalogModelsForProvider(provider.providerId),
    remoteModels,
    remoteLastFetchedAt,
    userCuratedModels: curatedModelsOf(provider, settings),
  })
  return {
    models: snapshot.models,
    source,
    ...(remoteLastFetchedAt !== undefined ? { remoteLastFetchedAt } : {}),
  }
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
        remote: request.input?.remote,
        signal,
      }),
  }
}

export interface ModelsGetInput {
  model: string
  remote?: boolean
}

export interface ModelsGetOutput {
  model: DiscoveredProviderModel
  source: ModelsListOutput["source"]
}

export const modelsGetHandler: ProviderOperationHandlerRegistration<
  ModelsGetInput,
  ModelsGetOutput
> = {
  operationId: "models.get",
  providerMatch: { kind: "any" },
  support: "derived",
  async handler({ provider, settings, request, signal }) {
    const listed = await listProviderModels({
      provider,
      settings,
      deploymentRef: request.deploymentRef,
      remote: request.input.remote,
      signal,
    })
    const model = listed.models.find((candidate) => candidate.id === request.input.model)
    if (!model) {
      throw new ProviderOperationFailureError({
        code: "model-unavailable",
        retryable: false,
        message: `${provider.providerId} lists no model "${request.input.model}"`,
      })
    }
    return { model, source: listed.source }
  },
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
