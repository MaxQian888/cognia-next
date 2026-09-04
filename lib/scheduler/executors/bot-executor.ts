/**
 * `bot` scheduled-task executor.
 *
 * One task type covers all three timed trigger kinds, because they differ only
 * in what the handler does with the tick:
 *
 *   - `schedule`     fires on its cron.
 *   - `poll`         fires on its interval, carrying the stored cursor.
 *   - `derivedState` fires on its interval, carrying the last edge value.
 *
 * The executor does not evaluate anything. It enqueues a delivery for the named
 * installation and trigger, and the ordinary delivery runner takes it from
 * there, which is what keeps a timed run and an event-driven run identical in
 * every way that matters: same lease, same retry, same journal, same approval.
 *
 * Placement follows the scheduler's own rule (ADR-0128): every Host owns its
 * schedule, and this executor runs wherever the task does.
 */

import type { ScheduledTask, TaskExecution, TaskExecutorResult } from "@/types/scheduler"

export interface BotTaskPayload extends Record<string, unknown> {
  installationId: string
  triggerId: string
}

export async function executeBotTask(
  task: ScheduledTask,
  _execution: TaskExecution,
  signal: AbortSignal
): Promise<TaskExecutorResult> {
  const payload = (task.payload ?? {}) as Partial<BotTaskPayload>
  const installationId = payload.installationId?.trim()
  const triggerId = payload.triggerId?.trim()
  if (!installationId || !triggerId) {
    return {
      success: false,
      error: 'A "bot" task needs both an installationId and a triggerId in its payload',
      terminalReason: "executor-failure",
    }
  }
  if (signal.aborted) return { success: false, error: "Bot task aborted before start" }

  // Imported here rather than at module scope: `lib/scheduler/executors/index`
  // is loaded on every host at boot, and the Bot control plane is a graph a
  // schedule with no Bot tasks has no reason to pay for.
  const [
    { enqueueBotDelivery },
    { getBotInstallation, readBotTriggerState },
    { buildBotEventEnvelope, oneOffSourceRecordId },
    { externalProvenance },
    { isRunnableBot, resolveInstalledBot },
  ] = await Promise.all([
    import("@/lib/db/bot-event-deliveries"),
    import("@/lib/db/bot-installations"),
    import("@/lib/bot/events/envelope"),
    import("@/lib/bot/events/provenance"),
    import("@/lib/bot/installed-bot"),
  ])

  const installation = await getBotInstallation(installationId)
  if (!installation) {
    // Terminal: the installation is gone, and every future tick would fail the
    // same way. Saying so lets the scheduler stop firing it.
    return {
      success: false,
      error: `Bot installation ${installationId} no longer exists`,
      terminalReason: "executor-failure",
    }
  }

  const resolved = await resolveInstalledBot(installation)
  if (!resolved || !isRunnableBot(resolved)) {
    return { success: false, error: `Bot installation ${installationId} is not runnable` }
  }

  const trigger = resolved.definition.triggers.find((candidate) => candidate.id === triggerId)
  if (!trigger) {
    return {
      success: false,
      error: `Bot ${resolved.definition.id} has no trigger "${triggerId}"`,
      terminalReason: "executor-failure",
    }
  }
  if (trigger.kind !== "schedule" && trigger.kind !== "poll" && trigger.kind !== "derivedState") {
    return {
      success: false,
      error: `Trigger "${triggerId}" is a ${trigger.kind} trigger, which the scheduler does not fire`,
      terminalReason: "executor-failure",
    }
  }

  const state = await readBotTriggerState(installationId, triggerId)
  const now = Date.now()
  const envelope = buildBotEventEnvelope({
    source: "schedule",
    // Every tick is its own event. A deterministic id would make the second
    // tick collapse onto the first one's delivery and the Bot would run once.
    sourceRecordId: oneOffSourceRecordId(`${installationId}-${triggerId}`),
    type: `bot.${trigger.kind}`,
    installationId,
    triggerId,
    occurredAt: now,
    receivedAt: now,
    payload: {
      triggerKind: trigger.kind,
      ...(state?.cursor !== undefined ? { cursor: state.cursor } : {}),
      ...(state?.lastEdgeValue !== undefined ? { previousEdgeValue: state.lastEdgeValue } : {}),
      ...(state?.lastFiredAt !== undefined ? { lastFiredAt: state.lastFiredAt } : {}),
      ...(trigger.kind === "derivedState" ? { state: trigger.state, edge: trigger.edge } : {}),
    },
    provenance: externalProvenance(),
  })

  const delivery = await enqueueBotDelivery({
    envelope,
    now,
    ...(trigger.concurrencyKey ? { concurrencyKey: `${installationId}::${trigger.id}` } : {}),
  })

  return {
    success: true,
    output: { deliveryId: delivery.id, botId: resolved.definition.id, triggerKind: trigger.kind },
  }
}
