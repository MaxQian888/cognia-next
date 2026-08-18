import { getExecutionRun } from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { registerRunControlHandler, type RunControlHandler } from "./run-control"

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
  goal: RunControlHandler
  plan: RunControlHandler
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
    throw new Error(`Unsupported agent control: ${command.action}`)
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
    throw new Error(`Unsupported workflow control: ${command.action}`)
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
    if (!result) throw new Error(`Unsupported goal control: ${command.action}`)
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
    if (!result) throw new Error(`Unsupported plan control: ${command.action}`)
  }

  const unregisterAgent = registerRunControlHandler("agent-turn", agent)
  const unregisterWorkflows = (["workflow", "team", "scheduled"] as const).map((kind) =>
    registerRunControlHandler(kind, workflow)
  )
  const unregisterGoal = registerRunControlHandler("goal", goal)
  const unregisterPlan = registerRunControlHandler("plan", plan)
  return {
    agent,
    workflow,
    goal,
    plan,
    dispose() {
      unregisterAgent()
      for (const unregister of unregisterWorkflows) unregister()
      unregisterGoal()
      unregisterPlan()
    },
  }
}
