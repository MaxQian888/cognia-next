import { getExecutionRun, listChildExecutionRuns } from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import type { ExecutionRun, ExecutionRunStatus, RunControlCommand } from "@/types/execution/run"
import {
  registerRunControlHandler,
  type RunControlHandler,
  type RunControlHandlerOutcome,
  type SteerDegradedReason,
} from "./run-control"

/**
 * The action exists in the vocabulary but this run kind cannot perform it.
 *
 * Carried as its own error type so `executeRunControlCommand` can report
 * `unsupported_for_kind` instead of collapsing every handler throw into
 * `source_rejected` — a card can then stop offering a button rather than
 * showing a refusal the user has no way to act on.
 */
export class UnsupportedForKindError extends Error {
  constructor(
    readonly action: string,
    readonly kind: string
  ) {
    super(`Run kind "${kind}" cannot ${action}`)
    this.name = "UnsupportedForKindError"
  }
}

/**
 * A steer the run kind supports but could not apply right now.
 *
 * Distinct from {@link UnsupportedForKindError} on purpose: this one means the
 * user's message is still intact and still theirs to place. Collapsing the two
 * would force every caller to choose between dropping a correction and sending
 * it twice — the silent-downgrade behaviour this replaces.
 */
export class SteerDegradedError extends Error {
  constructor(readonly reason: SteerDegradedReason) {
    super(`Steer degraded: ${reason}`)
    this.name = "SteerDegradedError"
  }
}

const ACTIVE_STATUSES: ReadonlySet<ExecutionRunStatus> = new Set<ExecutionRunStatus>([
  "queued",
  "running",
  "waiting",
  "paused",
  "recovery_required",
])

const agentControllers = new Map<string, AbortController>()

export function registerAgentRunController(runId: string, controller: AbortController): () => void {
  agentControllers.set(runId, controller)
  return () => {
    if (agentControllers.get(runId) === controller) agentControllers.delete(runId)
  }
}

export interface ExecutionRunControlHandlerDeps {
  resumeAgentRun?: (runId: string) => Promise<{ resumed: boolean; reason?: string }>
}

export function installExecutionRunControlHandlers(deps: ExecutionRunControlHandlerDeps = {}): {
  agent: RunControlHandler
  workflow: RunControlHandler
  team: RunControlHandler
  goal: RunControlHandler
  plan: RunControlHandler
  delegation: RunControlHandler
  dispose(): void
} {
  const agent: RunControlHandler = async (command) => {
    if (command.action === "open_details") return
    if (command.action === "stop") {
      const controller = agentControllers.get(command.runId)
      if (!controller) throw new Error("Agent run is not active in this process")
      controller.abort("execution_run_stopped")
      return
    }
    if (command.action === "resume") {
      const resume =
        deps.resumeAgentRun ??
        (async (runId: string) => {
          const { resumeCrashedAgentRun } =
            await import("@/lib/ai/agent/recovery/reconcile-crashed-runs")
          const outcome = await resumeCrashedAgentRun(runId)
          if (outcome.resumed) {
            const { getBus } = await import("@/lib/connectors/bus")
            await getBus().resumeDurableInboundJobs()
          }
          return outcome
        })
      const outcome = await resume(command.runId)
      if (!outcome.resumed) {
        throw new Error(`Agent run cannot resume safely: ${outcome.reason ?? "unknown"}`)
      }
      return
    }
    if (command.action === "steer") {
      const run = await getExecutionRun(command.runId)
      if (!run?.sessionId) throw new SteerDegradedError("no_active_run")
      const { steerSession } = await import("@/lib/claude/ipc")
      try {
        // `steerSession` runs its own renderer-side PII gate and throws rather
        // than sending — so the gate is not re-implemented here, it is relied
        // on, and its refusal is reported as the reason it actually was.
        await steerSession(run.sessionId, command.steerMessage ?? "")
      } catch (error) {
        throw new SteerDegradedError(
          error instanceof Error && /PII/i.test(error.message)
            ? "pii_blocked"
            : "provider_unsupported"
        )
      }
      return
    }
    if (command.action === "approve" || command.action === "deny") {
      const run = await getExecutionRun(command.runId)
      const interrupt = command.interruptId
        ? await getDb().executionRunInterrupts.get(command.interruptId)
        : undefined
      if (!run?.sessionId || !interrupt?.requestDigest) {
        throw new Error("Agent permission request cannot be resumed")
      }
      const { resolveApproval } = await import("@/lib/connectors/hitl/approval-registry")
      if (
        !resolveApproval(run.sessionId, interrupt.requestDigest, {
          decision: command.action === "approve" ? "allow" : "deny",
        })
      ) {
        throw new Error("Agent permission request is no longer active")
      }
      return
    }
    throw new UnsupportedForKindError(command.action, "agent")
  }

  const workflow: RunControlHandler = async (command) => {
    if (command.action === "open_details") return
    const run = await getExecutionRun(command.runId)
    if (!run) throw new Error("Execution run not found")
    if (command.action === "stop") {
      const { cancelWorkflowRun } = await import("@/lib/workflow/runtime/cancel-run")
      await cancelWorkflowRun(run.sourceId, "im_control")
      return
    }
    throw new UnsupportedForKindError(command.action, "workflow")
  }

  /**
   * Team runs reach the execution journal by two routes with different
   * `sourceId` semantics, and only one of them is a workflow:
   *
   *   - a `trigger.team` workflow run projected by `workflow-bridge.ts`, whose
   *     `sourceId` is a workflow run id — `cancelWorkflowRun` is correct;
   *   - a durable-v2 run projected by `agent-team-bridge.ts`, whose `sourceId`
   *     is an `AgentTeamRunRecord` id — `cancelWorkflowRun` looks it up, finds
   *     nothing, and the stop button does nothing.
   *
   * Both kinds were registered to the workflow handler, so half of them could
   * not be stopped at all. Discriminate on the source row rather than on the
   * kind, and hand a durable run to `controlDurableRun` — the function that
   * has always known how, and had no registration.
   */
  const team: RunControlHandler = async (command) => {
    if (command.action === "open_details") return
    const run = await getExecutionRun(command.runId)
    if (!run) throw new Error("Execution run not found")

    const { getAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
    const durable = await getAgentTeamRun(run.sourceId).catch(() => undefined)
    if (!durable) return workflow(command)

    if (command.action === "steer") {
      const { steerDurableRun } = await import("@/lib/ai/agent/team/durable-control")
      // The coordinator persists a receipt BEFORE attempting live delivery, so
      // "nothing is attached right now" is the durable path working, not a
      // failure — the next provider turn drains the queued receipt. Only "no
      // child can act at all" is a real degradation.
      const { receiptIds, childCount } = await steerDurableRun(
        run.sourceId,
        command.steerMessage ?? ""
      )
      if (childCount === 0) throw new SteerDegradedError("no_active_run")
      return { steerReceiptIds: receiptIds }
    }

    const action =
      command.action === "stop"
        ? "stop"
        : command.action === "pause"
          ? "pause"
          : command.action === "resume"
            ? "resume"
            : undefined
    if (!action) throw new UnsupportedForKindError(command.action, "team")
    const { controlDurableRun } = await import("@/lib/ai/agent/team/durable-control")
    await controlDurableRun(run.sourceId, action)
  }

  const goal: RunControlHandler = async (command) => {
    if (command.action === "open_details") return
    const run = await getExecutionRun(command.runId)
    if (!run) throw new Error("Execution run not found")
    const { getGoalRuntime } = await import("@/lib/goal/runtime")
    const runtime = getGoalRuntime()
    const result =
      command.action === "pause"
        ? await runtime.pauseGoal(run.sourceId)
        : command.action === "resume"
          ? await runtime.resumeGoal(run.sourceId)
          : command.action === "stop"
            ? await runtime.stopGoal(run.sourceId)
            : null
    if (!result) throw new UnsupportedForKindError(command.action, "goal")
  }

  const plan: RunControlHandler = async (command) => {
    if (command.action === "open_details") return
    const run = await getExecutionRun(command.runId)
    if (!run) throw new Error("Execution run not found")
    const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
    const runtime = getPlanRuntime()
    // `approve` / `deny` close the remote-approval loop: a companion mirrors
    // plan rows read-only (sync handler `plans`), so answering the approval
    // gate from the phone has to travel back as a control command — a local
    // write would be overwritten by the next pull.
    if (command.action === "approve") {
      const approved = await runtime.approvePlan(run.sourceId)
      if (!approved) throw new Error("Execution run not found")
      // Orchestrated plans are headless, so the host can start them right
      // here. An in-session plan is driven by the chat surface that owns the
      // visible turns; leaving it `approved` is what hands it over.
      const started = await runtime.startPlan(run.sourceId)
      if (started?.strategy === "orchestrated") void runtime.runPlan(run.sourceId)
      return
    }
    if (command.action === "deny") {
      const rejected = await runtime.rejectPlan(run.sourceId)
      if (!rejected) throw new Error("Execution run not found")
      return
    }
    const result =
      command.action === "pause"
        ? await runtime.pausePlan(run.sourceId)
        : command.action === "resume"
          ? await runtime.resumePlan(run.sourceId)
          : command.action === "stop"
            ? await runtime.cancelPlan(run.sourceId)
            : null
    if (!result) throw new UnsupportedForKindError(command.action, "plan")
  }

  /**
   * A delegation does not execute anything itself — it OWNS the runs that do.
   * So its controls are forwarded to whichever children can still act, and the
   * delegation's own journal records the control once, on the surface the
   * person is actually looking at.
   *
   * Children are driven through the handlers directly rather than through
   * `executeRunControlCommand`: that gate authorizes against the target run's
   * own `initiator`, and a child minted by the runtime usually has none — so
   * routing through it would reject every forwarded control as `forbidden`.
   * The authorization that matters already happened, on the delegation.
   *
   * `stop` deliberately does NOT settle the delegation here. Settling appends
   * a terminal event, and the control gate still has to append `control.accepted`
   * afterwards — which a terminal journal refuses, correctly. The reconciler
   * closes the delegation once nothing can still act; see `delegation-bridge.ts`.
   */
  const delegation: RunControlHandler = async (command) => {
    if (command.action === "open_details") return
    const run = await getExecutionRun(command.runId)
    if (!run) throw new Error("Execution run not found")

    if (command.action === "approve" || command.action === "deny") {
      const interrupt = command.interruptId
        ? await getDb().executionRunInterrupts.get(command.interruptId)
        : undefined
      if (!interrupt || interrupt.runId !== run.id) {
        throw new Error("Delegation approval is no longer pending")
      }
      // `human_handoff` has no waiter to release — the person answering IS the
      // release, and `resume` is how they hand the work back. The other two
      // types park a promise in the approval registry.
      if (interrupt.type !== "human_handoff" && run.sessionId && interrupt.requestDigest) {
        const { resolveApproval } = await import("@/lib/connectors/hitl/approval-registry")
        resolveApproval(run.sessionId, interrupt.requestDigest, {
          decision: command.action === "approve" ? "allow" : "deny",
        })
      }
      return
    }

    const children = (await listChildExecutionRuns(command.runId)).filter((child) =>
      ACTIVE_STATUSES.has(child.status)
    )

    if (command.action === "steer") {
      if (children.length === 0) throw new SteerDegradedError("no_active_run")
      const receiptIds: string[] = []
      let applied = 0
      let lastReason: SteerDegradedReason | undefined
      for (const child of children) {
        try {
          const outcome = await forwardToChild(child, command)
          for (const id of outcome?.steerReceiptIds ?? []) receiptIds.push(id)
          applied += 1
        } catch (error) {
          if (error instanceof SteerDegradedError) lastReason = error.reason
          // A child that cannot be steered must not stop the ones that can.
        }
      }
      if (applied === 0) throw new SteerDegradedError(lastReason ?? "no_active_run")
      return { steerReceiptIds: receiptIds }
    }

    if (command.action !== "stop" && command.action !== "pause" && command.action !== "resume") {
      throw new UnsupportedForKindError(command.action, "delegation")
    }
    let forwarded = 0
    for (const child of children) {
      try {
        await forwardToChild(child, command)
        forwarded += 1
      } catch {
        // Best-effort per child; a delegation with one wedged child is still
        // stoppable, and the reconciler settles it when the rest are done.
      }
    }
    // `stop` with nothing left to stop is not an error: the commitment is what
    // is being withdrawn, and the reconciler acts on the recorded control.
    if (forwarded === 0 && command.action !== "stop") {
      throw new UnsupportedForKindError(command.action, "delegation")
    }
  }

  const handlerForKind = (kind: ExecutionRun["kind"]): RunControlHandler | undefined => {
    switch (kind) {
      case "agent-turn":
        return agent
      case "team":
        return team
      case "workflow":
      case "scheduled":
        return workflow
      case "goal":
        return goal
      case "plan":
        return plan
      case "delegation":
        // A delegation owning a delegation is legitimate (a sub-brief), and
        // the cycle guard is structural: `adoptExecutionRun` refuses self-
        // adoption and a run has exactly one parent, so the chain is a tree.
        return delegation
    }
  }

  async function forwardToChild(
    child: ExecutionRun,
    command: RunControlCommand
  ): Promise<void | RunControlHandlerOutcome> {
    const handler = handlerForKind(child.kind)
    if (!handler) throw new UnsupportedForKindError(command.action, child.kind)
    return handler({ ...command, runId: child.id, expectedRevision: child.currentRevision })
  }

  const unregisterAgent = registerRunControlHandler("agent-turn", agent)
  const unregisterWorkflows = (["workflow", "scheduled"] as const).map((kind) =>
    registerRunControlHandler(kind, workflow)
  )
  const unregisterTeam = registerRunControlHandler("team", team)
  const unregisterDelegation = registerRunControlHandler("delegation", delegation)
  const unregisterGoal = registerRunControlHandler("goal", goal)
  const unregisterPlan = registerRunControlHandler("plan", plan)
  return {
    agent,
    workflow,
    team,
    goal,
    plan,
    delegation,
    dispose() {
      unregisterAgent()
      unregisterTeam()
      unregisterDelegation()
      for (const unregister of unregisterWorkflows) unregister()
      unregisterGoal()
      unregisterPlan()
    },
  }
}
