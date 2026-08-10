export { ProviderModelOptions, getProviderModel, isGenuineOpenAiEndpoint } from "./core/client.js"
export {
  CatalogProviderFilter,
  CatalogRepository,
  CatalogRevisionState,
  CatalogSearchQuery,
  CatalogSearchResult,
  InMemoryCatalogRepository,
  ResolvedCatalogAlias,
} from "./providers/catalog-repository.js"
export {
  CatalogResolutionError,
  CatalogResolutionErrorCode,
  CatalogResolutionPurpose,
  CatalogRuntimeResolutionInput,
  ResolvedCatalogRuntimeTarget,
  resolveCatalogRuntimeTarget,
} from "./providers/catalog-runtime-resolver.js"
export {
  BUNDLED_CERTIFIED_PROVIDER_IDS,
  CERTIFICATION_CANDIDATES,
  getBundledCatalogRepository,
} from "./providers/catalog-baseline.js"
export {
  ProviderDefinition,
  ProviderModelDefinition,
  ProviderProtocol,
  ProviderSource,
  ProviderType,
  __resetProviderRegistryForTesting,
  getDynamicProviders,
  getProviderDefinition,
  listProviderDefinitions,
  registerProviderDefinition,
  unregisterProvider,
  unregisterProvidersBySource,
} from "./providers/provider-loader.js"
export {
  CatalogRoutingRole,
  ROUTING_CANDIDATE_POLICIES,
  ROUTING_CANDIDATE_SET_VERSION,
  listRoutingCandidates,
} from "./providers/routing-candidates.js"
export { ProviderName } from "@cognia/provider-types"
import "ai"
import "@cognia/provider-types/model-catalog"
import "@cognia/provider-types/provider"
import "@cognia/provider-types/model-mapping"
