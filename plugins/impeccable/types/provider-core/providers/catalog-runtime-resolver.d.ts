import {
  ProviderProfile,
  DeploymentProfile,
  TransportProfile,
  ModelCapability,
  ProviderDefinition,
  ModelDefinition,
  ProviderOffering,
  DeploymentModel,
  AdapterFamily,
} from "@cognia/provider-types"
import { CatalogRepository } from "./catalog-repository.js"
import "@cognia/provider-types/model-catalog"

type CatalogResolutionPurpose = "new" | "historical" | "auto"
type CatalogResolutionErrorCode =
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
declare class CatalogResolutionError extends Error {
  readonly code: CatalogResolutionErrorCode
  constructor(code: CatalogResolutionErrorCode, message: string)
}
interface CatalogRuntimeResolutionInput {
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
interface ResolvedCatalogRuntimeTarget {
  provider: ProviderDefinition
  deployment: DeploymentProfile
  transport: TransportProfile
  deploymentModel: DeploymentModel
  model: ModelDefinition
  offering: ProviderOffering
  adapterFamily: AdapterFamily
  upstreamId: string
}
/**
 * Resolve a configured connection to one immutable provider offering.
 *
 * This function is intentionally synchronous: the repository is an in-memory
 * read model, so sending a request never refreshes the catalog or scans a
 * remote source.
 */
declare function resolveCatalogRuntimeTarget(
  input: CatalogRuntimeResolutionInput
): ResolvedCatalogRuntimeTarget

export {
  CatalogResolutionError,
  type CatalogResolutionErrorCode,
  type CatalogResolutionPurpose,
  type CatalogRuntimeResolutionInput,
  type ResolvedCatalogRuntimeTarget,
  resolveCatalogRuntimeTarget,
}
