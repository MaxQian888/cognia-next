import type {
  AgentEventEnvelope,
  AgentTurnOutcome,
  AgentWorkerManifestV1,
  HandoffEnvelope,
} from "@cognia/agent"
import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"
import type { TeammateExecutionTarget } from "@/types/agent/agent-team"

export interface RemoteWorkerDescriptor {
  connectionId: string
  /** Derived from the authenticated Companion device identity. */
  hostRef: string
  online: boolean
  activeTurns: number
  lastSeenAt: number
  manifest: AgentWorkerManifestV1
}

export interface RemoteWorkerRequirements {
  spec: ResolvedAgentExecutionSpec
  workspaceBindingRef: string
  requiredSandboxCapabilities: readonly string[]
}

export type RemoteWorkerPlacementReason =
  | "worker_offline"
  | "execution_profile_missing"
  | "runtime_mismatch"
  | "model_mismatch"
  | "deployment_mismatch"
  | "capability_mismatch"
  | "credential_missing"
  | "task_workspace_unavailable"
  | "workspace_missing"
  | "sandbox_mismatch"
  | "capacity_exhausted"

export class RemoteWorkerWaitingError extends Error {
  constructor(
    readonly reason: "pinned_host_offline" | "no_compatible_capacity",
    readonly hostRef?: string,
    readonly placementReason?: RemoteWorkerPlacementReason
  ) {
    super(
      reason === "pinned_host_offline"
        ? `Pinned execution worker is offline: ${hostRef ?? "unknown"}`
        : "No compatible execution worker has available capacity"
    )
    this.name = "RemoteWorkerWaitingError"
  }
}

export function evaluateRemoteWorkerPlacement(
  worker: RemoteWorkerDescriptor,
  requirements: RemoteWorkerRequirements
): { ready: true } | { ready: false; reason: RemoteWorkerPlacementReason } {
  const manifest = worker.manifest
  const profile = manifest.executionProfile
  const spec = requirements.spec
  if (!worker.online) return { ready: false, reason: "worker_offline" }
  if (!profile) return { ready: false, reason: "execution_profile_missing" }
  if (profile.runtimeAdapter !== spec.runtimeAdapter) {
    return { ready: false, reason: "runtime_mismatch" }
  }
  const requestedModels = Object.values(spec.modelBindings).filter(
    (model): model is string => typeof model === "string" && model !== "inherit"
  )
  const workerModels = new Set(Object.values(profile.modelBindings))
  if (requestedModels.some((model) => !workerModels.has(model))) {
    return { ready: false, reason: "model_mismatch" }
  }
  if (spec.deploymentRef && !profile.deploymentRefs.includes(spec.deploymentRef)) {
    return { ready: false, reason: "deployment_mismatch" }
  }
  if (
    spec.capabilities.effective.some((capability) => !profile.capabilities.includes(capability))
  ) {
    return { ready: false, reason: "capability_mismatch" }
  }
  if (
    spec.credential?.profileRef &&
    !manifest.credentialProfileRefs.includes(spec.credential.profileRef)
  ) {
    return { ready: false, reason: "credential_missing" }
  }
  if (!manifest.taskWorkspace.enabled) {
    return { ready: false, reason: "task_workspace_unavailable" }
  }
  if (!manifest.workspaceBindingRefs.includes(requirements.workspaceBindingRef)) {
    return { ready: false, reason: "workspace_missing" }
  }
  if (
    requirements.requiredSandboxCapabilities.some(
      (capability) => !manifest.sandbox.capabilities.includes(capability)
    )
  ) {
    return { ready: false, reason: "sandbox_mismatch" }
  }
  if (worker.activeTurns >= manifest.maxActiveTurns) {
    return { ready: false, reason: "capacity_exhausted" }
  }
  return { ready: true }
}

export function selectRemoteWorker(
  workers: readonly RemoteWorkerDescriptor[],
  target: Exclude<TeammateExecutionTarget, { mode: "colocate" }>,
  requirements: RemoteWorkerRequirements
): RemoteWorkerDescriptor {
  if (target.mode === "pinned") {
    const pinned = workers.find((worker) => worker.hostRef === target.hostRef)
    if (!pinned?.online) {
      throw new RemoteWorkerWaitingError("pinned_host_offline", target.hostRef)
    }
    const placement = evaluateRemoteWorkerPlacement(pinned, requirements)
    if (!placement.ready) {
      throw new RemoteWorkerWaitingError("no_compatible_capacity", target.hostRef, placement.reason)
    }
    return pinned
  }
  const compatible = workers
    .filter((worker) => evaluateRemoteWorkerPlacement(worker, requirements).ready)
    .sort(
      (left, right) =>
        left.activeTurns - right.activeTurns || left.hostRef.localeCompare(right.hostRef)
    )
  const selected = compatible[0]
  if (!selected) throw new RemoteWorkerWaitingError("no_compatible_capacity")
  return selected
}

export interface RemoteWorkerRunInput {
  hostRef: string
  handoff: HandoffEnvelope
  commandId: string
  /** Existing session used only by checkpoint-gated disconnect/restart recovery. */
  recoverySessionId?: string
  lastRemoteEventId?: string
  prompt: string
  maxSteps?: number
  signal?: AbortSignal
  onSession(sessionId: string): Promise<void> | void
  onEvent(event: AgentEventEnvelope): Promise<void> | void
  onControl(control: RemoteWorkerTurnControl): Promise<void> | void
}

export interface RemoteWorkerTurnControl {
  steer(message: string, commandId: string): Promise<void>
  pause(commandId: string): Promise<void>
  terminate(commandId: string): Promise<void>
}

export interface RemoteWorkerRuntime {
  listWorkers(): readonly RemoteWorkerDescriptor[]
  run(input: RemoteWorkerRunInput): Promise<AgentTurnOutcome>
}

let runtime: RemoteWorkerRuntime | undefined

export function installRemoteWorkerRuntime(next: RemoteWorkerRuntime): () => void {
  runtime = next
  return () => {
    if (runtime === next) runtime = undefined
  }
}

export function getRemoteWorkerRuntime(): RemoteWorkerRuntime | undefined {
  return runtime
}

export function __resetRemoteWorkerRuntimeForTesting(): void {
  runtime = undefined
}
