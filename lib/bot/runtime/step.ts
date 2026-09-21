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
import {
  createRunInterrupt,
  expireRunInterruptFromSource,
  resolveRunInterruptFromSource,
} from "@/lib/execution/run-control"
import { resolveOwnedBotAuthority } from "@/lib/bot/policy/run-authority"
import { getActionReviewChannelAdapter } from "@/lib/policy/action-review/registry"
import { sha256Hex } from "@/lib/share/hash"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type {
  BotApprovalDecisionV1,
  BotApprovalRequestV1,
  BotStepApiV1,
  BotWaitForEventInput,
} from "@/types/bot/run"
import type { ExecutionRunInterrupt } from "@/types/execution/run"

/** How often a BLOCKING wait re-reads the row it is waiting on. */
export const BOT_WAIT_POLL_MS = 1_000

/**
 * How long a parked run stays out of the queue before it is re-entered.
 *
 * Generous on purpose. A re-entry replays memoized steps but re-runs
 * everything the author left OUTSIDE a step, so a one-second park would charge
 * that cost sixty times a minute for a question a person may take an hour to
 * answer.
 */
export const BOT_PARK_INTERVAL_MS = 20_000

/** Thrown when a run is cancelled while a handler is between steps. */
export class BotRunCancelledError extends Error {
  constructor(readonly runId: string) {
    super(`Bot run ${runId} was cancelled`)
    this.name = "BotRunCancelledError"
  }
}

/**
 * Thrown when a wait cannot be answered yet and the run should leave the queue.
 *
 * The alternative was what this replaces: an in-process poll that held the
 * runner's pass open for the whole life of the wait. `drainBotDeliveries` walks
 * its batch in order, so one Bot waiting on a human stalled every other Bot on
 * that host until the approval TTL expired.
 *
 * Unparking needs no new machinery. The run id is derived from the delivery id
 * and completed steps are memoized, so re-entering the handler from the top
 * lands back on the same question with the same deadline.
 */
export class BotRunParkedError extends Error {
  constructor(
    readonly runId: string,
    readonly stepName: string,
    readonly resumeAt: number,
    readonly waitingFor?: string
  ) {
    super(`Bot run ${runId} parked at step ${stepName}`)
    this.name = "BotRunParkedError"
  }
}

/**
 * The interrupt id for one step's approval.
 *
 * Derived rather than generated, so a re-entered handler finds the decision
 * already on somebody's screen instead of asking again. Two questions for one
 * step is how an approval queue fills with duplicates nobody can tell apart.
 */
export async function botApprovalInterruptId(runId: string, stepName: string): Promise<string> {
  // Control IDs cross redacted projections. Keep the authority reference short,
  // opaque, and collision-resistant rather than embedding event text or paths.
  return `bot-approval:${await sha256Hex(JSON.stringify([runId, stepName]))}`
}

export interface BotStepDeps {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  parkIntervalMs?: number
  /**
   * What an unanswered wait does.
   *
   * `park` (the default) leaves the queue so the runner can serve other Bots.
   * `block` polls in place, and exists for ONE caller: the Squad executor's
   * plan-approval delegate, which `startSquadRun` invokes from a
   * fire-and-forget lifecycle after the executor has already returned. A park
   * thrown there would unwind into a detached promise and vanish.
   */
  waitMode?: "park" | "block"
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function assertPublicStepName(name: string): void {
  if (!name.trim() || name.startsWith("__host:")) {
    throw new Error("Bot step name is empty or reserved for the host")
  }
}

function assertLive(signal: AbortSignal, runId: string): void {
  if (signal.aborted) throw new BotRunCancelledError(runId)
}

/**
 * Append one step lifecycle event to the run journal.
 *
 * The journal is a timeline, not the memoization store — it already redacts
 * payload strings, which is why `botRunSteps` exists beside it. Shared by the
 * in-process step API and the `ctx.bots.step*` host calls, so both project the
 * same `stepId`-keyed events onto a run's history.
 */
export async function journalBotStep(
  runId: string,
  type: "step.started" | "step.completed" | "step.failed",
  name: string,
  payload: Record<string, unknown>,
  now: () => number
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
  const parkIntervalMs = input.deps?.parkIntervalMs ?? BOT_PARK_INTERVAL_MS
  const waitMode = input.deps?.waitMode ?? "park"

  /** When to come back, never later than the wait's own deadline. */
  function resumeAt(deadline: number): number {
    return Math.min(now() + parkIntervalMs, deadline)
  }

  async function journal(
    type: "step.started" | "step.completed" | "step.failed",
    name: string,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    await journalBotStep(runId, type, name, payload, now)
  }

  async function run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    assertPublicStepName(name)
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
    assertPublicStepName(name)
    assertLive(signal, runId)
    if (request.decisionMode !== undefined && !["human", "policy"].includes(request.decisionMode))
      throw new Error("Invalid Bot approval decision mode")
    if (request.risk !== undefined && !["low", "medium", "high"].includes(request.risk))
      throw new Error("Invalid Bot approval risk")
    const generatedId = await botApprovalInterruptId(runId, name)
    const prior =
      (await getDb().executionRunInterrupts.get(generatedId)) ??
      (await getDb().executionRunInterrupts.get(`bot-approval:${runId}:${name}`))
    if (prior && prior.runId !== runId) throw new Error("Approval belongs to another run")
    if (
      prior &&
      (JSON.stringify(prior.approvalDetail) !== JSON.stringify(request.detail) ||
        prior.title !== request.title ||
        prior.approvalMessage !== request.message ||
        prior.approvalRisk !== request.risk ||
        (prior.approvalDecisionMode === "policy" && request.decisionMode !== "policy"))
    ) {
      await getDb().executionRunInterrupts.update(prior.id, {
        status: "expired",
        resolvedAt: now(),
      })
      throw new Error("Approval content changed; prepare a new result and approval step")
    }
    const begun = await beginBotRunStep(runId, name, now())
    if (begun.memoized) return begun.value as BotApprovalDecisionV1

    // Existing decisions remain bound to their original exact row and content.
    const interruptId = prior?.id ?? generatedId
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
      approvalDecisionMode:
        prior?.approvalDecisionMode ?? (prior ? "human" : (request.decisionMode ?? "human")),
      ...(request.detail ? { approvalDetail: structuredClone(request.detail) } : {}),
      ...(request.message ? { approvalMessage: request.message } : {}),
      ...(request.risk ? { approvalRisk: request.risk } : {}),
      expiresAt,
      createdAt: now(),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }
    // An existing human request never becomes automatic when configuration changes.
    if (!prior && request.decisionMode === "policy") {
      const authority = await resolveOwnedBotAuthority(undefined, runId)
      if (authority.automatedPublicationAllowed) {
        interrupt.approvalPolicy = {
          kind: "bot-installation",
          installationId: authority.installation.id,
        }
      } else {
        interrupt.approvalDecisionMode = "human"
      }
    }
    await createRunInterrupt(interrupt).catch(async (error) => {
      // A re-entry finds its own interrupt already there. Anything else is real.
      const existing = await getDb().executionRunInterrupts.get(interruptId)
      if (!existing) throw error
      return existing
    })

    if (request.decisionMode === "policy") {
      const db = getDb()
      // Compare-and-resolve under the existing stores' transaction. A concurrent
      // denial, cancellation, or grant change must win before publication authority exists.
      await db.transaction(
        "rw",
        [
          db.executionRunInterrupts,
          db.executionRuns,
          db.executionRunEvents,
          // `resolveRunInterruptFromSource` journals inside this zone, and the
          // journal write touches `notificationProjectionWork` (schema v227).
          db.notificationProjectionWork,
          db.botInstallations,
          db.botRunSteps,
        ],
        async () => {
          const pending = await db.executionRunInterrupts.get(interruptId)
          if (
            pending?.status !== "pending" ||
            pending.approvalDecisionMode !== "policy" ||
            pending.approvalPolicy?.kind !== "bot-installation" ||
            now() >= pending.expiresAt
          )
            return
          const authority = await resolveOwnedBotAuthority(undefined, runId)
          assertLive(signal, runId)
          if (
            authority.automatedPublicationAllowed &&
            pending.approvalPolicy.installationId === authority.installation.id
          ) {
            await resolveRunInterruptFromSource(
              runId,
              interruptId,
              "approve",
              { displayName: "Host policy" },
              now()
            )
          }
        }
      )
    }

    if (!begun.memoized) {
      await journal("step.started", name, { interruptId, waiting: "approval" })
    }

    const decision =
      waitMode === "block"
        ? await pollInterrupt(interruptId, expiresAt)
        : await probeInterrupt(interruptId, expiresAt)
    if (!decision) throw new BotRunParkedError(runId, name, resumeAt(expiresAt), interruptId)

    await completeBotRunStep(runId, name, decision, now())
    await journal("step.completed", name, {
      outcome: decision.outcome,
      decisionMode: decision.decisionMode,
    })
    return decision
  }

  /** Read the decision once. `null` means nobody has answered yet. */
  async function probeInterrupt(
    interruptId: string,
    expiresAt: number
  ): Promise<BotApprovalDecisionV1 | null> {
    const row = await getDb().executionRunInterrupts.get(interruptId)
    const settled = row && row.status !== "pending" ? decisionFromInterrupt(row) : null
    if (settled) return settled
    if (now() >= expiresAt) {
      await expireRunInterruptFromSource(runId, interruptId, now())
      // Nobody answered. An expiry is not a quiet approval, and the outcome
      // union exists so a handler cannot accidentally treat it as one.
      return { outcome: "expired", decidedAt: now() }
    }
    return null
  }

  function decisionFromInterrupt(row: ExecutionRunInterrupt): BotApprovalDecisionV1 {
    return {
      approvalId: row.id,
      ...(row.approvalDecisionMode === "policy" ? { decisionMode: "policy" as const } : {}),
      outcome:
        row.status === "approved" ? "approved" : row.status === "denied" ? "denied" : "expired",
      decidedAt: row.resolvedAt ?? now(),
      ...(row.resolvedBy
        ? {
            decidedBy: {
              ...(row.resolvedBy.principalId ? { principalId: row.resolvedBy.principalId } : {}),
              ...(row.resolvedBy.displayName ? { displayName: row.resolvedBy.displayName } : {}),
            },
          }
        : {}),
    }
  }

  /** Block for detached Squad delegates and live external-agent command decisions. */
  async function pollInterrupt(
    interruptId: string,
    expiresAt: number
  ): Promise<BotApprovalDecisionV1> {
    for (;;) {
      assertLive(signal, runId)
      const decision = await probeInterrupt(interruptId, expiresAt)
      if (decision) return decision
      await sleep(pollIntervalMs)
    }
  }

  async function waitForEvent(
    name: string,
    waitInput: BotWaitForEventInput
  ): Promise<BotEventEnvelopeV1 | null> {
    assertPublicStepName(name)
    assertLive(signal, runId)
    const begun = await beginBotRunStep(runId, name, now())
    if (begun.memoized) return begun.value as BotEventEnvelopeV1 | null

    const step = await getBotRunStep(runId, name)
    const deadline = (step?.startedAt ?? now()) + waitInput.timeoutMs
    if (!begun.memoized) {
      await journal("step.started", name, { waiting: "event", key: waitInput.key })
    }

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
      if (waitMode === "park") {
        throw new BotRunParkedError(runId, name, resumeAt(deadline), waitInput.key)
      }
      await sleep(pollIntervalMs)
    }
  }

  return { run, waitForApproval, waitForEvent }
}
