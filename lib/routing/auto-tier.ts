/**
 * Auto-routing tier picker (RouteLLM-lite, opt-in).
 *
 * Maps a prompt's difficulty score (0–1, from `scoreDifficulty`) to one of the
 * configured tier aliases (low → high capability), then walks toward the
 * nearest alias that actually exists in the user's `modelMappings`. The picked
 * alias is fed back into the existing routing engine in `resolveSendOptions`,
 * so auto routing reuses every filter/strategy/fallback the alias path already
 * provides. Pure and synchronous — no awaits, no engine dependency.
 */

import type { AutoRoutingSettings } from "@/types/routing/tool-route"

/**
 * Pick the tier alias for a prompt of the given difficulty `score`.
 *
 * `settings.candidateAliases` is the tier ladder, ordered low → high. The score
 * thresholds select a target rung (`< balanced` → lowest, `< powerful` → mid,
 * else top). Because a rung's alias may not be enabled in `modelMappings`, the
 * picker first degrades DOWN toward cheaper enabled tiers, then — only if none
 * exist at or below the target — climbs UP to the cheapest enabled tier above
 * it, so an enabled auto-router still routes. Returns `undefined` when no
 * candidate alias is enabled, which the caller treats as a no-op (keep the
 * concrete model).
 */
export function pickAutoAlias(
  score: number,
  settings: AutoRoutingSettings,
  availableAliases: Set<string>
): string | undefined {
  const tiers = settings.candidateAliases
  if (!tiers || tiers.length === 0) return undefined

  const { balanced, powerful } = settings.thresholds
  let target: number
  if (score < balanced) target = 0
  else if (score < powerful) target = Math.min(1, tiers.length - 1)
  else target = tiers.length - 1
  target = Math.max(0, Math.min(target, tiers.length - 1))

  const present = (i: number): string | undefined => {
    const alias = tiers[i]?.toLowerCase()
    return alias && availableAliases.has(alias) ? alias : undefined
  }

  // Prefer the target tier, then degrade toward cheaper enabled tiers.
  for (let i = target; i >= 0; i--) {
    const hit = present(i)
    if (hit) return hit
  }
  // Nothing at or below the target is enabled — climb to the cheapest above.
  for (let i = target + 1; i < tiers.length; i++) {
    const hit = present(i)
    if (hit) return hit
  }
  return undefined
}
