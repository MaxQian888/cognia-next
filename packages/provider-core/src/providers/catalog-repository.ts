import {
  parseCatalogSnapshot,
  type CatalogModality,
  type CatalogContribution,
  type CatalogSnapshot,
  type CatalogTier,
  type ModelAlias,
  type ModelCapability,
  type ModelDefinition,
  type ModelLifecycle,
  type ProviderDefinition,
  type ProviderOffering,
} from "@cognia/provider-types/model-catalog"

export interface CatalogProviderFilter {
  tiers?: readonly CatalogTier[]
  modalities?: readonly CatalogModality[]
}

export interface CatalogSearchQuery {
  query?: string
  providerIds?: readonly string[]
  tiers?: readonly CatalogTier[]
  lifecycle?: readonly ModelLifecycle[]
  modalities?: readonly CatalogModality[]
  capabilities?: readonly ModelCapability[]
  limit?: number
}

export interface CatalogSearchResult {
  model: ModelDefinition
  offerings: ProviderOffering[]
}

export interface ResolvedCatalogAlias {
  aliasId: string
  offering: ProviderOffering
  replacementRef?: string
}

export interface CatalogRevisionState {
  active?: string
  previous?: string
  staged: string[]
}

export interface CatalogRepository {
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

interface CatalogIndex {
  snapshot: CatalogSnapshot
  providersById: Map<string, ProviderDefinition>
  modelsById: Map<string, ModelDefinition>
  offeringsById: Map<string, ProviderOffering>
  offeringsByModel: Map<string, ProviderOffering[]>
  offeringsByProviderAndUpstream: Map<string, ProviderOffering>
  aliasesById: Map<string, ModelAlias>
  searchableTextByModel: Map<string, string>
}

function buildIndex(snapshot: CatalogSnapshot): CatalogIndex {
  const providersById = new Map(snapshot.providers.map((provider) => [provider.id, provider]))
  const modelsById = new Map(snapshot.models.map((model) => [model.id, model]))
  const offeringsById = new Map(snapshot.offerings.map((offering) => [offering.id, offering]))
  const offeringsByModel = new Map<string, ProviderOffering[]>()
  const offeringsByProviderAndUpstream = new Map<string, ProviderOffering>()
  for (const offering of snapshot.offerings) {
    const existing = offeringsByModel.get(offering.modelRef)
    if (existing) existing.push(offering)
    else offeringsByModel.set(offering.modelRef, [offering])
    offeringsByProviderAndUpstream.set(
      `${offering.providerRef}\u0000${offering.upstreamId}`,
      offering
    )
  }
  const aliasesById = new Map(snapshot.aliases.map((alias) => [alias.id, alias]))
  const searchableTextByModel = new Map<string, string>()
  for (const model of snapshot.models) {
    const offeringTerms = (offeringsByModel.get(model.id) ?? []).flatMap((offering) => [
      offering.id,
      offering.upstreamId,
      providersById.get(offering.providerRef)?.name ?? "",
    ])
    const aliasTerms = snapshot.aliases
      .filter(
        (alias) =>
          (alias.target.type === "model" && alias.target.ref === model.id) ||
          (alias.target.type === "offering" &&
            (offeringsByModel.get(model.id) ?? []).some(
              (offering) => offering.id === alias.target.ref
            ))
      )
      .map((alias) => alias.id)
    searchableTextByModel.set(
      model.id,
      [model.id, model.name, model.creator, model.family ?? "", ...offeringTerms, ...aliasTerms]
        .join("\n")
        .toLocaleLowerCase()
    )
  }
  return {
    snapshot,
    providersById,
    modelsById,
    offeringsById,
    offeringsByModel,
    offeringsByProviderAndUpstream,
    aliasesById,
    searchableTextByModel,
  }
}

function supportsModality(model: ModelDefinition, modality: CatalogModality): boolean {
  switch (modality) {
    case "language":
      return model.modalities.output.includes("text")
    case "embedding":
      return model.capabilities.embeddings === true
    case "rerank":
      return model.capabilities.rerank === true
    case "image":
      return (
        model.modalities.input.includes("image") ||
        model.modalities.output.includes("image") ||
        model.capabilities.imageGeneration === true
      )
    case "speech":
      return (
        model.modalities.input.includes("audio") ||
        model.modalities.output.includes("audio") ||
        model.capabilities.speechGeneration === true
      )
  }
}

function resolvedCapability(
  model: ModelDefinition,
  offerings: readonly ProviderOffering[],
  capability: ModelCapability
): boolean {
  if (model.capabilities[capability] === true) return true
  return offerings.some((offering) => offering.capabilities?.[capability] === true)
}

/**
 * In-memory read model for chat and settings hot paths.
 *
 * Persistence adapters can feed validated snapshots into the same repository;
 * lookups never fetch or scan a remote catalog.
 */
export class InMemoryCatalogRepository implements CatalogRepository {
  private active?: CatalogIndex
  private baseActive?: CatalogIndex
  private previous?: CatalogIndex
  private readonly staged = new Map<string, CatalogIndex>()
  private readonly contributions = new Map<string, CatalogContribution>()

  constructor(initialSnapshot?: CatalogSnapshot) {
    if (!initialSnapshot) return
    const parsed = parseCatalogSnapshot(initialSnapshot)
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    this.active = buildIndex(parsed.value)
    this.baseActive = this.active
  }

  listProviders(filter: CatalogProviderFilter = {}): ProviderDefinition[] {
    if (!this.active) return []
    return this.active.snapshot.providers
      .filter(
        (provider) =>
          (!filter.tiers || filter.tiers.includes(provider.tier)) &&
          (!filter.modalities ||
            filter.modalities.some((modality) => provider.modalities.includes(modality)))
      )
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  searchModels(query: CatalogSearchQuery = {}): CatalogSearchResult[] {
    if (!this.active) return []
    const text = query.query?.trim().toLocaleLowerCase()
    const results: CatalogSearchResult[] = []
    for (const model of this.active.snapshot.models) {
      const offerings = (this.active.offeringsByModel.get(model.id) ?? []).filter(
        (offering) => offering.available
      )
      const eligibleOfferings = offerings.filter((offering) => {
        const provider = this.active?.providersById.get(offering.providerRef)
        return (
          provider !== undefined &&
          (!query.providerIds || query.providerIds.includes(provider.id)) &&
          (!query.tiers || query.tiers.includes(provider.tier)) &&
          (!query.lifecycle ||
            (query.lifecycle.includes(model.lifecycle) &&
              query.lifecycle.includes(offering.lifecycle)))
        )
      })
      if (eligibleOfferings.length === 0) continue
      if (text && !this.active.searchableTextByModel.get(model.id)?.includes(text)) continue
      if (query.modalities && !query.modalities.every((item) => supportsModality(model, item))) {
        continue
      }
      if (
        query.capabilities &&
        !query.capabilities.every((capability) =>
          resolvedCapability(model, eligibleOfferings, capability)
        )
      ) {
        continue
      }
      results.push({ model, offerings: eligibleOfferings })
      if (query.limit && results.length >= query.limit) break
    }
    return results.sort((left, right) => left.model.name.localeCompare(right.model.name))
  }

  getModel(modelId: string): ModelDefinition | undefined {
    return this.active?.modelsById.get(modelId)
  }

  listOfferings(modelRef?: string): ProviderOffering[] {
    if (!this.active) return []
    return modelRef
      ? [...(this.active.offeringsByModel.get(modelRef) ?? [])]
      : [...this.active.snapshot.offerings]
  }

  resolveAlias(aliasId: string): ResolvedCatalogAlias | undefined {
    if (!this.active) return undefined
    const original = this.active.aliasesById.get(aliasId)
    if (!original) return undefined
    let alias: ModelAlias | undefined = original
    const visited = new Set<string>()
    while (alias) {
      if (visited.has(alias.id)) return undefined
      visited.add(alias.id)
      if (alias.target.type === "alias") {
        alias = this.active.aliasesById.get(alias.target.ref)
        continue
      }
      const offering =
        alias.target.type === "offering"
          ? this.active.offeringsById.get(alias.target.ref)
          : this.active.offeringsByModel.get(alias.target.ref)?.find((item) => item.available)
      return offering
        ? {
            aliasId,
            offering,
            replacementRef: original.replacementRef,
          }
        : undefined
    }
    return undefined
  }

  resolveOffering(providerId: string, upstreamOrAliasId: string): ProviderOffering | undefined {
    const alias = this.resolveAlias(upstreamOrAliasId)?.offering
    if (alias?.providerRef === providerId) return alias
    const exact = this.active?.offeringsById.get(upstreamOrAliasId)
    if (exact?.providerRef === providerId) return exact
    return this.active?.offeringsByProviderAndUpstream.get(
      `${providerId}\u0000${upstreamOrAliasId}`
    )
  }

  async stageRevision(snapshot: CatalogSnapshot): Promise<void> {
    const parsed = parseCatalogSnapshot(snapshot)
    if (!parsed.ok || parsed.value.revision.integrity !== "verified") {
      const detail = parsed.ok ? "revision integrity is not verified" : parsed.errors.join("; ")
      throw new Error(`catalog revision "${snapshot.revision.id}" failed validation: ${detail}`)
    }
    this.staged.set(parsed.value.revision.id, buildIndex(parsed.value))
  }

  async activateRevision(revisionId: string): Promise<void> {
    const next = this.staged.get(revisionId)
    if (!next) throw new Error(`catalog revision "${revisionId}" is not staged`)
    this.previous = this.active
    this.baseActive = next
    this.rebuildActive()
    this.staged.delete(revisionId)
    this.staged.clear()
  }

  registerContribution(namespace: string, contribution: CatalogContribution): () => void {
    if (!this.baseActive) throw new Error("catalog has no active revision")
    const prefix = `${namespace}:`
    const invalidId = [
      ...contribution.providers.map((item) => item.id),
      ...contribution.offerings.map((item) => item.id),
      ...(contribution.aliases ?? []).map((item) => item.id),
    ].find((id) => !id.startsWith(prefix))
    if (invalidId) {
      throw new Error(`plugin catalog id "${invalidId}" must use namespace "${prefix}"`)
    }
    if (contribution.providers.some((provider) => provider.tier === "certified")) {
      throw new Error("plugin catalog contributions cannot declare certified providers")
    }
    const previous = this.contributions.get(namespace)
    this.contributions.set(namespace, contribution)
    try {
      this.rebuildActive()
    } catch (error) {
      if (previous) this.contributions.set(namespace, previous)
      else this.contributions.delete(namespace)
      this.rebuildActive()
      throw error
    }
    return () => {
      this.contributions.delete(namespace)
      this.rebuildActive()
    }
  }

  private rebuildActive(): void {
    if (!this.baseActive) {
      this.active = undefined
      return
    }
    const base = this.baseActive.snapshot
    const combined: CatalogSnapshot = {
      ...base,
      providers: [...base.providers],
      models: [...base.models],
      offerings: [...base.offerings],
      aliases: [...base.aliases],
    }
    for (const contribution of this.contributions.values()) {
      combined.providers.push(...contribution.providers)
      combined.models.push(...contribution.models)
      combined.offerings.push(...contribution.offerings)
      combined.aliases.push(...(contribution.aliases ?? []))
    }
    const parsed = parseCatalogSnapshot(combined)
    if (!parsed.ok) {
      throw new Error(`plugin catalog contribution failed validation: ${parsed.errors.join("; ")}`)
    }
    this.active = buildIndex(parsed.value)
  }

  getRevisionState(): CatalogRevisionState {
    return {
      active: this.active?.snapshot.revision.id,
      previous: this.previous?.snapshot.revision.id,
      staged: [...this.staged.keys()].sort(),
    }
  }
}
