/**
 * Desktop and pet events become Bot events.
 *
 * Both producers already wrap everything in a best-effort try, and both
 * already decide what is safe to carry: the UI-automation trigger runs its
 * window name through the PII gate, and the pet runner projects ids rather
 * than content. That discipline is preserved here by taking an ALREADY
 * SANITISED payload rather than a raw one, so this module cannot become the
 * place a screen title leaks.
 */

import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { dispatchBotEvent, type DispatchBotEventResult } from "@/lib/bot/events/dispatch"
import { externalProvenance } from "@/lib/bot/events/provenance"

export interface DispatchDesktopEventToBotsInput {
  /** Dotted type, for example `desktop.uia` or `desktop.pet`. */
  type: string
  /** A stable id for this occurrence, so a redelivery is the same event. */
  sourceRecordId: string
  /**
   * The payload, ALREADY sanitised by the producer. Nothing here inspects it,
   * which is why the caller must not hand over raw window titles or message
   * bodies.
   */
  payload: Record<string, unknown>
  resourceId?: string
  occurredAt?: number
}

/** Project one desktop occurrence onto the Bot plane. */
export async function dispatchDesktopEventToBots(
  input: DispatchDesktopEventToBotsInput
): Promise<DispatchBotEventResult> {
  const now = Date.now()
  const envelope = buildBotEventEnvelope({
    source: "desktop",
    sourceRecordId: input.sourceRecordId,
    type: input.type,
    installationId: "",
    triggerId: "",
    occurredAt: input.occurredAt ?? now,
    receivedAt: now,
    payload: input.payload,
    provenance: externalProvenance(),
    actor: { kind: "system" },
    ...(input.resourceId ? { resource: { kind: "desktop_event", id: input.resourceId } } : {}),
  })

  const { installationId: _i, triggerId: _t, deliveryId: _d, ...routable } = envelope

  return dispatchBotEvent({
    envelope: routable,
    query: { source: "desktop", type: input.type },
    now,
  })
}
