/**
 * The one place an event becomes rows.
 *
 * Everything about WHICH installations an event reaches is in the pure router.
 * What is here is the impure half: read the installations, resolve each one's
 * definition and ceiling, ask the router, and enqueue what it returns.
 *
 * Keeping the two apart is what lets the routing rules be tested against
 * fixtures without a database, and keeps the function that writes rows short
 * enough to read in one go.
 */

import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import { defaultsFromConfigSchema } from "@/lib/bot/config/resolve-effective"
import { isBotTriggerArmed, listBotInstallations } from "@/lib/db/bot-installations"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import { resolveInstalledBot, isRunnableBot, type InstalledBot } from "@/lib/bot/installed-bot"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

import { botDeliveryId, interpolateEnvelopeTemplate } from "./envelope"
import {
  routeBotEvent,
  type BotRouteQuery,
  type BotTriggerBinding,
  type RejectedBotDelivery,
} from "./router"

export interface DispatchBotEventInput {
  /** The envelope minus the fields routing decides. */
  envelope: Omit<BotEventEnvelopeV1, "installationId" | "triggerId" | "deliveryId">
  query: BotRouteQuery
  /** Narrow the candidate installations. Absent means every enabled one. */
  scope?: { workspaceId?: string; projectId?: string }
  organizationPolicy?: PluginBotPolicyV1
  now?: number
}

export interface DispatchBotEventResult {
  enqueued: BotEventDeliveryRow[]
  rejected: RejectedBotDelivery[]
  /** Installations whose definition or handler could not be resolved. */
  unresolved: string[]
}

/**
 * Build the armed-trigger bindings for one resolved installation.
 *
 * A disarmed trigger produces no binding at all rather than a binding the
 * router later drops, so "this trigger is off" never reaches the rejection
 * list, where it would read as a loop guard firing.
 */
export function bindingsForInstalledBot(resolved: InstalledBot): BotTriggerBinding[] {
  const adapterId = firstBoundAdapterId(resolved)
  const integrationAccountId = firstBoundIntegrationAccountId(resolved)
  return resolved.definition.triggers
    .filter((trigger) => isBotTriggerArmed(resolved.installation, trigger))
    .map((trigger) => ({
      installationId: resolved.installation.id,
      config: {
        ...defaultsFromConfigSchema(resolved.definition.configSchema),
        ...resolved.installation.config,
      },
      trigger,
      policy: resolved.policy,
      ...(adapterId ? { adapterId } : {}),
      ...(integrationAccountId ? { integrationAccountId } : {}),
    }))
}

/**
 * The connector adapter this installation is bound to, if any.
 *
 * An installation binds at most one IM account today, so the first slot that
 * names an adapter is the answer. When a Bot needs several, the binding this
 * narrows on becomes per-trigger and this function is what changes.
 */
function firstBoundAdapterId(resolved: InstalledBot): string | undefined {
  for (const binding of Object.values(resolved.installation.credentialBindings)) {
    if (binding.adapterId) return binding.adapterId
  }
  return undefined
}

/** The integration account this installation is bound to, if any. */
function firstBoundIntegrationAccountId(resolved: InstalledBot): string | undefined {
  for (const binding of Object.values(resolved.installation.credentialBindings)) {
    if (binding.integrationAccountId) return binding.integrationAccountId
  }
  return undefined
}

export async function dispatchBotEvent(
  input: DispatchBotEventInput
): Promise<DispatchBotEventResult> {
  const now = input.now ?? Date.now()
  const installations = await listBotInstallations({
    status: "enabled",
    ...(input.scope?.workspaceId ? { workspaceId: input.scope.workspaceId } : {}),
    ...(input.scope?.projectId ? { projectId: input.scope.projectId } : {}),
  })

  const bindings: BotTriggerBinding[] = []
  const unresolved: string[] = []

  for (const installation of installations) {
    const resolved = await resolveInstalledBot(installation, {
      organizationPolicy: input.organizationPolicy,
    })
    if (!resolved || !isRunnableBot(resolved)) {
      unresolved.push(installation.id)
      continue
    }
    bindings.push(...bindingsForInstalledBot(resolved))
  }

  const routed = routeBotEvent({ envelope: input.envelope, bindings, query: input.query, now })

  const enqueued: BotEventDeliveryRow[] = []
  for (const delivery of routed.deliveries) {
    enqueued.push(
      await enqueueBotDelivery({
        envelope: delivery.envelope,
        now,
        ...(delivery.notBefore ? { notBefore: delivery.notBefore } : {}),
        ...(delivery.concurrencyKey ? { concurrencyKey: delivery.concurrencyKey } : {}),
        ...(delivery.holdConcurrencyWhileWaiting !== undefined
          ? { holdConcurrencyWhileWaiting: delivery.holdConcurrencyWhileWaiting }
          : {}),
      })
    )
  }

  return { enqueued, rejected: routed.rejected, unresolved }
}

/**
 * Start one run by hand, on a named installation and trigger.
 *
 * Separate from {@link dispatchBotEvent} rather than a flag on it, because
 * every filter that function applies is one a manual run has to skip, and a
 * `force` option would leave the safe path one boolean away from the unsafe
 * one:
 *
 *  * The candidate list is one installation, already chosen by the person.
 *  * The trigger is named, so the router's `triggerMatches` has nothing to
 *    decide, and it answers `false` for `manual` anyway, on purpose: a manual
 *    trigger is fired by a person, never by an arriving event.
 *  * A disarmed trigger still runs. Pressing Run IS the arming, for this once.
 *
 * What it does NOT skip is the queue. The delivery is enqueued exactly like
 * any other, so the lease, the concurrency key and the retry policy all apply.
 * A manual press during a busy period therefore waits behind the event-driven
 * run holding the same key instead of racing it, which is the whole reason
 * this goes through `enqueueBotDelivery` rather than straight to the runner.
 */
export interface DispatchManualBotRunInput {
  resolved: InstalledBot
  triggerId: string
  envelope: Omit<BotEventEnvelopeV1, "installationId" | "triggerId" | "deliveryId">
  now?: number
}

export async function dispatchManualBotRun(
  input: DispatchManualBotRunInput
): Promise<BotEventDeliveryRow> {
  const trigger = input.resolved.definition.triggers.find((t) => t.id === input.triggerId)
  if (!trigger) {
    throw new Error(`bot trigger "${input.triggerId}" is not declared by this definition`)
  }

  const installationId = input.resolved.installation.id
  const envelope: BotEventEnvelopeV1 = {
    ...input.envelope,
    installationId,
    triggerId: trigger.id,
    deliveryId: botDeliveryId(input.envelope.eventId, installationId),
  }

  // Interpolated the same way the router does it, and scoped per installation
  // for the same reason: a manual run that ignored the key would run beside
  // the very delivery the key exists to serialise it against.
  const rawKey = trigger.concurrencyKey
  const concurrencyKey = rawKey
    ? `${installationId}::${interpolateEnvelopeTemplate(rawKey, envelope)}`
    : undefined

  return enqueueBotDelivery({
    envelope,
    ...(concurrencyKey ? { concurrencyKey } : {}),
    ...(trigger.holdConcurrencyWhileWaiting !== undefined
      ? { holdConcurrencyWhileWaiting: trigger.holdConcurrencyWhileWaiting }
      : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  })
}
