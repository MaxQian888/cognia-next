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

export function installExecutionRunControlHandlers(): {
  agent: RunControlHandler
  workflow: RunControlHandler
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

  const unregisterAgent = registerRunControlHandler("agent-turn", agent)
  const unregisterWorkflow = registerRunControlHandler("workflow", workflow)
  return {
    agent,
    workflow,
    dispose() {
      unregisterAgent()
      unregisterWorkflow()
    },
  }
}
