/**
 * The Bot control writes, executed against THIS process's database.
 *
 * Every one of them goes through the domain's own mutator rather than touching
 * Dexie directly. `updateBotInstallation` re-derives the installation status
 * and reconciles the scheduler rows for its timed triggers, and a raw
 * `botInstallations.put` here would arm a cron trigger that no scheduler row
 * ever fires. Those side effects are exactly what a remote caller must get
 * too, which is why the host arm of the relay calls these same functions.
 */

import { dispatchManualBotRun } from "@/lib/bot/events/dispatch"
import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { resolveInstalledBot } from "@/lib/bot/installed-bot"
import {
  getBotInstallation,
  isBotTriggerArmed,
  updateBotInstallation,
} from "@/lib/db/bot-installations"
import { getBotDelivery, replayBotDelivery } from "@/lib/db/bot-event-deliveries"
import type { BotInstallationRow } from "@/lib/db/bot-types"

/** The event type a manual run carries. Named so a handler can branch on it. */
export const MANUAL_RUN_EVENT_TYPE = "manual.run"

export class BotControlTargetMissingError extends Error {
  readonly code = "bot_control_target_missing"
  constructor(
    readonly what: "installation" | "trigger" | "delivery",
    readonly id: string
  ) {
    super(`bot control target missing: no ${what} "${id}"`)
    this.name = "BotControlTargetMissingError"
  }
}

export interface SetTriggerArmedInput {
  installationId: string
  triggerId: string
  armed: boolean
}

/**
 * Arm or disarm one trigger.
 *
 * "Set to a value", never "toggle". The relay replays a queued command after a
 * reconnect, and an arm/disarm/arm sequence replayed as three toggles leaves
 * the Host disarmed. As three absolute writes it lands on armed, which is what
 * the user last asked for.
 *
 * The trigger has to exist on the resolved definition. Writing an override for
 * a trigger id that is not there would be silently inert, and silently inert
 * is the failure this whole console exists to stop producing.
 */
export async function setBotTriggerArmedLocally(
  input: SetTriggerArmedInput
): Promise<BotInstallationRow> {
  const installation = await getBotInstallation(input.installationId)
  if (!installation) {
    throw new BotControlTargetMissingError("installation", input.installationId)
  }

  const resolved = await resolveInstalledBot(installation)
  const trigger = resolved?.definition.triggers.find((t) => t.id === input.triggerId)
  if (!trigger) throw new BotControlTargetMissingError("trigger", input.triggerId)

  const next = await updateBotInstallation(input.installationId, {
    triggerOverrides: { ...(installation.triggerOverrides ?? {}), [input.triggerId]: input.armed },
    // Re-evaluated so a Bot that was `needs_setup` does not silently become
    // `enabled` just because a trigger moved. `updateBotInstallation` only
    // re-runs the status when it is handed the slots to check against.
    ...(resolved?.definition.requires?.credentials
      ? { requiredCredentials: resolved.definition.requires.credentials }
      : {}),
  })
  if (!next) throw new BotControlTargetMissingError("installation", input.installationId)
  return next
}

export interface RunBotManuallyInput {
  installationId: string
  /** The `manual` trigger to attribute the run to. Defaults to the first one. */
  triggerId?: string
  /** Free-form input the handler receives as the event payload. */
  input?: unknown
  /**
   * Distinguishes a second run from a retry of the first.
   *
   * The envelope's event id is derived from it, and `botDeliveryDedupKey`
   * folds a redelivery of the same event onto one row, so a replayed relay
   * command produces one run and two presses of the button produce two.
   */
  idempotencyKey: string
}

export interface RunBotManuallyResult {
  deliveryId: string
  /**
   * False when the delivery already existed, which is what a replayed relay
   * command produces. `enqueueBotDelivery` folds a redelivery of the same
   * event id onto one row, so the second press of a retried command is a
   * no-op rather than a second run.
   */
  created: boolean
}

/**
 * Start one run by hand.
 *
 * Through `dispatchBotEvent`, never `runBotDelivery`. A direct run would skip
 * the delivery queue, and with it the lease, the concurrency key and the
 * retry policy, so a manual press during a busy period would run a second copy
 * of work the queue was deliberately serialising.
 */
export async function runBotManuallyLocally(
  input: RunBotManuallyInput
): Promise<RunBotManuallyResult> {
  const installation = await getBotInstallation(input.installationId)
  if (!installation) {
    throw new BotControlTargetMissingError("installation", input.installationId)
  }
  const resolved = await resolveInstalledBot(installation)
  if (!resolved) throw new BotControlTargetMissingError("installation", input.installationId)

  // The named trigger, or the definition's own manual one. Falling back to
  // "the first trigger of any kind" would start a schedule's work under a
  // payload it was never written to read.
  const trigger = input.triggerId
    ? resolved.definition.triggers.find((t) => t.id === input.triggerId)
    : resolved.definition.triggers.find((t) => t.kind === "manual")
  if (!trigger) throw new BotControlTargetMissingError("trigger", input.triggerId ?? "manual")

  const envelope = buildBotEventEnvelope({
    source: "bot",
    sourceRecordId: input.idempotencyKey,
    type: MANUAL_RUN_EVENT_TYPE,
    installationId: installation.id,
    triggerId: trigger.id,
    occurredAt: Date.now(),
    payload: input.input ?? {},
    actor: { kind: "human" },
    // A person pressing Run is not the Bot answering itself. The source is
    // `bot` because the control plane produced the record, and leaving
    // `selfProduced` true would have the loop guard refuse every manual run.
    provenance: { selfProduced: false, depth: 0 },
  })

  const row = await dispatchManualBotRun({ resolved, triggerId: trigger.id, envelope })
  return { deliveryId: row.id, created: row.eventId === envelope.eventId && row.attempts === 0 }
}

/**
 * Put a dead-lettered delivery back on the queue.
 *
 * Guarded on the row still being dead-lettered, which is what makes a replayed
 * relay command a no-op rather than a second run: once the first replay
 * succeeds the row is no longer `deadletter`, and the duplicate finds nothing
 * to do. `replayBotDelivery` writes absolute values and never increments, so
 * the attempt budget is reset rather than consumed.
 */
export async function replayBotDeliveryLocally(deliveryId: string): Promise<boolean> {
  const row = await getBotDelivery(deliveryId)
  if (!row) throw new BotControlTargetMissingError("delivery", deliveryId)
  if (row.status !== "deadletter") return false
  await replayBotDelivery(deliveryId)
  return true
}

export { isBotTriggerArmed }
