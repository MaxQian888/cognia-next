import type {
  AdapterFamily,
  DeploymentModel,
  DeploymentProfile,
  ModelCapability,
  ModelDefinition,
  ProviderDefinition,
  ProviderOffering,
  ProviderProfile,
  TransportProfile,
} from "@cognia/provider-types"

import type { CatalogRepository } from "./catalog-repository"

export type CatalogResolutionPurpose = "new" | "historical" | "auto"

export type CatalogResolutionErrorCode =
  | "deployment_not_owned"
  | "deployment_disabled"
  | "transport_mismatch"
  | "model_not_configured"
  | "offering_not_found"
  | "provider_not_found"
  | "offering_unavailable"
  | "lifecycle_not_allowed"
  | "tier_not_allowed"
  | "experimental_confirmation_required"
  | "capability_unavailable"
  | "data_policy_rejected"
  | "adapter_not_allowed"
  | "unsafe_catalog_endpoint"

export class CatalogResolutionError extends Error {
  constructor(
    readonly code: CatalogResolutionErrorCode,
    message: string
  ) {
    super(message)
    this.name = "CatalogResolutionError"
  }
}

export interface CatalogRuntimeResolutionInput {
  providerProfile: ProviderProfile
  deployment: DeploymentProfile
  transport: TransportProfile
  modelId: string
  purpose: CatalogResolutionPurpose
  repository: CatalogRepository
  requiredCapabilities?: readonly ModelCapability[]
  allowVerifiedAuto?: boolean
  experimentalConfirmed?: boolean
  endpointSource?: "user" | "bundled" | "remote-catalog"
  dataPolicyAllows?: (context: {
    provider: ProviderDefinition
    model: ModelDefinition
    offering: ProviderOffering
  }) => boolean
}

export interface ResolvedCatalogRuntimeTarget {
  provider: ProviderDefinition
  deployment: DeploymentProfile
  transport: TransportProfile
  deploymentModel: DeploymentModel
  model: ModelDefinition
  offering: ProviderOffering
  adapterFamily: AdapterFamily
  upstreamId: string
}

const PROTOCOL_ADAPTER_PREFERENCE: Readonly<Record<string, readonly AdapterFamily[]>> = {
  openai: ["openai-compatible", "azure-openai", "openrouter", "local-openai-compatible"],
  "openai-compatible": [
    "openai-compatible",
    "azure-openai",
    "openrouter",
    "local-openai-compatible",
  ],
  anthropic: ["anthropic"],
  gemini: ["gemini", "vertex-ai"],
  bedrock: ["bedrock"],
}

function resolveAdapterFamily(
  provider: ProviderDefinition,
  transport: TransportProfile
): AdapterFamily {
  const preferences = PROTOCOL_ADAPTER_PREFERENCE[transport.protocol.toLocaleLowerCase()] ?? []
  const matched = preferences.find((family) => provider.adapterFamilies.includes(family))
  if (matched) return matched
  if (provider.adapterFamilies.length === 1) return provider.adapterFamilies[0]
  throw new CatalogResolutionError(
    "adapter_not_allowed",
    `transport "${transport.protocol}" does not match an allowed adapter for provider "${provider.id}"`
  )
}

function isPrivateOrLinkLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true
  }
  if (
    normalized.startsWith("10.") ||
    normalized.startsWith("127.") ||
    normalized.startsWith("192.168.") ||
    normalized.startsWith("169.254.") ||
    normalized.startsWith("fe80:")
  ) {
    return true
  }
  const [first, second] = normalized.split(".").map(Number)
  return first === 172 && Number.isFinite(second) && second >= 16 && second <= 31
}

function assertSafeEndpoint(deployment: DeploymentProfile, source: string): void {
  if (source !== "remote-catalog") return
  let endpoint: URL
  try {
    endpoint = new URL(deployment.endpoint)
  } catch {
    throw new CatalogResolutionError(
      "unsafe_catalog_endpoint",
      `remote catalog endpoint for deployment "${deployment.id}" is invalid`
    )
  }
  if (isPrivateOrLinkLocalHostname(endpoint.hostname)) {
    throw new CatalogResolutionError(
      "unsafe_catalog_endpoint",
      `remote catalog endpoint for deployment "${deployment.id}" is private or link-local`
    )
  }
}

function findDeploymentModel(
  deployment: DeploymentProfile,
  modelId: string
): DeploymentModel | undefined {
  return deployment.models.find(
    (model) =>
      model.id === modelId ||
      model.upstreamId === modelId ||
      model.offeringRef === modelId ||
      model.canonicalModelRef === modelId
  )
}

function findOffering(
  repository: CatalogRepository,
  deployment: DeploymentProfile,
  configuredModel: DeploymentModel
): ProviderOffering | undefined {
  for (const candidate of [
    configuredModel.offeringRef,
    configuredModel.upstreamId,
    configuredModel.id,
  ]) {
    if (!candidate) continue
    const offering = repository.resolveOffering(deployment.providerRef, candidate)
    if (offering) return offering
  }
  if (!configuredModel.canonicalModelRef) return undefined
  return repository
    .listOfferings(configuredModel.canonicalModelRef)
    .find(
      (offering) =>
        offering.providerRef === deployment.providerRef &&
        (!offering.deploymentRef || offering.deploymentRef === deployment.id)
    )
}

function assertTierAllowed(
  provider: ProviderDefinition,
  input: CatalogRuntimeResolutionInput
): void {
  if (input.purpose === "auto") {
    if (provider.tier === "certified") return
    if (provider.tier === "verified" && input.allowVerifiedAuto) return
    throw new CatalogResolutionError(
      "tier_not_allowed",
      `provider tier "${provider.tier}" is not eligible for automatic routing`
    )
  }
  if (provider.tier === "experimental" && input.purpose === "new" && !input.experimentalConfirmed) {
    throw new CatalogResolutionError(
      "experimental_confirmation_required",
      `provider "${provider.id}" requires explicit Experimental confirmation`
    )
  }
}

function capabilityEnabled(
  capability: ModelCapability,
  configuredModel: DeploymentModel,
  offering: ProviderOffering,
  model: ModelDefinition
): boolean {
  return (
    configuredModel.userOverride?.capabilities?.[capability] ??
    offering.capabilities?.[capability] ??
    model.capabilities[capability] ??
    false
  )
}

/**
 * Resolve a configured connection to one immutable provider offering.
 *
 * This function is intentionally synchronous: the repository is an in-memory
 * read model, so sending a request never refreshes the catalog or scans a
 * remote source.
 */
export function resolveCatalogRuntimeTarget(
  input: CatalogRuntimeResolutionInput
): ResolvedCatalogRuntimeTarget {
  const { deployment, providerProfile, repository, transport } = input
  if (!providerProfile.deploymentRefs.includes(deployment.id)) {
    throw new CatalogResolutionError(
      "deployment_not_owned",
      `deployment "${deployment.id}" is not owned by provider profile "${providerProfile.id}"`
    )
  }
  if (deployment.enabled === false) {
    throw new CatalogResolutionError(
      "deployment_disabled",
      `deployment "${deployment.id}" is disabled`
    )
  }
  if (deployment.transportProfileRef !== transport.id) {
    throw new CatalogResolutionError(
      "transport_mismatch",
      `deployment "${deployment.id}" does not reference transport "${transport.id}"`
    )
  }
  assertSafeEndpoint(deployment, input.endpointSource ?? "user")

  const configuredModel = findDeploymentModel(deployment, input.modelId)
  if (!configuredModel || configuredModel.userOverride?.enabled === false) {
    throw new CatalogResolutionError(
      "model_not_configured",
      `model "${input.modelId}" is not enabled for deployment "${deployment.id}"`
    )
  }
  const offering = findOffering(repository, deployment, configuredModel)
  if (!offering) {
    throw new CatalogResolutionError(
      "offering_not_found",
      `no catalog offering resolves model "${input.modelId}" for provider "${deployment.providerRef}"`
    )
  }
  if (!offering.available && input.purpose !== "historical") {
    throw new CatalogResolutionError(
      "offering_unavailable",
      `offering "${offering.id}" is not currently available`
    )
  }

  const provider = repository
    .listProviders()
    .find((candidate) => candidate.id === offering.providerRef)
  if (!provider) {
    throw new CatalogResolutionError(
      "provider_not_found",
      `catalog provider "${offering.providerRef}" is missing`
    )
  }
  const model = repository.getModel(offering.modelRef)
  if (!model) {
    throw new CatalogResolutionError(
      "offering_not_found",
      `offering "${offering.id}" references a missing model`
    )
  }
  if (
    input.purpose !== "historical" &&
    (model.lifecycle === "deprecated" ||
      model.lifecycle === "retired" ||
      offering.lifecycle === "deprecated" ||
      offering.lifecycle === "retired")
  ) {
    throw new CatalogResolutionError(
      "lifecycle_not_allowed",
      `offering "${offering.id}" is not eligible for a new selection`
    )
  }
  assertTierAllowed(provider, input)

  for (const capability of input.requiredCapabilities ?? []) {
    if (!capabilityEnabled(capability, configuredModel, offering, model)) {
      throw new CatalogResolutionError(
        "capability_unavailable",
        `required capability "${capability}" is unavailable for offering "${offering.id}"`
      )
    }
  }
  if (input.dataPolicyAllows && !input.dataPolicyAllows({ provider, model, offering })) {
    throw new CatalogResolutionError(
      "data_policy_rejected",
      `data policy rejected offering "${offering.id}"`
    )
  }

  return {
    provider,
    deployment,
    transport,
    deploymentModel: configuredModel,
    model,
    offering,
    adapterFamily: resolveAdapterFamily(provider, transport),
    upstreamId: offering.upstreamId,
  }
}
