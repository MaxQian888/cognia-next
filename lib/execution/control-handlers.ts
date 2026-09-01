import { adoptExecutionRun, getExecutionRun, listChildExecutionRuns } from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import type { ExecutionRun, ExecutionRunStatus, RunControlCommand } from "@/types/execution/run"
import {
  registerRunControlHandler,
  type RunControlHandler,
  type RunControlHandlerOutcome,
  type SteerDegradedReason,
} from "./run-control"
import { registerRunRetryHandler, type RunRetryHandler } from "./run-retry-registry"

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
const securityScanControllers = new Map<string, AbortController>()

export function registerAgentRunController(runId: string, controller: AbortController): () => void {
  agentControllers.set(runId, controller)
  return () => {
    if (agentControllers.get(runId) === controller) agentControllers.delete(runId)
  }
}

export function registerSecurityScanRunController(
  runId: string,
  controller: AbortController
): () => void {
  securityScanControllers.set(runId, controller)
  return () => {
    if (securityScanControllers.get(runId) === controller) securityScanControllers.delete(runId)
  }
}

export interface ExecutionRunControlHandlerDeps {
  resumeAgentRun?: (runId: string) => Promise<{ resumed: boolean; reason?: string }>
}

/**
 * A settled run whose kind has no re-dispatch.
 *
 * Reported through {@link UnsupportedForKindError} so the gate answers
 * `unsupported_for_kind` rather than a generic engine refusal — and so
 * `allowedActions`, which never registers a handler for these kinds, never
 * offers the button in the first place.
 */
const TERMINAL_RETRY_STATUSES = new Set(["failed", "cancelled"])

export function installExecutionRunControlHandlers(deps: ExecutionRunControlHandlerDeps = {}): {
  agent: RunControlHandler
  job: RunControlHandler
  securityScan: RunControlHandler
  workflow: RunControlHandler
  team: RunControlHandler
  goal: RunControlHandler
  plan: RunControlHandler
  delegation: RunControlHandler
  workflowRetry: RunRetryHandler
  delegationRetry: RunRetryHandler
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
   * A team run that has no `agentTeamRuns` record: either a `trigger.team`
   * workflow run, or a run on the LEGACY runtime, which writes no durable
   * record at all.
   *
   * Legacy was reaching `workflow` and dying quietly. Its `sourceId` is a
   * lifecycle run id rather than a workflow run id, so `cancelWorkflowRun`
   * looked up nothing and returned `noop`, which the workflow handler
   * discards: Stop reported success and stopped nothing. `legacy` is the
   * default runtime version, so that was the common case.
   *
   * The live-run context registry already maps a run id to its team, and for
   * exactly as long as the run can be controlled at all: a legacy run keeps
   * its abort controller in memory and does not outlive the process. Control
   * goes through `agentTeamManager`, the same entry the Squad console uses,
   * so there is no second control implementation here.
   *
   * When neither registry knows the run, the workflow cancel's own `noop` is
   * reported instead of swallowed, so the cockpit says the engine refused
   * rather than showing a stop that never happened.
   */
  const legacyOrWorkflow = async (command: RunControlCommand, sourceId: string): Promise<void> => {
    const { getTeamRunContext } = await import("@/lib/ai/agent/team/team-run-context")
    const live = getTeamRunContext(sourceId)
    if (live) {
      const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
      if (command.action === "pause") return agentTeamManager.pause(live.teamId)
      if (command.action === "stop") return agentTeamManager.shutdown(live.teamId)
      // `resume` is absent on purpose, and unreachable rather than merely
      // unwanted: the context registry holds an entry only while the
      // lifecycle is live, and pausing a legacy run exits the lifecycle. So a
      // paused legacy run never has a `live` context to resume through.
      // Resuming one starts a FRESH lifecycle over the remaining tasks, which
      // is a new run with a new row, so the Squad console owns that verb.
      //
      // Steering is refused for the same shape of reason: it needs the
      // durable coordinator's receipt queue, and a legacy run has nowhere to
      // put the message.
      throw new UnsupportedForKindError(command.action, "team")
    }
    if (command.action !== "stop") throw new UnsupportedForKindError(command.action, "team")
    const { cancelWorkflowRun } = await import("@/lib/workflow/runtime/cancel-run")
    const result = await cancelWorkflowRun(sourceId, "im_control")
    if (result.mode === "noop") throw new Error("No live run behind this team row")
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
    if (!durable) return legacyOrWorkflow(command, run.sourceId)

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

    if (command.action === "resume") {
      // Handing the work back is a control on the SAME run, not a new request —
      // which is why the handoff never terminated the delegation. Resolving the
      // interrupt is what unblocks it, and clearing the assignee runs
      // `setAssignee`'s own restore path for the mode and routing the
      // assignment had overridden.
      const pending = await getDb()
        .executionRunInterrupts.where("[runId+status]")
        .equals([command.runId, "pending"])
        .toArray()
      const handoff = command.interruptId
        ? pending.find((interrupt) => interrupt.id === command.interruptId)
        : pending.find((interrupt) => interrupt.type === "human_handoff")
      if (handoff?.type === "human_handoff") {
        const { resumeDelegationHandoff } = await import("./delegation-handoff")
        await resumeDelegationHandoff({
          runId: command.runId,
          interruptId: handoff.id,
          actor: command.actor,
        })
        // A note attached to the return is a correction, and it travels the
        // same way every other correction does — through the engine's own
        // steering gate, never into the journal.
        if (command.steerMessage?.trim()) {
          const live = (await listChildExecutionRuns(command.runId)).filter((child) =>
            ACTIVE_STATUSES.has(child.status)
          )
          for (const child of live) {
            await forwardToChild(child, { ...command, action: "steer" }).catch(() => undefined)
          }
        }
        return
      }
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

  /**
   * Re-dispatch a settled workflow run as a fresh formal invocation.
   *
   * `retryWorkflowRun` is the existing operator-visible retry — the seed row is
   * immutable and nothing in history is overwritten — so this adds a caller,
   * not a second retry path. Two things are supplied that the desktop history
   * view does not need:
   *
   *   - the seed's `triggeredBy`, so a run retried from the thread that asked
   *     for it keeps reporting back there instead of starting invisibly;
   *   - `onAdmitted`, so this returns as soon as the run id is durably
   *     reserved. `executeDeployedWorkflow` resolves at COMPLETION, and a
   *     control command that waited for that would hold the gate's per-run lock
   *     for the length of the workflow.
   */
  const workflowRetry: RunRetryHandler = async ({ run }) => {
    if (!TERMINAL_RETRY_STATUSES.has(run.status)) {
      throw new UnsupportedForKindError("retry", run.kind)
    }
    const seed = await getDb().workflowRuns.get(run.sourceId)
    if (!seed) throw new Error(`Workflow run not found: ${run.sourceId}`)

    const [{ retryWorkflowRun }, { workflowExecutionRunId }] = await Promise.all([
      import("@/lib/workflow/runtime/execution-authority"),
      import("./workflow-bridge"),
    ])

    let admitted: string | undefined
    let markAdmitted: () => void = () => undefined
    const reserved = new Promise<void>((resolve) => {
      markAdmitted = resolve
    })
    const execution = retryWorkflowRun({
      runId: run.sourceId,
      mode: "current-deployment",
      operatedBy: run.initiator?.remoteUserId ?? run.initiator?.platformIdentityId ?? "run-control",
      ...(seed.triggeredBy ? { triggeredBy: seed.triggeredBy } : {}),
      onAdmitted: (runId) => {
        admitted = runId
        markAdmitted()
      },
    })
    // The second arm is what keeps an admission failure (no deployment, invalid
    // seed) from hanging here forever, and it owns the rejection of the
    // detached run.
    await Promise.race([reserved, execution.then(() => undefined)])
    if (!admitted) admitted = (await execution).runId
    return { runId: workflowExecutionRunId(admitted) }
  }

  /**
   * A delegation does not execute, so it cannot itself be re-dispatched — it
   * retries the child that carried the work and adopts the replacement.
   *
   * The newest settled child is the one that failed the commitment; older ones
   * already handed off. Retrying all of them would multiply the work a single
   * "try again" asked for exactly once.
   */
  const delegationRetry: RunRetryHandler = async ({ run, command }) => {
    const settled = (await listChildExecutionRuns(run.id)).filter((child) =>
      TERMINAL_RETRY_STATUSES.has(child.status)
    )
    const target = settled.find((child) => !child.retry)
    if (!target) throw new UnsupportedForKindError("retry", "delegation")
    const handler =
      target.kind === "workflow" || target.kind === "scheduled" ? workflowRetry : undefined
    if (!handler) throw new UnsupportedForKindError("retry", target.kind)
    const replacement = await handler({ run: target, command })
    // The replacement belongs to the COMMITMENT, not to the attempt it
    // replaces: a delegation is one card, and a child hanging off the failed
    // child would drift off it.
    await adoptExecutionRun(replacement.runId, run.id).catch(() => undefined)
    return replacement
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

  /**
   * A background task can be stopped and inspected, and nothing else. There is
   * no live input lane to steer and no coordinator to pause — `allowedActions`
   * already reflects that, so anything other than `stop` arriving here is a
   * caller bypassing the projection, not a user pressing a real button.
   */
  const job: RunControlHandler = async (command) => {
    if (command.action === "open_details") return
    if (command.action !== "stop") throw new UnsupportedForKindError(command.action, "job")
    const run = await getExecutionRun(command.runId)
    if (!run) throw new Error("Background task is not known to this process")
    const { cancelRendererBackgroundRun } =
      await import("@/lib/background-tasks/renderer-subagent-registry")
    // `sourceId` is the background journal's own runId — the execution run id
    // is a projection and the registry has never heard of it.
    if (!cancelRendererBackgroundRun(run.sourceId)) {
      throw new Error("Background task is not active in this process")
    }
  }

  const securityScan: RunControlHandler = async (command) => {
    if (command.action === "open_details") return
    if (command.action !== "stop") {
      throw new UnsupportedForKindError(command.action, "security-scan")
    }
    const controller = securityScanControllers.get(command.runId)
    if (!controller) throw new Error("Security scan is not active in this process")
    controller.abort("execution_run_stopped")
  }

  const unregisterAgent = registerRunControlHandler("agent-turn", agent)
  const unregisterJob = registerRunControlHandler("job", job)
  const unregisterSecurityScan = registerRunControlHandler("security-scan", securityScan)
  const unregisterWorkflows = (["workflow", "scheduled"] as const).map((kind) =>
    registerRunControlHandler(kind, workflow)
  )
  const unregisterTeam = registerRunControlHandler("team", team)
  const unregisterDelegation = registerRunControlHandler("delegation", delegation)
  const unregisterGoal = registerRunControlHandler("goal", goal)
  const unregisterPlan = registerRunControlHandler("plan", plan)
  // Only the kinds with a real re-dispatch register one. `agent-turn`, `team`,
  // `goal` and `plan` deliberately do not: an agent turn's replacement is a new
  // inbound turn rather than a new run of the same one, and a team/goal/plan
  // retry would have to re-derive a permission ceiling and an objective that
  // are not on the settled row. `canRetryRunKind` reads this registry, so those
  // cards simply never show the button.
  const unregisterWorkflowRetry = (["workflow", "scheduled"] as const).map((kind) =>
    registerRunRetryHandler(kind, workflowRetry)
  )
  const unregisterDelegationRetry = registerRunRetryHandler("delegation", delegationRetry)
  return {
    agent,
    job,
    securityScan,
    workflow,
    team,
    goal,
    plan,
    delegation,
    workflowRetry,
    delegationRetry,
    dispose() {
      unregisterAgent()
      unregisterJob()
      unregisterSecurityScan()
      unregisterTeam()
      unregisterDelegation()
      for (const unregister of unregisterWorkflows) unregister()
      unregisterGoal()
      unregisterPlan()
      for (const unregister of unregisterWorkflowRetry) unregister()
      unregisterDelegationRetry()
    },
  }
}
