/**
 * Run-estimate queries for a best-of-N launch (ADR-0232).
 *
 * One query per distinct agent choice, multiplied by how many candidates use
 * it. Candidates run in parallel, so their costs add up while the group takes
 * as long as its slowest candidate; `combineParallelEstimates` does the rest.
 */

import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import type { RunEstimateQuery } from "@/lib/usage/run-estimate/estimate"
import type { ChatSession } from "@cognia/agent-config-types"

import { SESSION_AGENT_CHOICE } from "./agents"

export function bestOfNEstimateQueries(
  session: Pick<ChatSession, "model" | "providerOverride">,
  agents: readonly string[]
): RunEstimateQuery[] {
  const counts = new Map<string, number>()
  for (const choice of agents) counts.set(choice, (counts.get(choice) ?? 0) + 1)
  return [...counts].map(([choice, multiplier]) =>
    choice === SESSION_AGENT_CHOICE
      ? {
          surface: "best-of-n",
          model: session.model ?? null,
          providerId: session.providerOverride ?? null,
          multiplier,
        }
      : { surface: "best-of-n", providerId: externalAgentProviderId(choice), multiplier }
  )
}
