/**
 * Materialize an approved `AutoOrchestrationProposal` into the agent-team store.
 *
 * Store-bound (desktop / renderer) — kept separate from the pure
 * `auto-orchestrate.ts` so headless surfaces (CLI) can plan + preview without
 * pulling the Zustand store. Resolves the proposal's index-based references
 * into real store ids: roster[0] reuses the lead `createTeam` auto-creates; the
 * rest are added; tasks map `assignedTo`/`dependencies` indices onto the
 * freshly-minted teammate / task ids. The routing assessment is stamped onto
 * the team so the runtime's routing-driven pattern selection picks it up.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamConfig, TeamDispatchDecision } from "@/types/agent/agent-team"
import { chooseExecutor } from "./dispatch-executor"
import type { AutoOrchestrationProposal } from "./types"

export interface MaterializeResult {
  teamId: string
  leadId: string
  /** Store teammate ids, indexed parallel to `proposal.roster`. */
  teammateIds: string[]
  /** Store task ids, indexed parallel to `proposal.tasks`. */
  taskIds: string[]
  /** The executor decision stamped onto the team (computed if absent). */
  decision: TeamDispatchDecision
}

export interface MaterializeOptions {
  /** Team name; defaults to a truncated objective. */
  name?: string
  sessionId?: string
  /**
   * Extra team config to merge at creation (e.g. `requirePlanApproval`,
   * `ultracode`). The proposal's pattern still wins for
   * `preferredExecutionPattern` so routing stays consistent.
   */
  config?: Partial<AgentTeamConfig>
}

/** Turn an approved proposal into a runnable team. Returns the created ids. */
export function materializeProposal(
  proposal: AutoOrchestrationProposal,
  opts: MaterializeOptions = {}
): MaterializeResult {
  const store = useAgentTeamStore.getState()
  const lead = proposal.roster[0]
  const name = opts.name?.trim() || proposal.objective.slice(0, 60) || "Auto team"

  const team = store.createTeam({
    name,
    description: proposal.assessment.reason,
    task: proposal.objective,
    sessionId: opts.sessionId,
    leadName: lead?.name,
    leadDescription: lead?.description,
    config: {
      ...opts.config,
      preferredExecutionPattern: proposal.assessment.recommendedPattern,
    },
  })

  // roster index → teammate id. Index 0 is the auto-created lead; enrich it
  // with the proposal's lead specialization + capabilities.
  const teammateIds: string[] = [team.leadId]
  if (lead) {
    const leadTeammate = useAgentTeamStore.getState().teammates[team.leadId]
    if (leadTeammate) {
      store.upsertTeammate({
        ...leadTeammate,
        ...(lead.specialization ? { specialization: lead.specialization } : {}),
        config: {
          ...leadTeammate.config,
          ...(lead.specialization ? { specialization: lead.specialization } : {}),
          ...(lead.capabilities ? { capabilities: lead.capabilities } : {}),
        },
      })
    }
  }
  for (let i = 1; i < proposal.roster.length; i++) {
    const m = proposal.roster[i]
    const teammate = store.addTeammate({
      teamId: team.id,
      name: m.name,
      description: m.description,
      role: "teammate",
      config: {
        ...(m.specialization ? { specialization: m.specialization } : {}),
        ...(m.capabilities ? { capabilities: m.capabilities } : {}),
      },
    })
    teammateIds.push(teammate.id)
  }

  // task index → task id (created in order so backward deps resolve).
  const taskIds: string[] = []
  proposal.tasks.forEach((t, i) => {
    const assignedTo = teammateIds[t.assignedTo] ?? team.leadId
    const dependencies = t.dependencies
      .map((d) => taskIds[d])
      .filter((id): id is string => typeof id === "string")
    const task = store.createTask({
      teamId: team.id,
      title: t.title,
      description: t.description,
      assignedTo,
      dependencies,
      order: i,
      ...(t.expectedOutput ? { expectedOutput: t.expectedOutput } : {}),
    })
    taskIds.push(task.id)
  })

  // Stamp the routing assessment so routing-driven pattern selection can read
  // it, plus the executor decision for UI/audit provenance. Proposals from
  // before the executor field existed compute it here so the stamp is never
  // missing on newly-materialized teams.
  const decision = proposal.executor ?? chooseExecutor(proposal.assessment)
  store.updateTeam(team.id, {
    routingAssessment: proposal.assessment,
    selectedExecutionPattern: proposal.assessment.recommendedPattern,
    dispatchDecision: decision,
  })

  return { teamId: team.id, leadId: team.leadId, teammateIds, taskIds, decision }
}
