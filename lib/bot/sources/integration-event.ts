/**
 * Integration events become Bot events.
 *
 * This is the path a verified webhook takes. `publishIntegrationEvent` has
 * already checked the signature in Rust, deduplicated the delivery, and
 * written the durable row, so nothing here re-does any of it: the adapter
 * projects that record onto the source-neutral envelope and hands it to the
 * router.
 *
 * Deliberately best-effort. An integration event has other consumers (workflow
 * triggers, inbox projections) and a Bot that cannot be routed must not take
 * them down with it.
 */

import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { dispatchBotEvent, type DispatchBotEventResult } from "@/lib/bot/events/dispatch"
import { externalProvenance } from "@/lib/bot/events/provenance"
import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"

function epochMs(value: string, fallback: number): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Project one integration event onto the Bot plane.
 *
 * The account id is carried as the routing key so an installation bound to one
 * GitHub account never sees another's events, which is the difference between
 * two teams sharing a Cognia install and two teams reading each other's pull
 * requests.
 */
export async function dispatchIntegrationEventToBots(
  event: IntegrationEventEnvelope
): Promise<DispatchBotEventResult> {
  const now = Date.now()
  const envelope = buildBotEventEnvelope({
    source: "integration",
    // The provider's own delivery id, which is what makes a redelivery the
    // same event rather than a new one.
    sourceRecordId: `${event.pluginId}:${event.deliveryId}`,
    type: event.eventType,
    // Routing decides the real values. These are placeholders the router
    // overwrites per recipient.
    installationId: "",
    triggerId: "",
    occurredAt: epochMs(event.occurredAt, now),
    receivedAt: epochMs(event.receivedAt, now),
    payload: event.payload,
    binding: { integrationAccountId: event.accountId },
    provenance: externalProvenance(),
    ...(event.actor
      ? {
          actor: {
            // A webhook tells us who acted on the far side, not who they are
            // here. `principalId` stays unset, so nothing downstream mistakes
            // this for a verified Cognia identity.
            kind: "human" as const,
            id: event.actor.id,
            ...(event.actor.label ? { displayName: event.actor.label } : {}),
          },
        }
      : {}),
    ...(event.resource
      ? {
          resource: {
            kind: event.resource.kind,
            id: event.resource.id,
            ...(event.resource.url ? { url: event.resource.url } : {}),
            ...(event.resource.parent ? { scope: event.resource.parent.id } : {}),
          },
        }
      : {}),
  })

  const { installationId: _i, triggerId: _t, deliveryId: _d, ...routable } = envelope

  return dispatchBotEvent({
    envelope: routable,
    query: {
      source: "integration",
      type: event.eventType,
      integrationAccountId: event.accountId,
    },
    now,
  })
}
