import type {
  AgentEventEnvelope,
  AgentTurnOutcome,
  AgentWorkerManifestV1,
  HandoffEnvelope,
} from "@cognia/agent"
import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"
import { isPlaceable } from "@/lib/placement/liveness"
import { selectPlacement } from "@/lib/placement/select"
import { PlacementWaitingError, type PlacementCandidate } from "@/lib/placement/types"
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
  // A worker's socket is the strongest liveness signal there is, so this goes
  // through the shared judgment rather than reading `online` directly — one
  // definition of reachable across workers, phones, and remote hosts.
  if (
    !isPlaceable(
      { online: worker.online, lastSeenAt: worker.lastSeenAt, source: "socket" },
      Date.now()
    )
  ) {
    return { ready: false, reason: "worker_offline" }
  }
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

/**
 * Project a worker onto the shared placement vocabulary.
 *
 * Only the fields the shared selector reads: identity, liveness, and load.
 * Compatibility stays with {@link evaluateRemoteWorkerPlacement}, whose eleven
 * reasons are persisted on `AgentTeamChildRun.placementReason` and therefore
 * cannot be flattened into the generic ones.
 */
function asPlacementCandidate(worker: RemoteWorkerDescriptor): PlacementCandidate {
  return {
    ref: worker.hostRef,
    kind: "worker",
    liveness: { online: worker.online, lastSeenAt: worker.lastSeenAt, source: "socket" },
    provides: [],
    activeUnits: worker.activeTurns,
    maxUnits: worker.manifest.maxActiveTurns,
  }
}

export function selectRemoteWorker(
  workers: readonly RemoteWorkerDescriptor[],
  target: Exclude<TeammateExecutionTarget, { mode: "colocate" }>,
  requirements: RemoteWorkerRequirements
): RemoteWorkerDescriptor {
  const byRef = new Map(workers.map((worker) => [worker.hostRef, worker]))
  const verdicts = new Map<string, ReturnType<typeof evaluateRemoteWorkerPlacement>>()
  const pinnedRef = target.mode === "pinned" ? target.hostRef : undefined
  const constraint =
    pinnedRef !== undefined
      ? ({ mode: "pinned", ref: pinnedRef } as const)
      : ({ mode: "auto" } as const)

  try {
    // The shared selector owns ordering, the lexicographic tiebreak that keeps
    // two hosts from picking different targets for the same placement, and the
    // waiting-is-not-failure distinction. Worker compatibility stays here.
    const selection = selectPlacement(
      workers.map(asPlacementCandidate),
      constraint,
      [],
      Date.now(),
      {
        evaluate: (candidate) => {
          const worker = byRef.get(candidate.ref)!
          const verdict = evaluateRemoteWorkerPlacement(worker, requirements)
          verdicts.set(candidate.ref, verdict)
          return verdict.ready
            ? { ready: true }
            : {
                ready: false,
                reason: verdict.reason === "worker_offline" ? "offline" : "capability_mismatch",
              }
        },
      }
    )
    return byRef.get(selection.candidate.ref)!
  } catch (error) {
    if (!(error instanceof PlacementWaitingError)) throw error
    const reason = error.ref ? verdicts.get(error.ref) : undefined
    const placementReason = reason && !reason.ready ? reason.reason : undefined
    if (error.waiting === "pinned_candidate_unavailable") {
      throw new RemoteWorkerWaitingError("pinned_host_offline", pinnedRef)
    }
    throw new RemoteWorkerWaitingError(
      "no_compatible_capacity",
      error.ref ?? pinnedRef,
      placementReason
    )
  }
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
const runtimeListeners = new Set<() => void>()

function notifyRuntimeChanged(): void {
  for (const listener of [...runtimeListeners]) listener()
}

export function installRemoteWorkerRuntime(next: RemoteWorkerRuntime): () => void {
  runtime = next
  notifyRuntimeChanged()
  return () => {
    if (runtime !== next) return
    runtime = undefined
    notifyRuntimeChanged()
  }
}

export function getRemoteWorkerRuntime(): RemoteWorkerRuntime | undefined {
  return runtime
}

/**
 * Observe whether this host can dispatch to workers at all.
 *
 * Presence of the runtime is the difference between a worker that will receive
 * frames and one that will silently never be dispatched to, so the Fleet UI
 * reads it through `useSyncExternalStore` rather than assuming a host is
 * capable because it accepted an enrollment.
 */
export function subscribeToRemoteWorkerRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener)
  return () => {
    runtimeListeners.delete(listener)
  }
}

/** True when a brain is attached on this host and dispatch can actually run. */
export function isRemoteWorkerDispatchAvailable(): boolean {
  return runtime !== undefined
}

export function __resetRemoteWorkerRuntimeForTesting(): void {
  runtime = undefined
  notifyRuntimeChanged()
}
