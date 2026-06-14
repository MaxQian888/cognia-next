/**
 * Gather the capability catalog the auto-orchestration composer draws from.
 *
 * Thin adapter over `buildKnownCapabilityIds()` (`capability-audit.ts`) — the
 * exact same source the runtime resolves against — projecting the per-bucket
 * `Set`s into sorted, capped string arrays suitable for embedding in an LLM
 * prompt and validating composed rosters against. Reusing the audit builder
 * means the composer can never assign a capability the runtime can't resolve.
 */

import { buildKnownCapabilityIds } from "@/lib/ai/agent/team/capability-audit"
import type { CapabilityCatalog } from "./types"

/** Per-bucket cap — keeps the composer prompt bounded on capability-rich hosts. */
export const MAX_CATALOG_IDS_PER_BUCKET = 80

/** Sort + cap a known-id set into a deterministic, bounded array. */
function project(ids: Set<string>): string[] {
  return [...ids].sort().slice(0, MAX_CATALOG_IDS_PER_BUCKET)
}

export interface GatherCapabilityCatalogDeps {
  /** Injection seam for tests; defaults to the live audit builder. */
  buildKnownIds?: typeof buildKnownCapabilityIds
}

/**
 * Build the catalog of capabilities a composed roster may draw from. Six
 * buckets — the same ones a teammate overlay can carry, minus `a2uiTemplateIds`
 * (an IM-bridge surface, not a teammate work capability).
 */
export async function gatherCapabilityCatalog(
  deps: GatherCapabilityCatalogDeps = {}
): Promise<CapabilityCatalog> {
  const known = await (deps.buildKnownIds ?? buildKnownCapabilityIds)()
  return {
    skillIds: project(known.skillIds),
    mcpServerIds: project(known.mcpServerIds),
    nativeAnthropicToolIds: project(known.nativeAnthropicToolIds),
    characterPackIds: project(known.characterPackIds),
    externalAgentPresetIds: project(known.externalAgentPresetIds),
    subagentIds: project(known.subagentIds),
  }
}

/** An empty catalog — used as a fail-open fallback when enumeration throws. */
export const EMPTY_CAPABILITY_CATALOG: CapabilityCatalog = {
  skillIds: [],
  mcpServerIds: [],
  nativeAnthropicToolIds: [],
  characterPackIds: [],
  externalAgentPresetIds: [],
  subagentIds: [],
}
