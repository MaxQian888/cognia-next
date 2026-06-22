import {
  getBuiltInProviderCatalogEntry,
  getBuiltInProviderCodingPackage,
  type BuiltInProviderModelEntry,
  type BuiltInProviderCategory,
  type BuiltInProviderCodingPackage,
} from "@cognia/provider-types/built-in-provider-catalog"
import {
  getAllProviders,
  type ApiProtocol,
  type ModelConfig,
  type ProviderMetadata,
  type ProviderVerificationStatus,
  type UserProviderSettings,
} from "@cognia/provider-types"
import type {
  ProviderNextAction,
  ProviderReadinessState,
  ProviderSetupChecklist,
} from "./completeness"
import {
  evaluateBuiltInProviderCompleteness,
  evaluateCustomProviderCompleteness,
} from "./completeness"
import {
  buildBuiltInProviderModelDiscoverySnapshot,
  buildCustomProviderModelDiscoverySnapshot,
  modelConfigToProviderModelCandidate,
} from "./model-discovery"
import { getProviderIconPath } from "./provider-icons"

export type ProviderProjectionKind = "built-in" | "local" | "custom"
export type ProviderProjectionCategory = BuiltInProviderCategory | "custom" | undefined

export interface CustomProviderProjectionInput {
  providerId?: string
  isCustom?: true
  customName?: string
  customModels?: string[]
  customModelMetadata?: Record<
    string,
    {
      id?: string
      name?: string
      contextLength?: number
      maxOutputTokens?: number
      pricing?: {
        promptPer1M?: number
        completionPer1M?: number
      }
      capabilities?: {
        vision?: boolean
        functionCalling?: boolean
        streaming?: boolean
      }
    }
  >
  apiProtocol?: ApiProtocol
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  enabled?: boolean
  verificationStatus?: ProviderVerificationStatus
  verificationFingerprint?: string
}

export interface ProviderStateProjection {
  id: string
  kind: ProviderProjectionKind
  category: ProviderProjectionCategory
  displayName: string
  description: string
  icon?: string
  website?: string
  metadata: ProviderMetadata
  /** All available models (static + discovered + curated). */
  models: ModelConfig[]
  modelIds: string[]
  /** User-selected subset of models. Empty/same as models when no whitelist is set. */
  enabledModels: ModelConfig[]
  enabledModelIds: string[]
  defaultModelId: string
  defaultModel?: ModelConfig
  readiness: ProviderReadinessState
  verificationStatus: ProviderVerificationStatus
  nextAction?: ProviderNextAction
  recommendedRemediation?: string
  selectable: boolean
  blockedReason?: string
  codingPackage?: BuiltInProviderCodingPackage
  enabled: boolean
  hasCredential: boolean
  hasBaseUrl: boolean
  setupChecklist: ProviderSetupChecklist
  isCustom: boolean
  settings: Partial<UserProviderSettings> | CustomProviderProjectionInput
}

export interface BuildProviderStateProjectionInput {
  providerSettings: Record<string, Partial<UserProviderSettings> | undefined>
  customProviders?: Record<string, CustomProviderProjectionInput | undefined>
  builtInTestResults?: Record<string, { success?: boolean } | null | undefined>
  customTestResults?: Record<
    string,
    { success?: boolean } | "success" | "error" | "limited" | null | undefined
  >
}

function deriveMetadataFromModels(
  id: string,
  displayName: string,
  description: string,
  website: string | undefined,
  requiresApiKey: boolean,
  models: ModelConfig[],
  icon?: string,
  pricingUrl?: string
): ProviderMetadata {
  return {
    id,
    name: displayName,
    description,
    website,
    requiresApiKey,
    supportsStreaming: models.some((model) => model.supportsStreaming) || false,
    supportsVision: models.some((model) => model.supportsVision) || false,
    supportsTools: models.some((model) => model.supportsTools) || false,
    maxTokens:
      models.reduce((max, model) => Math.max(max, model.contextLength || 0), 0) || undefined,
    pricingUrl,
    icon,
  }
}

function convertCatalogModelToModelConfig(model: BuiltInProviderModelEntry): ModelConfig {
  return {
    id: model.id,
    name: model.name,
    contextLength: model.contextLength,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio,
    supportsVideo: model.supportsVideo,
    supportsStreaming: model.supportsStreaming,
    supportsReasoning: model.supportsReasoning,
    supportsImageGeneration: model.supportsImageGeneration,
    supportsEmbedding: model.supportsEmbedding,
    pricing: model.pricing
      ? {
          promptPer1M: model.pricing.promptPer1M,
          completionPer1M: model.pricing.completionPer1M,
          cachedInputPer1M: model.pricing.cachedInputPer1M,
          cacheCreationPer1M: model.pricing.cacheCreationPer1M,
          batchInputPer1M: model.pricing.batchInputPer1M,
          batchOutputPer1M: model.pricing.batchOutputPer1M,
          audioInputPer1M: model.pricing.audioInputPer1M,
          audioOutputPer1M: model.pricing.audioOutputPer1M,
          currency: model.pricing.currency,
        }
      : undefined,
  }
}

function getBuiltInModels(
  providerId: string,
  settings: Partial<UserProviderSettings> | undefined
): ModelConfig[] {
  const providerConfig = getAllProviders()[providerId]
  const catalogEntry = getBuiltInProviderCatalogEntry(providerId)
  const catalogModels = providerConfig?.models?.length
    ? providerConfig.models.map((model) => modelConfigToProviderModelCandidate(model))
    : catalogEntry?.models
        ?.map(convertCatalogModelToModelConfig)
        .map((model) => modelConfigToProviderModelCandidate(model)) || []

  return buildBuiltInProviderModelDiscoverySnapshot({
    providerId,
    catalogModels,
    settings,
  }).models
}

function getCustomModels(
  providerId: string,
  provider: CustomProviderProjectionInput | undefined
): ModelConfig[] {
  return buildCustomProviderModelDiscoverySnapshot({
    providerId,
    provider,
  }).models
}

function resolveEnabledModels(
  models: ModelConfig[],
  enabledModelIds: string[] | undefined
): ModelConfig[] {
  if (!enabledModelIds || enabledModelIds.length === 0) return models
  const enabledSet = new Set(enabledModelIds)
  const filtered = models.filter((m) => enabledSet.has(m.id))
  return filtered.length > 0 ? filtered : models
}

function resolveDefaultModelId(
  models: ModelConfig[],
  candidates: Array<string | undefined>
): string {
  const availableIds = new Set(models.map((model) => model.id))

  for (const candidate of candidates) {
    if (candidate && availableIds.has(candidate)) {
      return candidate
    }
  }

  return (
    models[0]?.id || candidates.find((candidate): candidate is string => Boolean(candidate)) || ""
  )
}

function toCustomLatestTestResult(
  latestTestResult: { success?: boolean } | "success" | "error" | "limited" | null | undefined
): { success?: boolean } | null {
  if (latestTestResult === "success") return { success: true }
  if (latestTestResult === "error" || latestTestResult === "limited") return { success: false }
  if (latestTestResult && typeof latestTestResult === "object") {
    return latestTestResult
  }
  return null
}

function getProjectionRemediation(params: {
  blockedReason?: string
  checklist: ProviderSetupChecklist
}): string | undefined {
  if (params.blockedReason) return params.blockedReason
  return params.checklist.steps.find((step) => !step.done)?.reason
}

function buildBuiltInProviderProjection(
  providerId: string,
  settings: Partial<UserProviderSettings> | undefined,
  latestTestResult?: { success?: boolean } | null
): ProviderStateProjection {
  const providerConfig = getAllProviders()[providerId]
  const catalogEntry = getBuiltInProviderCatalogEntry(providerId)
  const models = getBuiltInModels(providerId, settings)
  const enabledModels = resolveEnabledModels(models, settings?.enabledModels)
  const completeness = evaluateBuiltInProviderCompleteness(providerId, settings, latestTestResult)
  const displayName = catalogEntry?.name || providerConfig?.name || providerId
  const description =
    catalogEntry?.description || providerConfig?.description || "Built-in provider"
  const defaultModelId = resolveDefaultModelId(models, [
    settings?.defaultModel,
    providerConfig?.defaultModel,
    catalogEntry?.defaultModel,
  ])
  const metadata = deriveMetadataFromModels(
    providerId,
    displayName,
    description,
    catalogEntry?.website || providerConfig?.website,
    catalogEntry?.apiKeyRequired ?? providerConfig?.apiKeyRequired ?? true,
    models,
    getProviderIconPath(providerId),
    catalogEntry?.pricingUrl
  )
  const kind: ProviderProjectionKind =
    providerConfig?.type === "local" || catalogEntry?.type === "local" ? "local" : "built-in"
  const category = (() => {
    const rawCategory = catalogEntry?.category || providerConfig?.category
    return rawCategory === "enterprise" ? "specialized" : rawCategory
  })()
  const blockedReason = completeness.eligibility.runtime.allowed
    ? undefined
    : completeness.eligibility.runtime.reason

  return {
    id: providerId,
    kind,
    category,
    displayName,
    description,
    icon: metadata.icon,
    website: metadata.website,
    metadata,
    models,
    modelIds: models.map((model) => model.id),
    enabledModels,
    enabledModelIds: enabledModels.map((model) => model.id),
    defaultModelId,
    defaultModel: models.find((model) => model.id === defaultModelId),
    readiness: completeness.readiness,
    verificationStatus: completeness.verificationStatus,
    nextAction:
      completeness.eligibility.runtime.nextAction || completeness.setupChecklist.nextAction,
    recommendedRemediation: getProjectionRemediation({
      blockedReason,
      checklist: completeness.setupChecklist,
    }),
    selectable: completeness.eligibility.runtime.allowed,
    blockedReason,
    codingPackage: getBuiltInProviderCodingPackage(providerId),
    enabled: settings?.enabled !== false,
    hasCredential: completeness.hasCredential,
    hasBaseUrl: completeness.hasBaseUrl,
    setupChecklist: completeness.setupChecklist,
    isCustom: false,
    settings: settings || {},
  }
}

function buildCustomProviderProjection(
  providerId: string,
  provider: CustomProviderProjectionInput | undefined,
  latestTestResult?: { success?: boolean } | null
): ProviderStateProjection {
  const models = getCustomModels(providerId, provider)
  const enabledModels = resolveEnabledModels(
    models,
    (provider as { enabledModels?: string[] })?.enabledModels
  )
  const completeness = evaluateCustomProviderCompleteness(
    {
      apiKey: provider?.apiKey,
      baseURL: provider?.baseURL,
      defaultModel: provider?.defaultModel,
      enabled: provider?.enabled,
      verificationStatus: provider?.verificationStatus,
      verificationFingerprint: provider?.verificationFingerprint,
    },
    latestTestResult
  )
  const displayName = provider?.customName || providerId
  const description = provider?.apiProtocol
    ? `Custom ${provider.apiProtocol}-compatible provider`
    : "Custom provider"
  const metadata = deriveMetadataFromModels(
    providerId,
    displayName,
    description,
    undefined,
    true,
    models,
    undefined
  )
  const defaultModelId = resolveDefaultModelId(models, [provider?.defaultModel])
  const blockedReason = completeness.eligibility.runtime.allowed
    ? undefined
    : completeness.eligibility.runtime.reason

  return {
    id: providerId,
    kind: "custom",
    category: "custom",
    displayName,
    description,
    icon: metadata.icon,
    website: metadata.website,
    metadata,
    models,
    modelIds: models.map((model) => model.id),
    enabledModels,
    enabledModelIds: enabledModels.map((model) => model.id),
    defaultModelId,
    defaultModel: models.find((model) => model.id === defaultModelId),
    readiness: completeness.readiness,
    verificationStatus: completeness.verificationStatus,
    nextAction:
      completeness.eligibility.runtime.nextAction || completeness.setupChecklist.nextAction,
    recommendedRemediation: getProjectionRemediation({
      blockedReason,
      checklist: completeness.setupChecklist,
    }),
    selectable: completeness.eligibility.runtime.allowed,
    blockedReason,
    enabled: provider?.enabled !== false,
    hasCredential: completeness.hasCredential,
    hasBaseUrl: completeness.hasBaseUrl,
    setupChecklist: completeness.setupChecklist,
    isCustom: true,
    settings: provider || {},
  }
}

export function buildProviderStateProjections(
  input: BuildProviderStateProjectionInput
): ProviderStateProjection[] {
  const builtInProjections = Object.entries(input.providerSettings).map(([providerId, settings]) =>
    buildBuiltInProviderProjection(
      providerId,
      settings,
      input.builtInTestResults?.[providerId] || null
    )
  )

  const customProjections = Object.entries(input.customProviders || {}).map(
    ([providerId, provider]) =>
      buildCustomProviderProjection(
        providerId,
        provider,
        toCustomLatestTestResult(input.customTestResults?.[providerId])
      )
  )

  return [...builtInProjections, ...customProjections]
}

export function buildProviderStateProjectionMap(
  input: BuildProviderStateProjectionInput
): Record<string, ProviderStateProjection> {
  return Object.fromEntries(
    buildProviderStateProjections(input).map((projection) => [projection.id, projection])
  )
}

export function getProviderSelectionGuidance(
  projections: ProviderStateProjection[]
): string | undefined {
  return projections.find((projection) => !projection.selectable)?.recommendedRemediation
}
