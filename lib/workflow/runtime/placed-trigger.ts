import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { enqueueHostDispatch, type EnqueueHostDispatchInput } from "@/lib/db/host-dispatch-queue"
import { getDb } from "@/lib/db/schema"
import {
  resolveWorkflowDeployment,
  type ResolvedWorkflowDeployment,
} from "@/lib/db/workflow-deployments"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"
import type { TriggerEvent, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { executeDeployedWorkflow, type ExecuteDeployedWorkflowInput } from "./execution-authority"
import { selectWorkflowHost, type WorkflowHostCandidate } from "./workflow-placement"

export interface WorkflowRemoteHostRef {
  ref: string
}

export interface WorkflowPlacementProbeReply {
  compatible: boolean
  deploymentDigest?: string
  activeUnits: number
  maxUnits: number
}

export interface PlacedTriggerDeps {
  resolveDeployment: (workflowId: string) => Promise<ResolvedWorkflowDeployment | undefined>
  executeLocal: (input: ExecuteDeployedWorkflowInput) => Promise<{ runId: string }>
  getLocalActiveUnits: (workflowId: string) => Promise<number>
  listRemoteHosts: () =>
    readonly WorkflowRemoteHostRef[] | Promise<readonly WorkflowRemoteHostRef[]>
  probeRemote: (
    hostRef: string,
    input: { deploymentId: string; expectedVersionDigest: string }
  ) => Promise<WorkflowPlacementProbeReply>
  enqueueHandoff: (input: EnqueueHostDispatchInput) => Promise<HostDispatchJobRow>
  accountId: () => string
  localHostRef: () => string
  now: () => number
}

export interface DispatchPlacedWorkflowTriggerInput {
  event: TriggerEvent
  idempotencyKey?: string
  triggeredBy?: WorkflowTriggeredFrom
  onAdmitted?: (runId: string) => void
}

export type PlacedWorkflowTriggerResult =
  { kind: "local"; runId: string } | { kind: "remote"; dispatchId: string; targetRef: string }

async function defaultListRemoteHosts(): Promise<WorkflowRemoteHostRef[]> {
  // The renderer owns the enrolled-host credential book. A headless Host can
  // identify itself (below), but it must not invent outbound credentials or a
  // second server-side roster just to discover other Hosts.
  const { useRemoteHostStore } = await import("@/stores/remote-host/remote-host-store")
  return useRemoteHostStore.getState().hosts.flatMap((host) => {
    const manifest = host.featureManifest
    if (
      manifest?.schemaVersion !== 2 ||
      !supportsHostFeatureOperation(manifest, "workflow.execution", "workflow_placement_probe") ||
      !supportsHostFeatureOperation(manifest, "workflow.execution", "workflow_handoff_create")
    ) {
      return []
    }
    return [{ ref: manifest.hostIdentity.id }]
  })
}

function defaultLocalHostRef(): string {
  return process.env.COGNIA_HOST_ID?.trim() || "local"
}

async function defaultProbeRemote(
  hostRef: string,
  input: { deploymentId: string; expectedVersionDigest: string }
): Promise<WorkflowPlacementProbeReply> {
  const target = await openRemoteHostTarget(hostRef)
  try {
    const reply = await target.transport.call<WorkflowPlacementProbeReply>(
      "workflow_placement_probe",
      input
    )
    if (
      !reply ||
      typeof reply.compatible !== "boolean" ||
      !Number.isFinite(reply.activeUnits) ||
      !Number.isFinite(reply.maxUnits)
    ) {
      throw new Error("workflow placement probe returned a malformed response")
    }
    return reply
  } finally {
    target.close()
  }
}

const defaultDeps: PlacedTriggerDeps = {
  resolveDeployment: (workflowId) => resolveWorkflowDeployment(workflowId),
  executeLocal: executeDeployedWorkflow,
  getLocalActiveUnits: (workflowId) =>
    getDb()
      .workflowRuns.where("workflowId")
      .equals(workflowId)
      .filter((run) => ["pending", "running", "waiting", "paused"].includes(run.status))
      .count(),
  listRemoteHosts: defaultListRemoteHosts,
  probeRemote: defaultProbeRemote,
  enqueueHandoff: enqueueHostDispatch,
  accountId: getActiveAccountId,
  localHostRef: defaultLocalHostRef,
  now: Date.now,
}

function localExecutionInput(
  input: DispatchPlacedWorkflowTriggerInput
): ExecuteDeployedWorkflowInput {
  return {
    workflowId: input.event.workflowId,
    entrypoint: "trigger",
    caller: input.event.kind,
    triggerKind: input.event.kind,
    triggerId: input.event.triggerId,
    triggerBinding: input.event.binding,
    triggerOriginAt: input.event.originAt,
    payload: input.event.payload,
    triggeredBy: input.triggeredBy,
    idempotencyKey: input.idempotencyKey,
    onAdmitted: input.onAdmitted,
  }
}

/**
 * Resolve one published top-level trigger to this Host or a durable remote
 * handoff. Subworkflow and node execution stay colocated with their parent.
 */
export async function dispatchPlacedWorkflowTrigger(
  input: DispatchPlacedWorkflowTriggerInput,
  deps: PlacedTriggerDeps = defaultDeps
): Promise<PlacedWorkflowTriggerResult> {
  const resolved = await deps.resolveDeployment(input.event.workflowId)
  if (!resolved) {
    const execution = await deps.executeLocal(localExecutionInput(input))
    return { kind: "local", runId: execution.runId }
  }

  const constraint = resolved.version.definition.settings.runOn ?? { mode: "colocate" as const }
  if (constraint.mode === "colocate") {
    const execution = await deps.executeLocal(localExecutionInput(input))
    return { kind: "local", runId: execution.runId }
  }

  const enqueueRemoteHandoff = async (targetRef: string): Promise<PlacedWorkflowTriggerResult> => {
    const row = await deps.enqueueHandoff({
      accountId: deps.accountId(),
      domain: "schedule-handoff",
      targetRef,
      kind: "workflow.trigger",
      payload: {
        deploymentId: resolved.deployment.id,
        expectedVersionDigest: resolved.version.digest,
        trigger: input.event,
      },
      idempotencyKey: input.idempotencyKey ?? `workflow-handoff:${crypto.randomUUID()}`,
      label: input.event.workflowId,
    })
    input.onAdmitted?.(row.id)
    return { kind: "remote", dispatchId: row.id, targetRef: row.targetRef }
  }

  // A pinned target is an operator decision, not a best-effort candidate.
  // Persist the occurrence before attempting transport so an offline Host or
  // a temporarily stale deployment cannot make cron/webhook events disappear.
  // The receiver still validates the exact immutable digest on every retry.
  const localHostRef = deps.localHostRef()
  if (constraint.mode === "pinned") {
    if (constraint.ref === "local" || constraint.ref === localHostRef) {
      const execution = await deps.executeLocal(localExecutionInput(input))
      return { kind: "local", runId: execution.runId }
    }
    return enqueueRemoteHandoff(constraint.ref)
  }

  const now = deps.now()
  const localActiveUnits = await deps.getLocalActiveUnits(input.event.workflowId)
  const local: WorkflowHostCandidate = {
    ref: localHostRef,
    kind: "local",
    liveness: { online: true, lastSeenAt: now, source: "local" },
    provides: [],
    activeUnits: localActiveUnits,
    maxUnits: Math.max(1, resolved.version.definition.settings.concurrency),
    deploymentDigest: resolved.version.digest,
  }
  const refs = await deps.listRemoteHosts()
  const remoteCandidates = await Promise.all(
    refs.map(async ({ ref }): Promise<WorkflowHostCandidate> => {
      try {
        const probe = await deps.probeRemote(ref, {
          deploymentId: resolved.deployment.id,
          expectedVersionDigest: resolved.version.digest,
        })
        return {
          ref,
          kind: "remote-host",
          liveness: { online: true, lastSeenAt: now, source: "request" },
          provides: [],
          activeUnits: Math.max(0, probe.activeUnits),
          maxUnits: Math.max(1, probe.maxUnits),
          deploymentDigest: probe.deploymentDigest ?? null,
        }
      } catch {
        return {
          ref,
          kind: "remote-host",
          liveness: { online: false, lastSeenAt: 0, source: "request" },
          provides: [],
          activeUnits: 0,
          maxUnits: 1,
          deploymentDigest: null,
        }
      }
    })
  )
  const selection = selectWorkflowHost({
    constraint,
    candidates: [local, ...remoteCandidates],
    expectedDeploymentDigest: resolved.version.digest,
    now,
  })

  if (selection.candidate.kind === "local") {
    const execution = await deps.executeLocal(localExecutionInput(input))
    return { kind: "local", runId: execution.runId }
  }

  return enqueueRemoteHandoff(selection.candidate.ref)
}
