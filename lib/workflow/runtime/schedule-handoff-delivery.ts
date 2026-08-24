import { recordHostDispatchRemoteRun } from "@/lib/db/host-dispatch-queue"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
import {
  HostDispatchDeliveryError,
  registerHostDispatchDelivery,
  type HostDispatchDelivery,
} from "@/lib/placement/host-dispatch-delivery"
import type { Transport } from "@/lib/tauri/transport-types"
import type { TriggerEvent } from "@/types/workflow/visual"

export interface WorkflowScheduleHandoffPayload extends Record<string, unknown> {
  deploymentId: string
  expectedVersionDigest: string
  trigger: TriggerEvent
}

export interface ScheduleHandoffDeliveryDeps {
  openTarget?: (targetRef: string) => Promise<{
    transport: Pick<Transport, "call">
    close: () => void
  }>
  /** Persist the run the target minted. Injected only so tests avoid Dexie. */
  recordRemoteRun?: (dispatchId: string, remoteRunId: string) => Promise<void>
}

function isHandoffPayload(value: unknown): value is WorkflowScheduleHandoffPayload {
  if (!value || typeof value !== "object") return false
  const payload = value as Record<string, unknown>
  const trigger = payload.trigger
  if (!trigger || typeof trigger !== "object") return false
  const event = trigger as Record<string, unknown>
  return (
    typeof payload.deploymentId === "string" &&
    payload.deploymentId.length > 0 &&
    typeof payload.expectedVersionDigest === "string" &&
    payload.expectedVersionDigest.length > 0 &&
    typeof event.workflowId === "string" &&
    event.workflowId.length > 0 &&
    typeof event.kind === "string" &&
    typeof event.originAt === "number"
  )
}

/** Deliver one durable top-level trigger to the selected execution Host. */
export function createScheduleHandoffDelivery(
  deps: ScheduleHandoffDeliveryDeps = {}
): HostDispatchDelivery {
  const openTarget = deps.openTarget ?? openRemoteHostTarget
  const recordRemoteRun = deps.recordRemoteRun ?? recordHostDispatchRemoteRun
  return async (job) => {
    if (
      job.domain !== "schedule-handoff" ||
      job.kind !== "workflow.trigger" ||
      !isHandoffPayload(job.payload)
    ) {
      throw new HostDispatchDeliveryError(
        "malformed",
        false,
        "schedule-handoff payload is malformed"
      )
    }

    let target: Awaited<ReturnType<typeof openTarget>> | undefined
    try {
      target = await openTarget(job.targetRef)
      const accepted = await target.transport.call<{ runId?: unknown }>(
        "workflow_handoff_create",
        {
          deploymentId: job.payload.deploymentId,
          expectedVersionDigest: job.payload.expectedVersionDigest,
          idempotencyKey: job.idempotencyKey,
          trigger: job.payload.trigger,
        },
        { idempotencyKey: job.idempotencyKey }
      )
      // The source keeps a pointer, never a mirror of the remote journal: one
      // run has one event log, and it lives on the Host that is executing it.
      const remoteRunId = typeof accepted?.runId === "string" ? accepted.runId : undefined
      if (remoteRunId) {
        try {
          await recordRemoteRun(job.id, remoteRunId)
        } catch {
          // A lost pointer costs the Runs surface a link, not the run itself.
        }
      }
      return "succeeded"
    } catch (error) {
      throw new HostDispatchDeliveryError(
        "handoff_failed",
        true,
        `workflow handoff failed: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      target?.close()
    }
  }
}

export function registerScheduleHandoffDelivery(
  deps: ScheduleHandoffDeliveryDeps = {}
): () => void {
  return registerHostDispatchDelivery("schedule-handoff", createScheduleHandoffDelivery(deps))
}
