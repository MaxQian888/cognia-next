/**
 * Default mappings materialized from the active catalog's versioned
 * capability policies. This module intentionally contains no production model
 * ids.
 */

import { nanoid } from "nanoid"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"
import { getBundledCatalogRepository } from "@cognia/provider-core/providers/catalog-baseline"
import type { CatalogRepository } from "@cognia/provider-core/providers/catalog-repository"
import {
  listRoutingCandidates,
  ROUTING_CANDIDATE_POLICIES,
  type CatalogRoutingRole,
} from "@cognia/provider-core/providers/routing-candidates"

const TIER_NAMES: Record<CatalogRoutingRole, string> = {
  fast: "Fast",
  balanced: "Balanced",
  powerful: "Powerful",
  reasoning: "Reasoning",
  coding: "Coding",
}

let defaultCatalogRepository: CatalogRepository | undefined

export function setDefaultMappingCatalogRepository(repository: CatalogRepository): void {
  defaultCatalogRepository = repository
}

export function generateDefaultMappings(
  enabledProviderIds: string[] | Set<string>,
  repository: CatalogRepository | undefined = defaultCatalogRepository ??
    getBundledCatalogRepository()
): ModelMapping[] {
  const enabled =
    enabledProviderIds instanceof Set ? enabledProviderIds : new Set(enabledProviderIds)
  const now = Date.now()
  return (Object.keys(ROUTING_CANDIDATE_POLICIES) as CatalogRoutingRole[])
    .map((alias) => ({
      id: nanoid(),
      alias,
      providers: listRoutingCandidates(repository, alias, enabled),
      distribution: "priority" as const,
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    }))
    .filter((mapping) => mapping.providers.length > 0)
}

export function getTierDisplayName(alias: string): string {
  return TIER_NAMES[alias as CatalogRoutingRole] ?? alias
}

export function getDefaultTierAliases(): string[] {
  return Object.keys(ROUTING_CANDIDATE_POLICIES)
}
