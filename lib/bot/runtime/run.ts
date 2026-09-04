/**
 * Drive one delivery to a settled Bot run.
 *
 * The run id is DERIVED from the delivery id. That single choice is what makes
 * a re-entry safe: the same delivery always reaches the same run, so its step
 * checkpoints, its pending approval and its journal are all still there when a
 * crashed or handed-over attempt comes back.
 *
 * Failure is split three ways, because only one of them is worth retrying:
 *
 *   - FAILED: the work ran and did not succeed. The delivery backs off.
 *   - UNAVAILABLE: nothing could run at all (a disabled plugin, a Bot with no
 *     working directory). Retrying the same delivery changes nothing, so it is
 *     dismissed with a reason rather than burning the attempt budget.
 *   - CANCELLED: somebody stopped it. Not a failure and not retried.
 */

import { nanoid } from "nanoid"

import {
  completeBotDelivery,
  dismissBotDelivery,
  failBotDelivery,
  markBotDeliveryRunning,
} from "@/lib/db/bot-event-deliveries"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import {
  createExecutionRun,
  getExecutionRun,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { writeBotTriggerState } from "@/lib/db/bot-installations"
import { projectBotComposition } from "@/lib/bot/composition/project-bot-composition"
import { defaultsFromConfigSchema, resolveBotConfig } from "@/lib/bot/config/resolve-effective"
import type { InstalledBot } from "@/lib/bot/installed-bot"
import type { BotHandlerResultV1, BotLogLevel, BotProgressUpdateV1 } from "@/types/bot/run"
import type { ExecutionRunStatus } from "@/types/execution/run"
import type { PluginBotExecutor } from "@/types/plugin/plugin-bot"

import { BOT_EXECUTORS } from "./executors"
import {
  BotExecutorUnavailableError,
  type BotExecutorContext,
  type BotExecutorFn,
} from "./executors/types"
import { BotRunCancelledError, createBotStepApi, type BotStepDeps } from "./step"

/** The run a delivery maps to. Derived, so a re-entry finds its own state. */
export function botRunId(deliveryId: string): string {
  return `run_bot_${deliveryId}`
}

/** Live runs, so a control command can stop one. */
const liveRuns = new Map<string, AbortController>()

/** Abort a running Bot run. Returns false when it is not running here. */
export function cancelLiveBotRun(runId: string): boolean {
  const controller = liveRuns.get(runId)
  if (!controller) return false
  controller.abort()
  return true
}

/** Test-only: drop every live registration. */
export function __resetLiveBotRunsForTesting(): void {
  liveRuns.clear()
}

export type BotRunOutcome =
  | { status: "completed"; runId: string; result?: BotHandlerResultV1 }
  | { status: "failed"; runId: string; error: string }
  | { status: "unavailable"; runId: string; error: string }
  | { status: "cancelled"; runId: string }

export interface RunBotDeliveryInput {
  delivery: BotEventDeliveryRow
  resolved: InstalledBot
  /** Directory the run works in, resolved by the caller from the workspace. */
  cwd?: string
  /** Override the executor table, for tests and for a headless host's subset. */
  executors?: Partial<Record<PluginBotExecutor, BotExecutorFn>>
  now?: () => number
  stepDeps?: BotStepDeps
}

async function settleRun(runId: string, status: ExecutionRunStatus, ts: number): Promise<void> {
  const db = getDb()
  const run = await db.executionRuns.get(runId)
  if (!run) return
  await db.executionRuns.put({ ...run, status, updatedAt: ts, endedAt: ts })
}

/**
 * Carry a timed trigger's state forward from the handler's result.
 *
 * The host cannot compute a poll cursor or evaluate a derived-state predicate,
 * because neither belongs to it. What it CAN do is remember the last answer
 * across evaluations, which is the whole difference between a Bot that reports
 * a change and one that notifies on every tick.
 */
async function persistTimedTriggerState(
  resolved: InstalledBot,
  triggerId: string,
  result: BotHandlerResultV1 | undefined,
  ts: number
): Promise<void> {
  const trigger = resolved.definition.triggers.find((candidate) => candidate.id === triggerId)
  if (!trigger || (trigger.kind !== "poll" && trigger.kind !== "derivedState")) return

  const output = result?.output
  const patch: Parameters<typeof writeBotTriggerState>[2] = { lastFiredAt: ts }
  if (output && typeof output === "object") {
    const shaped = output as { cursor?: unknown; edgeValue?: unknown }
    if (typeof shaped.cursor === "string") patch.cursor = shaped.cursor
    if (typeof shaped.edgeValue === "boolean") patch.lastEdgeValue = shaped.edgeValue
  }
  await writeBotTriggerState(resolved.installation.id, triggerId, patch, ts).catch(() => undefined)
}

export async function runBotDelivery(input: RunBotDeliveryInput): Promise<BotRunOutcome> {
  const now = input.now ?? Date.now
  const { delivery, resolved } = input
  const runId = botRunId(delivery.id)
  const ts = now()

  const existing = await getExecutionRun(runId)
  if (!existing) {
    await createExecutionRun({
      id: runId,
      kind: "bot",
      sourceId: resolved.installation.id,
      title: resolved.definition.name,
      status: "running",
      currentRevision: 0,
      startedAt: ts,
      updatedAt: ts,
      ...(resolved.installation.projectId ? { projectId: resolved.installation.projectId } : {}),
      ...(delivery.envelope.actor?.principalId || delivery.envelope.actor?.id
        ? {
            initiator: {
              ...(delivery.envelope.actor.id
                ? { platformIdentityId: delivery.envelope.actor.id }
                : {}),
              ...(delivery.envelope.actor.displayName
                ? { displayName: delivery.envelope.actor.displayName }
                : {}),
              ...(delivery.envelope.actor.principalId
                ? { principalId: delivery.envelope.actor.principalId }
                : {}),
              ...(delivery.envelope.actor.accountId
                ? { accountId: delivery.envelope.actor.accountId }
                : {}),
            },
          }
        : {}),
    })
  }

  await markBotDeliveryRunning(delivery.id, runId, ts)
  await runEventJournal
    .append(
      runId,
      semanticRunEvent(
        "run.started",
        { botId: resolved.definition.id, eventType: delivery.type },
        { ts, sourceEventId: `run.started:${delivery.id}` }
      )
    )
    .catch(() => undefined)

  const controller = new AbortController()
  liveRuns.set(runId, controller)

  const config = resolveBotConfig({
    installation: resolved.installation.config,
    definitionDefaults: defaultsFromConfigSchema(resolved.definition.configSchema),
  }).values

  const composition = projectBotComposition({
    executor: resolved.definition.executor,
    ...(resolved.definition.workflow ? { executorRef: resolved.definition.workflow } : {}),
    ...(resolved.definition.team ? { executorRef: resolved.definition.team } : {}),
    ...(resolved.definition.composition ? { definition: resolved.definition.composition } : {}),
    policy: resolved.policy,
  })

  const step = createBotStepApi({
    runId,
    signal: controller.signal,
    ...(resolved.installation.projectId ? { projectId: resolved.installation.projectId } : {}),
    ...(input.stepDeps ? { deps: input.stepDeps } : {}),
  })

  const ctx: BotExecutorContext = {
    runId,
    installationId: resolved.installation.id,
    botId: resolved.definition.id,
    event: delivery.envelope,
    config,
    signal: controller.signal,
    step,
    log: (level: BotLogLevel, message: string, data?: Record<string, unknown>) => {
      void runEventJournal
        .append(
          runId,
          semanticRunEvent(
            level === "error" ? "step.failed" : "step.progress",
            { message, ...(data ?? {}) },
            { ts: now(), sourceEventId: `log:${nanoid(10)}` }
          )
        )
        .catch(() => undefined)
    },
    progress: (update: BotProgressUpdateV1) => {
      void runEventJournal
        .append(runId, semanticRunEvent("step.progress", { ...update }, { ts: now() }))
        .catch(() => undefined)
    },
    installation: resolved.installation,
    definition: resolved.definition,
    composition,
    policy: resolved.policy,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  }

  const executor =
    input.executors?.[resolved.definition.executor] ?? BOT_EXECUTORS[resolved.definition.executor]

  try {
    const result = (await executor(ctx)) ?? undefined
    const endedAt = now()
    await persistTimedTriggerState(resolved, delivery.triggerId, result, endedAt)
    await settleRun(runId, "completed", endedAt)
    await runEventJournal
      .append(
        runId,
        semanticRunEvent(
          "run.completed",
          { summary: result?.summary },
          { ts: endedAt, sourceEventId: `run.completed:${delivery.id}` }
        )
      )
      .catch(() => undefined)
    await completeBotDelivery(delivery.id, endedAt)
    return { status: "completed", runId, ...(result ? { result } : {}) }
  } catch (error) {
    const endedAt = now()
    if (error instanceof BotRunCancelledError || controller.signal.aborted) {
      await settleRun(runId, "cancelled", endedAt)
      await runEventJournal
        .append(
          runId,
          semanticRunEvent("run.cancelled", {}, { ts: endedAt, sourceEventId: `cancel:${runId}` })
        )
        .catch(() => undefined)
      await dismissBotDelivery(delivery.id, "cancelled", endedAt)
      return { status: "cancelled", runId }
    }

    const message = error instanceof Error ? error.message : String(error)
    await settleRun(runId, "failed", endedAt)
    await runEventJournal
      .append(runId, semanticRunEvent("run.failed", { error: message }, { ts: endedAt }))
      .catch(() => undefined)

    if (error instanceof BotExecutorUnavailableError) {
      // Nothing ran, and nothing will. Dismissing keeps the attempt budget for
      // failures a retry could actually fix.
      await dismissBotDelivery(delivery.id, message, endedAt)
      return { status: "unavailable", runId, error: message }
    }

    await failBotDelivery(delivery.id, error, endedAt)
    return { status: "failed", runId, error: message }
  } finally {
    liveRuns.delete(runId)
  }
}
