import {
  STEP_EXECUTE_CHANNEL,
  STEP_PENDING_PUSH_CHANNEL,
  type RemoteStepRequest,
} from "./remote-step-protocol"
import { emitCompanionEvent } from "./companion-run-events"
import {
  HostDispatchDeliveryError,
  registerHostDispatchDelivery,
  type HostDispatchDelivery,
} from "@/lib/placement/host-dispatch-delivery"

export interface MobileStepDeliveryDeps {
  emit?: (event: string, payload: unknown) => Promise<void>
}

/** Register the existing Companion event-bus protocol as mobile-step delivery. */
export function createMobileStepHostDelivery(
  deps: MobileStepDeliveryDeps = {}
): HostDispatchDelivery {
  const emit = deps.emit ?? emitCompanionEvent
  return async (job) => {
    const request = job.payload as unknown as RemoteStepRequest
    if (
      request.requestId !== job.id ||
      request.targetDeviceId !== job.targetRef ||
      typeof request.timeoutAt !== "number"
    ) {
      throw new HostDispatchDeliveryError("malformed", false, "mobile-step payload is malformed")
    }
    try {
      await emit(STEP_EXECUTE_CHANNEL, request)
      await emit(STEP_PENDING_PUSH_CHANNEL, {
        requestId: request.requestId,
        runId: request.runId,
        workflowId: request.workflowId,
        targetDeviceId: request.targetDeviceId,
      })
      return "awaiting-result"
    } catch (error) {
      throw new HostDispatchDeliveryError(
        "dispatch_failed",
        true,
        `mobile-step dispatch failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

export function registerMobileStepHostDelivery(deps: MobileStepDeliveryDeps = {}): () => void {
  return registerHostDispatchDelivery("mobile-step", createMobileStepHostDelivery(deps))
}
