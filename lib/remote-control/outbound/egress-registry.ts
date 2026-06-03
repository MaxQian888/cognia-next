/**
 * Outbound egress registry.
 *
 * Any subsystem (scheduler, goal, workflow, team, plan) can `publishOutboundEvent`
 * a lifecycle event; the engine fans it out to every enabled egress endpoint
 * configured in the remote-control store, signing each delivery with the global
 * Standard Webhooks secret (resolved from the OS keyring on desktop).
 */

import type { OutboundWebhookEvent } from "@/types/remote-control"
import { useRemoteControlStore } from "@/stores/remote-control/store"
import { isTauri } from "@/lib/tauri"
import { remoteControlGetSigningSecret } from "@/lib/tauri/remote-control"
import { deliverWebhook, type DeliverResult } from "./delivery"
import { appendRemoteControlAudit } from "@/lib/db/remote-control-audit"

export interface PublishResult {
  endpointId: string
  result: DeliverResult
}

export async function publishOutboundEvent(event: OutboundWebhookEvent): Promise<PublishResult[]> {
  const endpoints = useRemoteControlStore
    .getState()
    .config.outbound.endpoints.filter((e) => e.enabled)
  if (endpoints.length === 0) return []

  const signingSecret = isTauri()
    ? ((await remoteControlGetSigningSecret().catch(() => null)) ?? undefined)
    : undefined

  const out: PublishResult[] = []
  for (const endpoint of endpoints) {
    const result = await deliverWebhook({ endpoint, event, signingSecret })
    out.push({ endpointId: endpoint.id, result })
    void appendRemoteControlAudit({
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
