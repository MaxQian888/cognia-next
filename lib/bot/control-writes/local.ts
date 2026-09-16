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
import { isRunnableBot, resolveInstalledBot } from "@/lib/bot/installed-bot"
import {
  getBotInstallation,
  isBotTriggerArmed,
  updateBotInstallation,
} from "@/lib/db/bot-installations"
import { getBotDelivery, replayBotDelivery } from "@/lib/db/bot-event-deliveries"
import { getExecutionRun } from "@/lib/db/execution-runs"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import { getDb } from "@/lib/db/schema"
import { runBotLifecycleHook } from "./lifecycle-hooks"

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

export class BotDeliveryReplayUnavailableError extends Error {
  readonly code = "bot_delivery_replay_unavailable"
  constructor(readonly deliveryId: string) {
    super(
      "Bot retry requires an enabled, locally owned installation with its current definition and original execution available"
    )
    this.name = "BotDeliveryReplayUnavailableError"
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

  // `onArm` may veto the arm/disarm before the override lands. It fires for
  // BOTH directions — `ctx.bots.setTriggerArmed` flows through here too, so
  // a Bot disarming itself still sees `onArm(armed: false)`.
  if (resolved) {
    await runBotLifecycleHook({
      installation,
      definition: resolved.definition,
      phase: "onArm",
      trigger: { id: input.triggerId, armed: input.armed },
    })
  }

  const next = await updateBotInstallation(input.installationId, {
    ...(input.armed && installation.activatedAt === undefined ? { activatedAt: Date.now() } : {}),
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
 * Retry through the existing queue. A terminal execution gets one deterministic
 * successor delivery; a duplicate command finds that same successor. Further
 * retries target the successor, never reopen the old journal or its approvals.
 * A dead letter whose execution is still resumable keeps its original identity.
 */
export async function replayBotDeliveryLocally(deliveryId: string): Promise<boolean> {
  const db = getDb()
  return db.transaction(
    "rw",
    [db.botEventDeliveries, db.botInstallations, db.botDefinitions, db.executionRuns],
    async () => {
      const row = await getBotDelivery(deliveryId)
      if (!row) throw new BotControlTargetMissingError("delivery", deliveryId)
      if (row.syncedFromHost) throw new BotDeliveryReplayUnavailableError(deliveryId)
      if (!["deadletter", "dismissed", "failed"].includes(row.status)) return false
      const installation = await getBotInstallation(row.installationId)
      if (!installation || installation.syncedFromHost)
        throw new BotDeliveryReplayUnavailableError(deliveryId)
      const resolved = await resolveInstalledBot(installation)
      if (!resolved || !isRunnableBot(resolved) || resolved.problems.length)
        throw new BotDeliveryReplayUnavailableError(deliveryId)
      if (!resolved.definition.triggers.some((trigger) => trigger.id === row.triggerId))
        throw new BotControlTargetMissingError("trigger", row.triggerId)
      const run = row.runId ? await getExecutionRun(row.runId) : undefined
      if (row.runId && (!run || run.kind !== "bot" || run.sourceId !== installation.id))
        throw new BotDeliveryReplayUnavailableError(deliveryId)
      if (run?.status === "completed") return false
      if (run && (run.status === "failed" || run.status === "cancelled")) {
        const envelope = buildBotEventEnvelope({
          ...row.envelope,
          sourceRecordId: `retry:${row.id}`,
          triggerId: row.triggerId,
          installationId: installation.id,
          actor: { kind: "human" },
          receivedAt: Date.now(),
          correlation: undefined,
          provenance: {
            selfProduced: false,
            depth: 0,
            causationEventIds: [
              row.eventId,
              ...(row.envelope.provenance.causationEventIds ?? []),
            ].slice(0, 16),
          },
        })
        if (await getBotDelivery(envelope.deliveryId)) return false
        await dispatchManualBotRun({ resolved, triggerId: row.triggerId, envelope })
        return true
      }
      if (row.status !== "deadletter") return false
      await replayBotDelivery(deliveryId)
      return true
    }
  )
}

export { isBotTriggerArmed }
