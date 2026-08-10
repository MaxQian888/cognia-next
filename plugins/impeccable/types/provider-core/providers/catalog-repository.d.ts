import {
  CatalogTier,
  CatalogModality,
  ProviderDefinition,
  ModelLifecycle,
  ModelCapability,
  ModelDefinition,
  ProviderOffering,
  CatalogSnapshot,
  CatalogContribution,
} from "@cognia/provider-types/model-catalog"

interface CatalogProviderFilter {
  tiers?: readonly CatalogTier[]
  modalities?: readonly CatalogModality[]
}
interface CatalogSearchQuery {
  query?: string
  providerIds?: readonly string[]
  tiers?: readonly CatalogTier[]
  lifecycle?: readonly ModelLifecycle[]
  modalities?: readonly CatalogModality[]
  capabilities?: readonly ModelCapability[]
  limit?: number
}
interface CatalogSearchResult {
  model: ModelDefinition
  offerings: ProviderOffering[]
}
interface ResolvedCatalogAlias {
  aliasId: string
  offering: ProviderOffering
  replacementRef?: string
}
interface CatalogRevisionState {
  active?: string
  previous?: string
  staged: string[]
}
interface CatalogRepository {
  listProviders(filter?: CatalogProviderFilter): ProviderDefinition[]
  searchModels(query?: CatalogSearchQuery): CatalogSearchResult[]
  getModel(modelId: string): ModelDefinition | undefined
  listOfferings(modelRef?: string): ProviderOffering[]
  resolveAlias(aliasId: string): ResolvedCatalogAlias | undefined
  resolveOffering(providerId: string, upstreamOrAliasId: string): ProviderOffering | undefined
  stageRevision(snapshot: CatalogSnapshot): Promise<void>
  activateRevision(revisionId: string): Promise<void>
  registerContribution(namespace: string, contribution: CatalogContribution): () => void
}
/**
 * In-memory read model for chat and settings hot paths.
 *
 * Persistence adapters can feed validated snapshots into the same repository;
 * lookups never fetch or scan a remote catalog.
 */
declare class InMemoryCatalogRepository implements CatalogRepository {
  private active?
  private baseActive?
  private previous?
  private readonly staged
  private readonly contributions
  constructor(initialSnapshot?: CatalogSnapshot)
  listProviders(filter?: CatalogProviderFilter): ProviderDefinition[]
  searchModels(query?: CatalogSearchQuery): CatalogSearchResult[]
  getModel(modelId: string): ModelDefinition | undefined
  listOfferings(modelRef?: string): ProviderOffering[]
  resolveAlias(aliasId: string): ResolvedCatalogAlias | undefined
  resolveOffering(providerId: string, upstreamOrAliasId: string): ProviderOffering | undefined
  stageRevision(snapshot: CatalogSnapshot): Promise<void>
  activateRevision(revisionId: string): Promise<void>
  registerContribution(namespace: string, contribution: CatalogContribution): () => void
  private rebuildActive
  getRevisionState(): CatalogRevisionState
}

export {
  type CatalogProviderFilter,
  type CatalogRepository,
  type CatalogRevisionState,
  type CatalogSearchQuery,
  type CatalogSearchResult,
  InMemoryCatalogRepository,
  type ResolvedCatalogAlias,
}
