/**
 * Session-affinity pre-call filter (LiteLLM DeploymentAffinityCheck /
 * PromptCachingDeploymentCheck analog). Multi-turn conversations stick to the
 * deployment that served the previous successful turn — better prompt-cache
 * hit rates and consistent behavior — via a SOFT pin: the pinned entry moves
 * to the front (the engine selects it, bypassing the strategy) while every
 * other candidate stays in the fallback chain.
 *
 * Health-aware release: a pin whose deployment has gone open/unavailable is
 * skipped AND released so the session re-pins to whatever serves it next.
 */

import { deploymentKeyOfEntry } from "@/types/provider/deployment"
import type { DeploymentFilter, FilterOutcome } from "@/types/provider/deployment-filter"

export const affinityFilter: DeploymentFilter = {
  id: "affinity",
  label: "Session affinity",
  filter: (candidates, req, ctx): FilterOutcome => {
    const passthrough: FilterOutcome = { candidates: [...candidates] }
    if (!req.sessionId || !ctx.getSessionDeployment) return passthrough
    const pinned = ctx.getSessionDeployment(req.sessionId)
    if (!pinned) return passthrough
    const idx = candidates.findIndex((e) => deploymentKeyOfEntry(e) === pinned)
    // Pin targets a deployment outside this alias's pool — leave it alone
    // (the session may interleave aliases; the pin stays for the right one).
    if (idx < 0) return passthrough
    const entry = candidates[idx]
    if (ctx.getCircuitBreakerState(entry) === "open" || !ctx.isAvailable(entry)) {
      ctx.releaseSessionDeployment?.(req.sessionId)
      return passthrough
    }
    const reordered =
      idx === 0 ? [...candidates] : [entry, ...candidates.filter((_, i) => i !== idx)]
    return { candidates: reordered, notes: { affinityPinned: pinned } }
  },
}
