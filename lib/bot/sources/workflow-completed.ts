/**
 * A workflow reaching a terminal state becomes a Bot event.
 *
 * The workflow plane already owns the hard parts here: it caps chain depth, it
 * isolates each match, and it fires the fan-out without awaiting it. This
 * adapter joins that fan-out as one more consumer rather than adding a second
 * emission point.
 */

import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { dispatchBotEvent, type DispatchBotEventResult } from "@/lib/bot/events/dispatch"
import { externalProvenance } from "@/lib/bot/events/provenance"

/** Dotted type a `source: "workflow"` trigger matches. */
export function workflowEventType(status: "succeeded" | "failed"): string {
  return `workflow.${status}`
}

export interface DispatchWorkflowCompletedToBotsInput {
  workflowId: string
  workflowName: string
  runId: string
  status: "succeeded" | "failed"
  output?: unknown
}

/** Project one finished workflow run onto the Bot plane. */
export async function dispatchWorkflowCompletedToBots(
  input: DispatchWorkflowCompletedToBotsInput
): Promise<DispatchBotEventResult> {
  const now = Date.now()
  const type = workflowEventType(input.status)
  const envelope = buildBotEventEnvelope({
    source: "workflow",
    // The run is the event. A second fan-out of the same terminal state is a
    // redelivery, not a new thing that happened.
    sourceRecordId: input.runId,
    type,
    installationId: "",
    triggerId: "",
    occurredAt: now,
    receivedAt: now,
    payload: {
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      runId: input.runId,
      status: input.status,
      ...(input.output !== undefined ? { output: input.output } : {}),
    },
    // A workflow run is a machine, not a person. `externalProvenance` rather
    // than a Bot-output block: unless a Bot run produced it, this is not
    // something the loop guard should treat as an echo of its own work.
    provenance: externalProvenance(),
    actor: { kind: "system", id: input.workflowId, displayName: input.workflowName },
    resource: { kind: "workflow_run", id: input.runId, scope: input.workflowId },
  })

  const { installationId: _i, triggerId: _t, deliveryId: _d, ...routable } = envelope

  return dispatchBotEvent({ envelope: routable, query: { source: "workflow", type }, now })
}
