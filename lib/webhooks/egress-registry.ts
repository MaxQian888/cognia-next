/**
 * Outbound egress registry.
 *
 * Any subsystem (scheduler, goal, workflow, team, plan) can `publishOutboundEvent`
 * a lifecycle event; the engine fans it out to every enabled egress endpoint
 * configured in the webhook store, signing each delivery with the global
 * Standard Webhooks secret resolved by the shared secure-storage authority.
 */

import { endpointSubscribesTo, type OutboundWebhookEvent } from "@/types/webhooks"
import { useWebhookStore } from "@/stores/webhooks/store"
import { getWebhookSigningSecret } from "./signing-secret"
import { deliverWebhook, mergeWebhookHeaders, type DeliverResult } from "./delivery"
import { appendWebhookAudit } from "./audit"

export interface PublishResult {
  endpointId: string
  result: DeliverResult
}

export async function publishOutboundEvent(event: OutboundWebhookEvent): Promise<PublishResult[]> {
  const outbound = useWebhookStore.getState().config
  // Fan out only to enabled endpoints whose subscription filter matches this
  // event type (empty filter = all events, GitHub/Svix-style).
  const endpoints = outbound.endpoints.filter(
    (e) => e.enabled && endpointSubscribesTo(e, event.eventType)
  )
  if (endpoints.length === 0) return []

  const signingSecret = await getWebhookSigningSecret()
  if (outbound.hasSigningSecret && !signingSecret) {
    throw new Error("configured webhook signing secret is unavailable")
  }

  const out: PublishResult[] = []
  for (const endpoint of endpoints) {
    const result = await deliverWebhook({
      endpoint: {
        ...endpoint,
        headers: mergeWebhookHeaders(outbound.defaultHeaders, endpoint.headers),
      },
      event,
      signingSecret: signingSecret ?? undefined,
      limits: outbound.delivery,
    })
    out.push({ endpointId: endpoint.id, result })
    void appendWebhookAudit({
      direction: "outbound",
      kind: result.ok ? "outbound.delivered" : "outbound.failed",
      result: result.ok ? "delivered" : "failed",
      endpointId: endpoint.id,
      httpStatus: result.httpStatus,
      fields: { eventType: event.eventType, source: event.source },
    }).catch(() => {})
  }
  return out
}
