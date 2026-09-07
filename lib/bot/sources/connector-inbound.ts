/**
 * Connector inbound becomes Bot events.
 *
 * This is the seam between the two planes that share the word "bot". The IM
 * connector has its own eleven ways of handling a message and its own three
 * admission gates, and none of that is duplicated here. By the time this runs
 * the message has already been persisted, admitted, policy-matched and routed,
 * so what is projected is a decision the connector has already made.
 *
 * A Bot is a FAN-OUT CONSUMER, not a fourth execution target. `ImTargetKind`
 * stays `direct | team | workflow` because it answers "who runs this turn", and
 * an `interaction`-trigger Bot is an observer of a turn that was already
 * routed, exactly like a workflow trigger subscription.
 *
 * Deliberately best-effort. Inbound has other consumers and a Bot that cannot
 * be routed must not take a conversation down with it.
 */

import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { dispatchBotEvent, type DispatchBotEventResult } from "@/lib/bot/events/dispatch"
import { externalProvenance } from "@/lib/bot/events/provenance"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

/** The one event type an `interaction` trigger matches. */
export const CONNECTOR_INBOUND_EVENT_TYPE = "connector.inbound"

/**
 * What a Bot is handed about a message.
 *
 * A projection, not the whole event. `raw` is the platform's own payload and
 * carries far more than a Bot needs, and this row is persisted, so the
 * narrowest useful shape is the right one. Segments and text come across
 * because they are what the message SAYS, which is the point.
 */
function payloadOf(event: NormalizedInboundEvent) {
  return {
    platform: event.platform,
    conversationKey: event.conversationKey,
    messageId: event.messageId,
    plainText: event.plainText,
    segments: event.segments,
    channelKind: event.channel.kind,
    selfMentioned: event.mentions.selfMentioned,
    ...(event.replyTo ? { replyToMessageId: event.replyTo.messageId } : {}),
  }
}

export interface DispatchConnectorInboundToBotsInput {
  event: NormalizedInboundEvent
  /** The workspace the conversation belongs to, when it has one. */
  projectId?: string
}

/**
 * Project one inbound message onto the Bot plane.
 *
 * The adapter INSTANCE is the routing key, so an installation bound to one
 * workspace's Slack never sees another's messages. The PLATFORM travels beside
 * it because `PluginBotInteractionTrigger.adapterTypes` narrows by platform,
 * which is a different question from which account it arrived on.
 */
export async function dispatchConnectorInboundToBots(
  input: DispatchConnectorInboundToBotsInput
): Promise<DispatchBotEventResult> {
  const now = Date.now()
  const event = input.event
  const envelope = buildBotEventEnvelope({
    source: "connector",
    // The platform's own message id, scoped to the adapter, so a redelivery is
    // the same event rather than a new one.
    sourceRecordId: `${event.adapterId}:${event.messageId}`,
    type: CONNECTOR_INBOUND_EVENT_TYPE,
    // Routing decides the real values, overwriting these per recipient.
    installationId: "",
    triggerId: "",
    occurredAt: event.timestamp,
    receivedAt: now,
    payload: payloadOf(event),
    binding: {
      adapterId: event.adapterId,
      conversationKey: event.conversationKey,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    provenance: externalProvenance(),
    actor: {
      // The adapter's own classification when it made one. A sibling bot's
      // message reaching a Bot as `human` would be a loop the provenance guard
      // cannot see, because it looks only at what Cognia produced.
      kind: event.sender.kind ?? "human",
      id: event.sender.remoteUserId,
      ...(event.sender.displayName ? { displayName: event.sender.displayName } : {}),
      // No `principalId`. The connector knows who sent this on the platform,
      // not who they are here, and an approval's actor scope is derived from
      // that field.
    },
    resource: {
      kind: "conversation",
      id: event.conversationKey,
      scope: event.platform,
    },
  })

  const { installationId: _i, triggerId: _t, deliveryId: _d, ...routable } = envelope

  return dispatchBotEvent({
    envelope: routable,
    query: {
      source: "connector",
      type: CONNECTOR_INBOUND_EVENT_TYPE,
      adapterId: event.adapterId,
      adapterType: event.platform,
    },
    ...(input.projectId ? { scope: { projectId: input.projectId } } : {}),
    now,
  })
}
