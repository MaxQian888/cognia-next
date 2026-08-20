import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import type { ModelCapability } from "@cognia/provider-types/model-catalog"

import type { CatalogRepository, CatalogSearchResult } from "./catalog-repository"

export const ROUTING_CANDIDATE_SET_VERSION = "2026-07-31"

export type CatalogRoutingRole = "fast" | "balanced" | "powerful" | "reasoning" | "coding"

/**
 * Exported so a consumer can state which lane it means without re-declaring
 * the shape. Deliberately still contains no model ids: a role is a policy over
 * capabilities and an ordering, never a list.
 */
export interface RoutingCandidatePolicy {
  capabilities: ModelCapability[]
  order: "cost" | "quality"
  limit: number
}

/** Versioned hard-capability policies; intentionally contains no model ids. */
export const ROUTING_CANDIDATE_POLICIES: Record<CatalogRoutingRole, RoutingCandidatePolicy> = {
  fast: { capabilities: ["streaming"], order: "cost", limit: 8 },
  balanced: { capabilities: ["streaming"], order: "quality", limit: 8 },
  powerful: { capabilities: ["reasoning"], order: "quality", limit: 8 },
  reasoning: { capabilities: ["reasoning"], order: "quality", limit: 8 },
  coding: { capabilities: ["tools"], order: "quality", limit: 8 },
}

function estimatedCost(result: CatalogSearchResult): number {
  const prices = result.offerings
    .map((offering) => {
      const input = offering.pricing?.inputPer1M
      const output = offering.pricing?.outputPer1M
      return input === undefined && output === undefined
        ? Number.POSITIVE_INFINITY
        : (input ?? 0) + (output ?? 0)
    })
    .sort((left, right) => left - right)
  return prices[0] ?? Number.POSITIVE_INFINITY
}

function qualityScore(result: CatalogSearchResult): number {
  const context = result.model.limits?.context ?? 0
  const reasoning = result.model.capabilities.reasoning ? 1_000_000_000 : 0
  const tools = result.model.capabilities.tools ? 100_000_000 : 0
  return reasoning + tools + context
}

export function listRoutingCandidates(
  repository: CatalogRepository,
  role: CatalogRoutingRole,
  enabledDeploymentIds: ReadonlySet<string>
): ModelMappingEntry[] {
  const policy = ROUTING_CANDIDATE_POLICIES[role]
  const results = repository.searchModels({
    tiers: ["certified"],
    lifecycle: ["active"],
    modalities: ["language"],
    capabilities: policy.capabilities,
  })
  results.sort((left, right) =>
    policy.order === "cost"
      ? estimatedCost(left) - estimatedCost(right) || qualityScore(right) - qualityScore(left)
      : qualityScore(right) - qualityScore(left) || estimatedCost(left) - estimatedCost(right)
  )

  const candidates: ModelMappingEntry[] = []
  const seen = new Set<string>()
  for (const result of results) {
    for (const offering of result.offerings) {
      const providerId = offering.deploymentRef ?? offering.providerRef
      if (!enabledDeploymentIds.has(providerId)) continue
      const key = `${providerId}\0${offering.upstreamId}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ providerId, modelId: offering.upstreamId })
      if (candidates.length >= policy.limit) return candidates
    }
  }
  return candidates
}
