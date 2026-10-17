/**
 * The run-estimate query for a scheduled task being created or edited
 * (ADR-0232), or `null` for task types that do not launch a long agent run.
 *
 * A scheduled goal or squad is estimated from goal / squad history, because
 * that is what it runs. Chat, agent and skill tasks run as their own
 * conversation and use the `scheduled` bucket; an external-agent task does too,
 * keyed on the configured agent's harness.
 */

import { externalAgentProviderId } from "@/lib/ai/agent/external/session/session-models"
import type { RunEstimateQuery } from "@/lib/usage/run-estimate/estimate"
import type { ScheduledTaskType } from "@/types/scheduler"

export interface ScheduledEstimateInput {
  taskType: ScheduledTaskType
  /** The chat / agent / skill draft's model. */
  model?: string
  /** The external-agent draft's configuration id. */
  externalAgentId?: string
}

export function scheduledTaskEstimateQuery(input: ScheduledEstimateInput): RunEstimateQuery | null {
  switch (input.taskType) {
    case "goal":
      return { surface: "goal" }
    case "agent-team":
      return { surface: "team" }
    case "chat":
    case "agent":
    case "skill":
      return { surface: "scheduled", model: input.model?.trim() || null }
    case "external-agent": {
      const agentId = input.externalAgentId?.trim()
      return agentId
        ? { surface: "scheduled", providerId: externalAgentProviderId(agentId) }
        : { surface: "scheduled", harness: null }
    }
    default:
      return null
  }
}
