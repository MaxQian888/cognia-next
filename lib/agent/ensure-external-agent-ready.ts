/**
 * Bring the agent a user just picked into a state that can actually run a turn.
 *
 * Selecting an external agent used to write two store fields and stop there. A
 * configured agent that had never been connected was therefore selectable, the
 * chip named it, and nothing anywhere said the lane could not dispatch. The
 * first turn then reached `ExternalAgentManager.execute`, which looks the agent
 * up in its own adapter map and throws `Agent not found: <id>` when the manager
 * has never been given it. That message is about the manager's internals and
 * says nothing a user can act on.
 *
 * So selection ensures readiness instead: register the config with the manager
 * if it is missing, and connect if it is not connected. Failures are recorded
 * against the agent through the same channel a manual connect uses, so they
 * surface where the agent is rather than as a raw error on the next send.
 *
 * # The run's environment (ADR-0182)
 *
 * A send that knows its project passes `environment`, and readiness then
 * includes WHERE the agent runs: the project's runtime environment is
 * resolved first, a refusal stops the send before any process starts, and an
 * agent already running somewhere other than where this run belongs is
 * restarted rather than reused. Without `environment` nothing here changes —
 * which is every caller that is not a project run, and every run on a
 * deployment that never enabled the pool (Q39).
 */

import { describeExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"
import { getExternalAgentExecutionBlockReason } from "@/lib/ai/agent/external/config/config-normalizer"
import type { RunEnvironmentRequest } from "@/lib/sandbox/run-environment"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

/** The project context of the run an agent is being readied for. */
export type ReadinessEnvironment = Omit<RunEnvironmentRequest, "agentId">

export type ExternalAgentReadiness =
  | { ok: true; alreadyConnected: boolean }
  /** No stored config with this id. The selection outlived the agent. */
  | { ok: false; reason: "unknown-agent" }
  /** The gate refuses before anything is started. `detail` is the reason. */
  | { ok: false; reason: "blocked"; detail: string }
  /** Registering or connecting threw. `detail` is what came back. */
  | { ok: false; reason: "failed"; detail: string }

/**
 * One attempt per agent at a time.
 *
 * The runtime chip, the manager panel and a send can all ask within the same
 * tick, and connecting an agent twice starts two processes.
 */
const inFlight = new Map<string, Promise<ExternalAgentReadiness>>()

async function run(
  agentId: string,
  deferConnect = false,
  environment?: ReadinessEnvironment
): Promise<ExternalAgentReadiness> {
  const store = useExternalAgentStore.getState()
  const config = store.getAgent(agentId)
  if (!config) return { ok: false, reason: "unknown-agent" }

  const blocked = getExternalAgentExecutionBlockReason(config)
  if (blocked) return { ok: false, reason: "blocked", detail: blocked }

  // Inside the try with everything else. A chunk that fails to load rejects
  // here, and every caller drives this from a click handler that cannot await
  // it, so an escaping rejection is an unhandled one rather than a readiness
  // answer anybody sees.
  let manager: Awaited<
    ReturnType<typeof import("@/lib/ai/agent/external/manager").getExternalAgentManager>
  >
  try {
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    manager = getExternalAgentManager()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    store.recordAgentFailure(describeExternalAgentFailure(agentId, "connect", error))
    return { ok: false, reason: "failed", detail }
  }

  try {
    if (!manager.getAgent(agentId)) {
      // `connect: false` so the connect below is the only one, and so a manager
      // that already holds the agent takes the same path as one that does not.
      await manager.addAgent(config, { connect: false })
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // Registering twice is a race between two callers, not a failure.
    if (!detail.includes("Agent already exists")) {
      store.recordAgentFailure(describeExternalAgentFailure(agentId, "connect", error))
      store.setConnectionStatus(agentId, "error")
      return { ok: false, reason: "failed", detail }
    }
  }

  // Resolved before anything can start, so a refusal never leaves a process
  // running on the path the refusal ruled out.
  let respawn = false
  if (environment) {
    try {
      const { agentNeedsRespawn, placeAgentRun } = await import("@/lib/sandbox/run-environment")
      const outcome = await placeAgentRun({ ...environment, agentId })
      if (outcome.kind === "refused") {
        const { outcomeMessage } = await import("@/lib/sandbox/environment-outcome-message")
        const detail = (await outcomeMessage(outcome).catch(() => undefined)) ?? outcome.code
        return { ok: false, reason: "blocked", detail }
      }
      respawn = agentNeedsRespawn(agentId, outcome)
    } catch (error) {
      // Resolution itself failing is not "the environment is off": carrying on
      // would start an agent a mandatory project never allowed on the host.
      const detail = error instanceof Error ? error.message : String(error)
      store.recordAgentFailure(describeExternalAgentFailure(agentId, "connect", error))
      return { ok: false, reason: "failed", detail }
    }
  }

  const instance = manager.getAgent(agentId)
  // A task-scoped gateway process must acquire its route before any launch.
  if (deferConnect || config.cogniaModel) return { ok: true, alreadyConnected: false }
  if (instance?.connectionStatus === "connected" && !respawn) {
    store.setConnectionStatus(agentId, "connected")
    return { ok: true, alreadyConnected: true }
  }

  store.clearAgentFailure(agentId)
  store.setConnectionStatus(agentId, "connecting")
  try {
    // Running somewhere this run does not belong: start it again, where it
    // does. `reconnect` tears the old process down first.
    if (instance?.connectionStatus === "connected") await manager.reconnect(agentId)
    else await manager.connect(agentId)
    store.setConnectionStatus(agentId, manager.getAgent(agentId)?.connectionStatus ?? "connected")
    return { ok: true, alreadyConnected: false }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    store.recordAgentFailure(describeExternalAgentFailure(agentId, "connect", error))
    store.setConnectionStatus(agentId, "error")
    return { ok: false, reason: "failed", detail }
  }
}

/**
 * Idempotent and safe to call from a click handler without awaiting.
 *
 * Never rejects. Callers drive it from an event handler and cannot await it,
 * so a rejection would be an unhandled one instead of a readiness the caller
 * can render. Anything `run` did not already turn into a reason lands as
 * `failed` with the thrown text.
 */
export function ensureExternalAgentReady(
  agentId: string,
  options?: { deferConnect?: boolean; environment?: ReadinessEnvironment }
): Promise<ExternalAgentReadiness> {
  // A project run and a bare connect are different questions: sharing one
  // in-flight answer would let a click's "connected" stand in for a run whose
  // environment was never resolved.
  const scope = options?.environment
    ? `env:${options.environment.projectId}:${options.environment.environmentId ?? ""}:${options.environment.executionRoot ?? ""}`
    : "bare"
  const key = `${agentId}:${options?.deferConnect === true ? "register" : "connect"}:${scope}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const attempt = run(agentId, options?.deferConnect, options?.environment)
    .catch((error: unknown): ExternalAgentReadiness => ({
      ok: false,
      reason: "failed",
      detail: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => inFlight.delete(key))
  inFlight.set(key, attempt)
  return attempt
}

/** Test seam: drop any remembered in-flight attempt. */
export function __resetEnsureExternalAgentReadyForTests(): void {
  inFlight.clear()
}
