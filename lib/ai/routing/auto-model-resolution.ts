/**
 * Placeholder-model resolution for Auto routing (ADR-0043 Phase 12).
 *
 * `"auto"` and enabled `modelMappings` aliases are ROUTING REQUESTS, not
 * model ids — the send path resolves them through `planRoute`, but the
 * background rails (renderer LLM client, per-role agent client) build a
 * concrete `provider:model` pair without the engine. Left alone they would
 * hand `"auto"` or `"fast"` to a provider as a literal model id. This module
 * is the shared detector (`isRoutingPlaceholderModel`) plus the Fusion-style
 * role→tier resolution (`resolveRoleTierModel`) those rails use instead.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"
import { createMappingRegistry, resolveModelAlias } from "@cognia/provider-routing"

/**
 * True when `model` is a routing placeholder rather than a dispatchable model
 * id: the literal `"auto"` (case-insensitive) or the name of an enabled alias
 * in `modelMappings`. Callers treat a placeholder as "unset" and resolve it
 * through the routing path instead of forwarding it verbatim.
 */
export function isRoutingPlaceholderModel(
  model: string | undefined,
  modelMappings: ModelMapping[] | undefined
): boolean {
  if (!model) return false
  const normalized = model.toLowerCase()
  if (normalized === "auto") return true
  return (modelMappings ?? []).some(
    (mapping) => mapping.enabled !== false && mapping.alias.toLowerCase() === normalized
  )
}

/** Fallback tier ladder when `autoRouting.candidateAliases` is unconfigured. */
const FALLBACK_LADDER = ["fast", "balanced", "powerful"] as const

/**
 * Fusion-style role→tier resolution: each agent role lands on a rung of the
 * configured candidate-alias ladder — `plan` takes the strongest rung,
 * `utility` the cheapest, `execute` the middle — then walks like
 * `pickAutoAlias`: down toward cheaper rungs first, then up. The first rung
 * whose alias is enabled AND resolves wins; `undefined` when none does.
 *
 * Deliberately NOT gated on `autoRouting.enabled`: the aliases in
 * `modelMappings` are what make this meaningful, and a caller holding a
 * placeholder model needs it resolved whether or not Auto mode is on.
 */
export function resolveRoleTierModel(input: {
  role: "plan" | "execute" | "utility"
  appSettings: AppSettings | null | undefined
}): { providerId: string; modelId: string } | undefined {
  const { role, appSettings } = input
  const modelMappings = appSettings?.modelMappings ?? []
  const ladder = appSettings?.autoRouting?.candidateAliases?.length
    ? appSettings.autoRouting.candidateAliases
    : [...FALLBACK_LADDER]
  if (ladder.length === 0) return undefined
  const enabledAliases = new Set(
    modelMappings
      .filter((mapping) => mapping.enabled !== false)
      .map((mapping) => mapping.alias.toLowerCase())
  )
  const registry = createMappingRegistry(modelMappings)
  const target =
    role === "plan" ? ladder.length - 1 : role === "utility" ? 0 : Math.min(1, ladder.length - 1)

  const resolveAt = (index: number): { providerId: string; modelId: string } | undefined => {
    const alias = ladder[index]?.toLowerCase()
    if (!alias || !enabledAliases.has(alias)) return undefined
    const entry = resolveModelAlias(alias, registry).entries[0]
    return entry ? { providerId: entry.providerId, modelId: entry.modelId } : undefined
  }

  for (let index = target; index >= 0; index--) {
    const resolved = resolveAt(index)
    if (resolved) return resolved
  }
  for (let index = target + 1; index < ladder.length; index++) {
    const resolved = resolveAt(index)
    if (resolved) return resolved
  }
  return undefined
}
