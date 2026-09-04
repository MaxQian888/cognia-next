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
import { isBotTriggerArmed, listBotInstallations } from "@/lib/db/bot-installations"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import { resolveInstalledBot, isRunnableBot, type InstalledBot } from "@/lib/bot/installed-bot"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

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
      })
    )
  }

  return { enqueued, rejected: routed.rejected, unresolved }
}
