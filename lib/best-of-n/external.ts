import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { ExternalAgentEvent, ExternalAgentResult } from "@/types/agent/external-agent"
import type { PermissionBoundExternalExecutionOptions } from "@/lib/ai/agent/external/policy/permission-ceiling"
import type { ExternalAgentReadiness } from "@/lib/agent/ensure-external-agent-ready"

export interface ExternalCandidateManager {
  getAgent(agentId: string): unknown
  execute(
    agentId: string,
    prompt: string,
    options?: PermissionBoundExternalExecutionOptions
  ): Promise<ExternalAgentResult>
}

export interface ExternalCandidateDeps {
  manager(): Promise<ExternalCandidateManager>
  ensureReady(agentId: string): Promise<ExternalAgentReadiness>
  /** An always-on Host starts the agent in the workspace's runtime environment. */
  place(agentId: string, cwd: string, manager: ExternalCandidateManager): Promise<void>
  pipe(onCapture: (event: CaptureStreamEvent) => void): Promise<(event: ExternalAgentEvent) => void>
}

export interface ExternalCandidateInput {
  /** The exact external configuration recorded in the ledger. */
  configId: string
  prompt: string
  model?: string | null
  /** The candidate's own workspace root, never the parent checkout. */
  workingDirectory: string
  signal: AbortSignal
  onCapture(event: CaptureStreamEvent): void
}

const production: ExternalCandidateDeps = {
  async manager() {
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    return getExternalAgentManager()
  },
  async ensureReady(agentId) {
    const { ensureExternalAgentReady } = await import("@/lib/agent/ensure-external-agent-ready")
    // Register only: execute connects with the configuration's own binding.
    return ensureExternalAgentReady(agentId, { deferConnect: true })
  },
  async place(agentId, cwd, manager) {
    const { placeDispatchedAgent } = await import("@/lib/sandbox/host-agent-placement")
    await placeDispatchedAgent(agentId, cwd, manager as never)
  },
  async pipe(onCapture) {
    const { pipeExternalEventsToCapture } =
      await import("@/lib/ai/agent/external/session/external-event-progress")
    return pipeExternalEventsToCapture(onCapture)
  },
}

/**
 * One candidate on an external CLI agent, through the same manager launch path
 * Agent Team teammates use. The external execute contract exposes neither
 * Cognia's tools nor a dollar budget: no MCP servers are forwarded, so the
 * candidate grant's denials hold, and cost stays unknown.
 */
export async function runExternalCandidate(
  input: ExternalCandidateInput,
  deps: ExternalCandidateDeps = production
): Promise<{ text: string }> {
  input.signal.throwIfAborted()
  const manager = await deps.manager()
  if (!manager.getAgent(input.configId)) {
    const readiness = await deps.ensureReady(input.configId)
    if (!readiness.ok)
      throw new Error(
        `External agent ${input.configId} is unavailable: ${
          readiness.reason === "unknown-agent" ? "configuration not found" : readiness.detail
        }`
      )
  }
  await deps.place(input.configId, input.workingDirectory, manager)
  const onEvent = await deps.pipe(input.onCapture)
  input.signal.throwIfAborted()
  const result = await manager.execute(input.configId, input.prompt, {
    workingDirectory: input.workingDirectory,
    ...(input.model ? { model: input.model } : {}),
    onEvent,
    signal: input.signal,
  })
  if (!result.success)
    throw new Error(result.error || `External agent ${input.configId} returned a failure`)
  return { text: result.finalResponse ?? "" }
}
