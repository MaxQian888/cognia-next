/**
 * The durable step surface a Bot handler drives.
 *
 * A handler is re-entered FROM THE TOP after a crash, a Host handover, or a
 * resumed wait. Everything here exists to make that safe:
 *
 *   - `run` memoizes on `botRunSteps`, so completed work is not redone.
 *   - `waitForApproval` derives its interrupt id from the run and the step
 *     name, so a re-entry finds the pending decision rather than asking a
 *     second person the same question.
 *   - `waitForEvent` takes its deadline from the step's FIRST entry, so a
 *     resumed wait does not restart the clock. A wait that silently extends
 *     itself on every restart is a wait that never ends.
 *
 * The run journal still gets `step.started` / `step.completed` events for the
 * timeline. It is not where memoized values live: `runEventJournal` redacts
 * every string in a payload, which is right for a timeline and would corrupt a
 * replayed value.
 */

import { beginBotRunStep, completeBotRunStep, failBotRunStep } from "@/lib/db/bot-run-steps"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import { findBotDeliveryByCorrelation } from "@/lib/db/bot-event-deliveries"
import { getDb } from "@/lib/db/schema"
import { runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import { createRunInterrupt } from "@/lib/execution/run-control"
import { getActionReviewChannelAdapter } from "@/lib/policy/action-review/registry"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type {
  BotApprovalDecisionV1,
  BotApprovalRequestV1,
  BotStepApiV1,
  BotWaitForEventInput,
} from "@/types/bot/run"
import type { ExecutionRunInterrupt } from "@/types/execution/run"

/** How often a parked run re-reads the row it is waiting on. */
export const BOT_WAIT_POLL_MS = 1_000

/** Thrown when a run is cancelled while a handler is between steps. */
export class BotRunCancelledError extends Error {
  constructor(readonly runId: string) {
    super(`Bot run ${runId} was cancelled`)
    this.name = "BotRunCancelledError"
  }
}

/**
 * The interrupt id for one step's approval.
 *
 * Derived rather than generated, so a re-entered handler finds the decision
 * already on somebody's screen instead of asking again. Two questions for one
 * step is how an approval queue fills with duplicates nobody can tell apart.
 */
export function botApprovalInterruptId(runId: string, stepName: string): string {
  return `bot-approval:${runId}:${stepName}`
}

export interface BotStepDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function assertLive(signal: AbortSignal, runId: string): void {
  if (signal.aborted) throw new BotRunCancelledError(runId)
}

/**
 * Build the step API for one run.
 *
 * `signal` is the run's cancellation. Every step boundary checks it, which is
 * the only place a cross-process handler could safely notice cancellation
 * anyway.
 */
export function createBotStepApi(input: {
  runId: string
  projectId?: string
  signal: AbortSignal
  deps?: BotStepDeps
}): BotStepApiV1 {
  const { runId, signal } = input
  const now = input.deps?.now ?? Date.now
  const sleep = input.deps?.sleep ?? defaultSleep
  const pollIntervalMs = input.deps?.pollIntervalMs ?? BOT_WAIT_POLL_MS

  async function journal(
    type: "step.started" | "step.completed" | "step.failed",
    name: string,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    await runEventJournal
      .append(
        runId,
        semanticRunEvent(
          type,
          { stepId: name, ...payload },
          { ts: now(), sourceEventId: `${type}:${name}` }
        )
      )
      .catch(() => undefined)
  }

  async function run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    assertLive(signal, runId)
    const begun = await beginBotRunStep(runId, name, now())
    if (begun.memoized) return begun.value as T

    await journal("step.started", name, { attempt: begun.attempt })
    try {
      const value = await fn()
      await completeBotRunStep(runId, name, value, now())
      await journal("step.completed", name)
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await failBotRunStep(runId, name, message, now())
      await journal("step.failed", name, { error: message })
      throw error
    }
  }

  async function waitForApproval(
    name: string,
    request: BotApprovalRequestV1
  ): Promise<BotApprovalDecisionV1> {
    assertLive(signal, runId)
    const begun = await beginBotRunStep(runId, name, now())
    if (begun.memoized) return begun.value as BotApprovalDecisionV1

    const interruptId = botApprovalInterruptId(runId, name)
    const adapter = getActionReviewChannelAdapter("bot-step")
    const ttl = Math.min(request.timeoutMs ?? adapter.defaultTtlMs, adapter.defaultTtlMs)
    const step = await getBotRunStep(runId, name)
    // The deadline rides the step's FIRST entry, so a resumed wait does not
    // hand the approver a fresh clock every time the Host restarts.
    const expiresAt = (step?.startedAt ?? now()) + ttl

    const interrupt: ExecutionRunInterrupt = {
      id: interruptId,
      runId,
      type: adapter.interruptType ?? "bot_approval",
      status: "pending",
      title: request.title,
      expiresAt,
      createdAt: now(),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }
    await createRunInterrupt(interrupt).catch(async (error) => {
      // A re-entry finds its own interrupt already there. Anything else is real.
      const existing = await getDb().executionRunInterrupts.get(interruptId)
      if (!existing) throw error
      return existing
    })

    await journal("step.started", name, { interruptId, waiting: "approval" })

    const decision = await pollInterrupt(interruptId, expiresAt)
    await completeBotRunStep(runId, name, decision, now())
    await journal("step.completed", name, { outcome: decision.outcome })
    return decision
  }

  async function pollInterrupt(
    interruptId: string,
    expiresAt: number
  ): Promise<BotApprovalDecisionV1> {
    for (;;) {
      assertLive(signal, runId)
      const row = await getDb().executionRunInterrupts.get(interruptId)
      if (row && row.status !== "pending") {
        return {
          outcome:
            row.status === "approved" ? "approved" : row.status === "denied" ? "denied" : "expired",
          decidedAt: row.resolvedAt ?? now(),
          ...(row.resolvedBy
            ? {
                decidedBy: {
                  ...(row.resolvedBy.principalId
                    ? { principalId: row.resolvedBy.principalId }
                    : {}),
                  ...(row.resolvedBy.displayName
                    ? { displayName: row.resolvedBy.displayName }
                    : {}),
                },
              }
            : {}),
        }
      }
      if (now() >= expiresAt) {
        // Nobody answered. An expiry is not a quiet approval, and the outcome
        // union exists so a handler cannot accidentally treat it as one.
        return { outcome: "expired", decidedAt: now() }
      }
      await sleep(pollIntervalMs)
    }
  }

  async function waitForEvent(
    name: string,
    waitInput: BotWaitForEventInput
  ): Promise<BotEventEnvelopeV1 | null> {
    assertLive(signal, runId)
    const begun = await beginBotRunStep(runId, name, now())
    if (begun.memoized) return begun.value as BotEventEnvelopeV1 | null

    const step = await getBotRunStep(runId, name)
    const deadline = (step?.startedAt ?? now()) + waitInput.timeoutMs
    await journal("step.started", name, { waiting: "event", key: waitInput.key })

    for (;;) {
      assertLive(signal, runId)
      const delivery = await findBotDeliveryByCorrelation(waitInput.key)
      if (delivery) {
        await completeBotRunStep(runId, name, delivery.envelope, now())
        await journal("step.completed", name, { eventId: delivery.eventId })
        return delivery.envelope
      }
      if (now() >= deadline) {
        // Resolving to null rather than throwing: "it never came" is an
        // ordinary branch for a Bot that is watching something.
        await completeBotRunStep(runId, name, null, now())
        await journal("step.completed", name, { timedOut: true })
        return null
      }
      await sleep(pollIntervalMs)
    }
  }

  return { run, waitForApproval, waitForEvent }
}
