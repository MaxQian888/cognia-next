import type {
  AgentEventEnvelope,
  AgentTurnOutcome,
  AgentWorkerManifestV1,
  HandoffEnvelope,
} from "@cognia/agent"
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
  requiredCapabilities: readonly string[]
  credentialProfileRef?: string
  workspaceBindingRef: string
  requiredSandboxCapabilities: readonly string[]
}

export class RemoteWorkerWaitingError extends Error {
  constructor(
    readonly reason: "pinned_host_offline" | "no_compatible_capacity",
    readonly hostRef?: string
  ) {
    super(
      reason === "pinned_host_offline"
        ? `Pinned execution worker is offline: ${hostRef ?? "unknown"}`
        : "No compatible execution worker has available capacity"
    )
    this.name = "RemoteWorkerWaitingError"
  }
}

function isCompatible(
  worker: RemoteWorkerDescriptor,
  requirements: RemoteWorkerRequirements
): boolean {
  const manifest = worker.manifest
  return (
    worker.online &&
    manifest.manifestVersion === 1 &&
    manifest.taskWorkspace.enabled &&
    worker.activeTurns < manifest.maxActiveTurns &&
    requirements.requiredCapabilities.every((item) => manifest.hardCapabilities.includes(item)) &&
    (!requirements.credentialProfileRef ||
      manifest.credentialProfileRefs.includes(requirements.credentialProfileRef)) &&
    manifest.workspaceBindingRefs.includes(requirements.workspaceBindingRef) &&
    requirements.requiredSandboxCapabilities.every((item) =>
      manifest.sandbox.capabilities.includes(item)
    )
  )
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
    if (!isCompatible(pinned, requirements)) {
      throw new RemoteWorkerWaitingError("no_compatible_capacity", target.hostRef)
    }
    return pinned
  }
  const compatible = workers
    .filter((worker) => isCompatible(worker, requirements))
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
  remoteSessionId?: string
  lastRemoteEventId?: string
  prompt: string
  maxSteps?: number
  signal?: AbortSignal
  onSession(sessionId: string): Promise<void> | void
  onEvent(event: AgentEventEnvelope): Promise<void> | void
  onControl(control: RemoteWorkerControl): Promise<void> | void
}

export interface RemoteWorkerControl {
  steer(message: string, commandId: string): Promise<void>
  pause(commandId: string): Promise<void>
  resume(commandId: string): Promise<void>
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
