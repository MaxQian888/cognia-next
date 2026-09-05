/**
 * Dispatch an inbound IM message to an Agent Team (control-plane multi-agent).
 *
 * When a conversation is bound to a team (`ConversationOverrideRow.teamId`),
 * the connector runtime routes the inbound message here instead of the
 * single-character `runAndCapture` path.
 *
 * The mechanics live in `lib/ai/agent/team/start-squad-run.ts`, shared with the
 * desktop chat surface — both are "a conversation hands this turn to a Squad",
 * and the only real differences are where progress fans back to and what there
 * is to ask a human on. What stays here is exactly that: the IM `triggeredFrom`
 * origin, the card-based plan-approval channel, and the connector run binding
 * the presentation runner (`lib/connectors/run-presentation/runner.ts`) keys
 * off.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import {
  mintSquadRunId,
  startSquadRun,
  type StartSquadRunDeps,
  type SquadPlanApprovalRequest,
} from "@/lib/ai/agent/team/start-squad-run"

export interface StartTeamRunFromIMInput {
  teamId: string
  /** The inbound message text — seeded as the team's objective. */
  goal: string
  adapterId: string
  conversationKey: string
  sessionId?: string
  characterId?: string
  permissionCeiling?: AgentPermissionCeiling
  /**
   * The conversation's ChatSession. Required to bind the run to the thread
   * that asked for it — without a binding the run-presentation runner has
   * nothing to project onto and every control callback is rejected as a
   * conversation mismatch. Optional only so existing callers compile; a
   * dispatch without it produces an uncarded, uncontrollable run.
   */
  session?: ChatSession
  /**
   * remoteUserId of the person whose message started this run. Scopes the plan
   * card's buttons to them (or a configured operator), the same rule the tool
   * approval card uses.
   */
  initiatorUserId?: string
  /**
   * Plan approval owed by the conversation's AUTONOMY level, independent of
   * risk. ORed into the team's own flag and the risk-derived gate inside the
   * lifecycle; it can raise a gate, never lower one.
   */
  requirePlanApprovalFloor?: boolean
}

export interface StartTeamRunFromIMResult {
  started: boolean
  runId?: string
  reason?:
    | "team_not_found"
    | "no_team_id"
    | "dispatch_error"
    /** Readiness blockers stand (ADR-0169). `blockers` names them. */
    | "not_ready"
    /** A run is already open. `runId` is that run. */
    | "already_running"
  blockers?: import("@/lib/agent-team/squad-readiness").SquadReadinessBlocker[]
}

/**
 * Injectable loaders. Structurally the shared primitive's own deps — kept as a
 * named type because this module's callers and tests already refer to it.
 */
export type StartTeamRunFromIMDeps = StartSquadRunDeps

/**
 * Kick off a team run for an inbound IM message. Fire-and-forget: the lifecycle
 * is launched but NOT awaited (a team run can take minutes; the connector
 * runtime must ack the inbound event fast). Progress + final result flow back
 * to the conversation through the execution bridge + run-presentation
 * runner via the `triggeredFrom` origin. Returns once the run is launched (or a
 * fast failure is detected: missing team / no team id).
 */
export async function startTeamRunFromIM(
  input: StartTeamRunFromIMInput,
  deps: StartTeamRunFromIMDeps = {}
): Promise<StartTeamRunFromIMResult> {
  const teamId = input.teamId?.trim()
  if (!teamId) return { started: false, reason: "no_team_id" }

  const triggeredFrom: WorkflowTriggeredFrom = {
    source: "im",
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.characterId ? { characterId: input.characterId } : {}),
  }

  // Minted here rather than inside the primitive because the approval delegate
  // below closes over it.
  const runId = mintSquadRunId()

  // Give the lifecycle a way to ASK. `origin: "im"` alone put this run under
  // the headless policy, whose plan gate fails fast on the premise that there
  // is no human — true for a 3am scheduler run, false for a chat thread with a
  // person in it and a working approval channel. Supplying the delegate is the
  // proof of that channel; without a delivery target there is genuinely no
  // surface to ask on, so the old fail-fast behaviour stands.
  const deliveryTarget = input.session?.platformBinding?.deliveryTarget
  const conversationRef = deliveryTarget?.conversationRef
  const planApprovalDelegate =
    deliveryTarget && conversationRef
      ? async (request: SquadPlanApprovalRequest) => {
          const { makeImPlanApprovalDelegate } = await import("@/lib/connectors/hitl/plan-approval")
          return makeImPlanApprovalDelegate({
            runId,
            teamId,
            objective: input.goal.trim() || teamId,
            adapterId: input.adapterId,
            conversationKey: input.conversationKey,
            conversationRef,
            deliveryTarget,
            ...(input.initiatorUserId ? { initiatorUserId: input.initiatorUserId } : {}),
          })(request)
        }
      : undefined

  const result = await startSquadRun(
    {
      squadId: teamId,
      goal: input.goal,
      origin: "im",
      triggeredFrom,
      runId,
      // The presentation runner keys off a connector binding; chat does not.
      bindConnectorRun: true,
      ...(input.session ? { session: input.session } : {}),
      ...(input.characterId ? { characterId: input.characterId } : {}),
      ...(input.permissionCeiling ? { permissionCeiling: input.permissionCeiling } : {}),
      ...(input.requirePlanApprovalFloor ? { requirePlanApprovalFloor: true } : {}),
      ...(planApprovalDelegate ? { planApprovalDelegate } : {}),
    },
    deps
  )

  if (result.started) return { started: true, ...(result.runId ? { runId: result.runId } : {}) }
  // The IM lane's vocabulary predates the shared primitive and is what its
  // audit records say. Translate rather than churn the audit trail, but let
  // the two refusals a person can act on through with their detail.
  if (result.reason === "not_ready") {
    return { started: false, reason: "not_ready", blockers: result.blockers ?? [] }
  }
  if (result.reason === "already_running") {
    return {
      started: false,
      reason: "already_running",
      ...(result.runId ? { runId: result.runId } : {}),
    }
  }
  return {
    started: false,
    reason: result.reason === "squad_not_found" ? "team_not_found" : "dispatch_error",
  }
}

/**
 * Resolve a team by id (exact) or display name (case-insensitive) from the
 * live Agent-Team store. Used by the `/team <name|id>` control command. Returns
 * `undefined` when no team matches or the store can't be read.
 */
export async function resolveTeamByNameOrId(
  nameOrId: string
): Promise<{ id: string; name: string } | undefined> {
  try {
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const state = useAgentTeamStore.getState() as unknown as {
      getTeam(id: string): { id: string; name: string } | undefined
      teams?: Record<string, { id: string; name: string }>
    }
    const byId = state.getTeam(nameOrId)
    if (byId) return { id: byId.id, name: byId.name }
    const all = Object.values(state.teams ?? {})
    const byName = all.find((t) => t.name.toLowerCase() === nameOrId.toLowerCase())
    return byName ? { id: byName.id, name: byName.name } : undefined
  } catch {
    return undefined
  }
}
