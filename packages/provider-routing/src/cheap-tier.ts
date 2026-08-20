/**
 * Resolve the cheap lane a run should downshift to.
 *
 * `ModelPreferenceController.downshift()` only sets `modelHint` when the
 * controller was constructed with a `cheapModel`, and both production call
 * sites — the Agent Team runtime and the plan teammate context — constructed it
 * with no options at all. `preferCheap` was read nowhere. So the budget guard's
 * documented "downshift on handoff_to_background" flipped a flag nobody read
 * and produced a hint that was permanently `undefined`: the cost-control
 * escalation never changed a model.
 *
 * This is where the target comes from, and it is derived, never hard-coded —
 * the existing `UTILITY_CHEAP_MODELS` table (`claude-haiku-4-5-20251001` /
 * `gpt-4o-mini`) is exactly the kind of literal that goes stale and that a user
 * with neither provider enabled cannot serve.
 *
 * Two branches, in order:
 *
 *   1. **An alias, if one exists.** `modelHint = "fast"` re-enters the existing
 *      `ProviderRoutingEngine` with every filter, strategy, breaker and
 *      fallback chain intact, because `resolveSendOptions` treats any enabled
 *      alias as an alias request. This is the whole reason there is no second
 *      router here.
 *   2. **A concrete pair**, for callers that cannot resolve an alias (the
 *      renderer utility client wants an id). Cost-ordered candidates
 *      intersected with what the user can actually serve.
 *
 * `undefined` is a real answer and means "keep today's behaviour": the caller
 * sets `preferCheap` and no hint. Never dead-end a run, and never invent a
 * model id the account cannot call.
 */

import type { ModelMapping } from "@cognia/provider-types/model-mapping"
import type { CustomProviderSettings, UserProviderSettings } from "@cognia/provider-types/provider"

import { collectOptions } from "./model-option-source"

/** The lane the routing candidate policy calls `fast` — cost-ordered. */
export const CHEAP_TIER_ALIAS = "fast"

export type CheapTierTarget =
  { kind: "alias"; alias: string } | { kind: "model"; providerId: string; modelId: string }

/** One catalog candidate, already cost-ordered by the caller. */
export interface CheapTierCandidate {
  providerId: string
  modelId: string
}

export interface ResolveCheapTierInput {
  modelMappings?: readonly ModelMapping[]
  providerSettings?: Record<string, UserProviderSettings>
  customProviders?: CustomProviderSettings[]
  /**
   * Bias toward staying on the current provider among equally cheap options,
   * so a downshift does not also switch vendors and throw away prompt-cache
   * locality — which can cost more than the tier change saves.
   */
  preferProviderId?: string
  /**
   * Cost-ordered candidates from `listRoutingCandidates(repo, "fast", …)`.
   * Optional because reaching the catalog is async and Dexie-bound; without
   * them only the alias branch can answer.
   */
  candidates?: readonly CheapTierCandidate[]
}

function servableKeys(input: ResolveCheapTierInput): Set<string> {
  const options = collectOptions(input.providerSettings, input.customProviders)
  return new Set(options.map((option) => `${option.providerId}:${option.modelId}`))
}

export function resolveCheapTier(input: ResolveCheapTierInput): CheapTierTarget | undefined {
  const servable = servableKeys(input)

  // --- 1. alias --------------------------------------------------------------
  const mapping = (input.modelMappings ?? []).find(
    (candidate) => candidate.enabled && candidate.alias.trim().toLowerCase() === CHEAP_TIER_ALIAS
  )
  if (mapping) {
    // An alias whose every entry points at something the user cannot serve is
    // not a lane, it is a dead end — fall through rather than hand the engine
    // a chain it will reject with RoutingNoCandidatesError.
    const usable = mapping.providers.some((entry) =>
      servable.has(`${entry.providerId}:${entry.modelId}`)
    )
    if (usable) return { kind: "alias", alias: mapping.alias }
  }

  // --- 2. derive -------------------------------------------------------------
  const usableCandidates = (input.candidates ?? []).filter((candidate) =>
    servable.has(`${candidate.providerId}:${candidate.modelId}`)
  )
  if (usableCandidates.length === 0) return undefined

  const preferred =
    input.preferProviderId &&
    usableCandidates.find((candidate) => candidate.providerId === input.preferProviderId)
  const chosen = preferred || usableCandidates[0]
  return { kind: "model", providerId: chosen.providerId, modelId: chosen.modelId }
}

/**
 * The value `ModelPreferenceController` wants: an alias or a bare model id,
 * both of which `resolveSendOptions` accepts in the same `modelHint` slot.
 */
export function cheapTierModelHint(target: CheapTierTarget | undefined): string | undefined {
  if (!target) return undefined
  return target.kind === "alias" ? target.alias : target.modelId
}
