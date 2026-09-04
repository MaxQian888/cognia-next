/**
 * Which installations does this event reach, and how should each delivery be
 * scheduled?
 *
 * Pure. No clock beyond the `now` the caller passes, no database, no side
 * effects. The caller owns enqueueing, which keeps the routing rules testable
 * against fixtures and keeps the one place that writes rows small enough to
 * read.
 *
 * The trigger index is derived from installations rather than stored. A table
 * would need to be kept in step with every installation edit, and an index
 * that disagrees with the installations it indexes is a Bot that fires when it
 * should not, which is the failure mode with no error message.
 */

import type { BotEventEnvelopeV1, BotEventSource } from "@/types/bot/event"
import type { PluginBotPolicyV1, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

import { interpolateEnvelopeTemplate } from "./envelope"
import { evaluateBotLoopGuard, type BotLoopVerdict } from "./provenance"

/** One armed trigger belonging to one installation. */
export interface BotTriggerBinding {
  installationId: string
  trigger: PluginBotTriggerDef
  /** The already-resolved ceiling, for the self-trigger opt-in. */
  policy?: PluginBotPolicyV1
  /** Connector adapter this installation is bound to, when it has one. */
  adapterId?: string
  /** Integration account this installation is bound to, when it has one. */
  integrationAccountId?: string
}

export interface BotRouteQuery {
  source: BotEventSource
  type: string
  adapterId?: string
  integrationAccountId?: string
}

/**
 * Does this binding accept an event of this shape?
 *
 * Kind-specific, because the kinds answer genuinely different questions. An
 * `event` trigger matches on source and type. An `interaction` trigger matches
 * connector inbound and optionally narrows to adapter types. A `schedule`,
 * `poll` or `derivedState` trigger is fired BY its own producer and is never
 * matched from an inbound event, which is why they answer false here rather
 * than matching everything.
 */
export function triggerMatches(binding: BotTriggerBinding, query: BotRouteQuery): boolean {
  const trigger = binding.trigger

  if (binding.adapterId && query.adapterId && binding.adapterId !== query.adapterId) return false
  if (
    binding.integrationAccountId &&
    query.integrationAccountId &&
    binding.integrationAccountId !== query.integrationAccountId
  ) {
    return false
  }

  switch (trigger.kind) {
    case "event":
      return trigger.source === query.source && trigger.types.includes(query.type)
    case "interaction":
      if (query.source !== "connector") return false
      if (!trigger.adapterTypes || trigger.adapterTypes.length === 0) return true
      return query.adapterId !== undefined && trigger.adapterTypes.includes(query.adapterId)
    case "manual":
      return query.source === "manual"
    case "schedule":
    case "poll":
    case "derivedState":
      // Fired by the scheduler, never matched from an inbound event.
      return false
  }
}

/** A delivery the caller should enqueue. */
export interface RoutedBotDelivery {
  installationId: string
  triggerId: string
  envelope: BotEventEnvelopeV1
  /** At most one delivery per key runs at a time. */
  concurrencyKey?: string
  /** Hold the delivery until this instant, for a debounced trigger. */
  notBefore?: number
}

/** A binding the event reached but that refused it, and why. */
export interface RejectedBotDelivery {
  installationId: string
  triggerId: string
  reason: Extract<BotLoopVerdict, { allowed: false }>["reason"]
}

export interface BotRouteResult {
  deliveries: RoutedBotDelivery[]
  rejected: RejectedBotDelivery[]
}

export interface RouteBotEventInput {
  /**
   * The envelope, with `installationId` and `triggerId` unset. Routing is what
   * decides those, and one event legitimately becomes several deliveries.
   */
  envelope: Omit<BotEventEnvelopeV1, "installationId" | "triggerId" | "deliveryId">
  bindings: readonly BotTriggerBinding[]
  query: BotRouteQuery
  now?: number
}

/**
 * Fan one event out to every binding that accepts it.
 *
 * A binding the loop guard refuses is reported rather than dropped, because
 * "the Bot ignored my comment" and "the Bot refused to answer itself" look
 * identical from outside and only one of them is a bug.
 */
export function routeBotEvent(input: RouteBotEventInput): BotRouteResult {
  const now = input.now ?? Date.now()
  const deliveries: RoutedBotDelivery[] = []
  const rejected: RejectedBotDelivery[] = []

  for (const binding of input.bindings) {
    if (!triggerMatches(binding, input.query)) continue

    const envelope: BotEventEnvelopeV1 = {
      ...input.envelope,
      installationId: binding.installationId,
      triggerId: binding.trigger.id,
      deliveryId: `bdl_${binding.installationId}_${input.envelope.eventId}`,
    }

    const verdict = evaluateBotLoopGuard({
      envelope,
      installationId: binding.installationId,
      allowSelfTriggering: binding.policy?.allowSelfTriggering,
    })
    if (!verdict.allowed) {
      rejected.push({
        installationId: binding.installationId,
        triggerId: binding.trigger.id,
        reason: verdict.reason,
      })
      continue
    }

    const rawKey = binding.trigger.concurrencyKey
    const concurrencyKey = rawKey
      ? `${binding.installationId}::${interpolateEnvelopeTemplate(rawKey, envelope)}`
      : undefined
    const debounce = binding.trigger.debounceMs

    deliveries.push({
      installationId: binding.installationId,
      triggerId: binding.trigger.id,
      envelope,
      ...(concurrencyKey ? { concurrencyKey } : {}),
      ...(debounce && debounce > 0 ? { notBefore: now + debounce } : {}),
    })
  }

  return { deliveries, rejected }
}
