import { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import { ModelCapability } from "@cognia/provider-types/model-catalog"
import { CatalogRepository } from "./catalog-repository.js"

declare const ROUTING_CANDIDATE_SET_VERSION = "2026-07-31"
type CatalogRoutingRole = "fast" | "balanced" | "powerful" | "reasoning" | "coding"
interface RoutingCandidatePolicy {
  capabilities: ModelCapability[]
  order: "cost" | "quality"
  limit: number
}
/** Versioned hard-capability policies; intentionally contains no model ids. */
declare const ROUTING_CANDIDATE_POLICIES: Record<CatalogRoutingRole, RoutingCandidatePolicy>
declare function listRoutingCandidates(
  repository: CatalogRepository,
  role: CatalogRoutingRole,
  enabledDeploymentIds: ReadonlySet<string>
): ModelMappingEntry[]

export {
  type CatalogRoutingRole,
  ROUTING_CANDIDATE_POLICIES,
  ROUTING_CANDIDATE_SET_VERSION,
  listRoutingCandidates,
}
