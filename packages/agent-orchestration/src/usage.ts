/**
 * Run-level resource accounting (ADR-0217): a run's usage is the fold of its
 * children's, recomputed from the children so it never drifts from them.
 */

import type { AgentTeamChildRun, AgentTeamResourceUsage } from "./records"
import type { TeamRunStore } from "./store"

export const EMPTY_RESOURCE_USAGE: Readonly<AgentTeamResourceUsage> = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  wallTimeMs: 0,
  toolTimeMs: 0,
  attempts: 0,
  failures: 0,
})

/**
 * Sum the children's usage. Children run concurrently, so wall time is the
 * longest child's, not the sum; cost appears only when some child reported it.
 */
export function sumChildUsage(
  children: readonly Pick<AgentTeamChildRun, "resourceUsage">[]
): AgentTeamResourceUsage {
  return children.reduce<AgentTeamResourceUsage>(
    (total, { resourceUsage: child }) => ({
      promptTokens: total.promptTokens + child.promptTokens,
      completionTokens: total.completionTokens + child.completionTokens,
      totalTokens: total.totalTokens + child.totalTokens,
      ...(total.costUsd !== undefined || child.costUsd !== undefined
        ? { costUsd: (total.costUsd ?? 0) + (child.costUsd ?? 0) }
        : {}),
      wallTimeMs: Math.max(total.wallTimeMs, child.wallTimeMs),
      toolTimeMs: total.toolTimeMs + child.toolTimeMs,
      attempts: total.attempts + child.attempts,
      failures: total.failures + child.failures,
    }),
    { ...EMPTY_RESOURCE_USAGE }
  )
}

/** Recompute and store a run's usage from its children in one atomic unit. */
export function recordRunUsage<TConstraints>(
  store: TeamRunStore<TConstraints>,
  runId: string,
  updatedAt: number
): Promise<AgentTeamResourceUsage> {
  return store.atomically(async (tx) => {
    const resourceUsage = sumChildUsage(await tx.listChildren(runId))
    await tx.updateRun(runId, { resourceUsage, updatedAt })
    return resourceUsage
  })
}
