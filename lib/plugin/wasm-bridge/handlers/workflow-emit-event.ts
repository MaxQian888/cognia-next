/**
 * `workflow.emit-event` — hand one trigger event to the workflow runtime.
 *
 * `dispatchPluginTrigger` never throws: every failure mode comes back as
 * `{ ok: false, rejectedReason }`. That makes the success condition explicit
 * and easy to get wrong — a naive `await` followed by `return` would report
 * "delivered" for a muted trigger, an unknown workflow, or an ambiguous node.
 * Only `ok === true` is success here.
 */

import { dispatchPluginTrigger } from "@/lib/plugin/bridge/plugin-trigger-dispatch"

import { WasmBridgeError } from "../errors"
import { MAX_PAYLOAD_BYTES, serializedByteLength } from "../protocol"

export interface WorkflowEmitEventResult {
  ok: true
  prefixedKind: string
}

export async function workflowEmitEvent(
  pluginId: string,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<WorkflowEmitEventResult> {
  const workflowId = payload.workflowId
  const kind = payload.kind
  if (typeof workflowId !== "string" || workflowId.trim() === "") {
    throw new WasmBridgeError(
      "INVALID_REQUEST",
      "workflow.emit-event: `workflowId` must be a non-empty string"
    )
  }
  if (typeof kind !== "string" || kind.trim() === "") {
    throw new WasmBridgeError(
      "INVALID_REQUEST",
      "workflow.emit-event: `kind` must be a non-empty string"
    )
  }
  const triggerId = typeof payload.triggerId === "string" ? payload.triggerId : undefined

  const bytes = serializedByteLength(payload)
  if (bytes === null) {
    throw new WasmBridgeError("INVALID_REQUEST", "workflow.emit-event: payload is not serializable")
  }
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new WasmBridgeError(
      "PAYLOAD_TOO_LARGE",
      `workflow.emit-event: payload is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte limit`
    )
  }

  const result = await dispatchPluginTrigger({
    pluginId,
    workflowId,
    kind,
    payload: payload.payload,
    triggerId,
  })

  if (!result.ok) {
    // The five rejectedReason values go into the message rather than becoming
    // separate codes: they are all "the runtime declined", and a guest that
    // wants to distinguish them can read the text without us growing the
    // stable code vocabulary for one caller.
    throw new WasmBridgeError(
      "WORKFLOW_REJECTED",
      `workflow.emit-event: ${result.rejectedReason ?? "rejected"} (${result.prefixedKind})`
    )
  }

  if (signal.aborted) {
    // The event did land, but nobody is listening for the answer any more.
    // Surfacing the abort keeps the settle path honest; the registry drops it.
    throw new WasmBridgeError("CANCELLED", "workflow.emit-event: cancelled after dispatch")
  }

  return { ok: true, prefixedKind: result.prefixedKind }
}
