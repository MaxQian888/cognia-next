"use client"

/**
 * In-session plan step watchdog (ADR-0045 §2, in-session driver).
 *
 * # Why it exists
 *
 * An in-session plan step is one visible chat turn. The turn driver marks the
 * step `in_progress`, writes `step_started`, and hands the turn text to the
 * chat surface — and then depends entirely on the chat hook calling
 * `handlePlanTurnComplete` when the turn finishes. Every way that call never
 * happens left the step `in_progress` forever with no event, no error and no
 * way out but cancelling the plan:
 *
 *   - the turn fails (a provider error, an external agent that could not
 *     spawn) — the error path settles the chat, not the plan;
 *   - the turn is never sent (the user switched sessions before the
 *     continuation, a plugin started the plan, the send was refused);
 *   - the turn hangs (a spawn that never answers keeps the session streaming);
 *   - the turn ends on a path that does not drive plans.
 *
 * # What it does
 *
 * One watch per executing in-session plan, armed by the driver when it starts
 * a step and dropped by the runtime on every transition away from it. It reads
 * the step's chat session from the chat store and reports a stall to the
 * runtime, which fails the step, pauses the plan on it and lets the user
 * retry / skip / complete it or cancel (`PlanRuntime.failInSessionStep`).
 *
 *   turn_failed  → the session settled with a NEW error diagnostic (immediate)
 *   not_started  → no fresh turn began within {@link PLAN_STEP_START_TIMEOUT_MS}
 *                  (a turn still waiting for admission — `isQueued` — is not
 *                  late: the clock restarts once it stops waiting)
 *   silent       → the turn streamed nothing for {@link PLAN_STEP_SILENCE_TIMEOUT_MS}
 *                  while no tool was running and nothing waited on a human
 *   unrecorded   → the turn settled cleanly but nobody recorded the step within
 *                  {@link PLAN_STEP_UNRECORDED_GRACE_MS}
 *
 * # What it deliberately does not do
 *
 * It never ends a chat turn and never writes the plan itself: the runtime
 * re-checks status, step and generation before acting, so a late report about
 * a step that already moved on is a no-op. A pending approval or a running
 * tool suspends the silence clock — a human deciding, or a long build, is not a
 * stall — exactly the stand-downs the connector idle watchdog takes.
 *
 * Budgets follow the existing conventions rather than inventing new ones: the
 * start and settle budgets are the chat's own silence budget
 * (`DEFAULT_SILENCE_TIMEOUT_MS`), and the streaming-silence budget matches the
 * five-minute ceiling the chat capture path and the external-agent manager
 * already apply to a single turn.
 */

import type { PlanStepHaltCause } from "@/types/agent/plan"
import { DEFAULT_SILENCE_TIMEOUT_MS } from "@/lib/chat/silence-watchdog"

/** A step whose turn never begins is reported after this long. */
export const PLAN_STEP_START_TIMEOUT_MS = DEFAULT_SILENCE_TIMEOUT_MS

/**
 * A streaming turn that produced nothing (no delta, no tool call, no status
 * change) for this long is reported. Five minutes = the per-turn ceiling of the
 * chat capture path (`run-and-capture`) and the external-agent manager's
 * default execution timeout.
 */
export const PLAN_STEP_SILENCE_TIMEOUT_MS = 5 * 60_000

/**
 * A turn that settled cleanly without the plan recording its step is reported
 * after this long. The grace covers the post-turn work the chat hook does
 * before it drives the plan (persistence, a goal judge call).
 */
export const PLAN_STEP_UNRECORDED_GRACE_MS = DEFAULT_SILENCE_TIMEOUT_MS

/** One armed step. `dispatchedAt` is when the driver started the step. */
export interface PlanStepWatch {
  planId: string
  stepId: string
  /** The chat session the step's turn runs in. */
  sessionId: string
  /** Plan generation at dispatch — the runtime refuses a report for any other. */
  generationId: string
  dispatchedAt: number
}

/**
 * The chat-slice fields the watchdog reads. Structural, so the singleton hands
 * it the real `SessionChatSlice` and tests hand it a plain object.
 */
export interface WatchedSessionSlice {
  status: string
  errorDiagnostic: { code?: string; message?: string } | null
  errorMessage: string | null
  /** Bumped by the chat store on every fresh idle/error → streaming edge. */
  runId: number
  pendingApprovals: readonly unknown[]
  toolTimestamps: Record<string, { startedAt: number; endedAt?: number }>
}

/** Stall causes the watchdog itself can observe. */
export type PlanStepStallCause = Extract<
  PlanStepHaltCause,
  "turn_failed" | "not_started" | "silent" | "unrecorded"
>

export interface PlanStepStall {
  watch: PlanStepWatch
  cause: PlanStepStallCause
  /** Technical detail for the step's `error` field (English, like other step errors). */
  detail: string
}

export interface PlanStepWatchdogBudgets {
  startMs: number
  silenceMs: number
  unrecordedMs: number
}

export interface PlanStepWatchdogDeps {
  now: () => number
  readSlice: (sessionId: string) => WatchedSessionSlice | undefined
  /** Subscribe to chat-store changes; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Called once per stalled watch, after the watch was dropped. */
  onStall: (stall: PlanStepStall) => void
  /**
   * Is the session's turn parked by the execution broker, waiting for
   * admission (`isChatTurnQueued`)? Such a turn has not started and is not
   * late — another turn holds its working copy. Nothing in the chat slice
   * marks the wait, so the watchdog asks.
   */
  isQueued?: (sessionId: string) => boolean
  budgets?: Partial<PlanStepWatchdogBudgets>
}

export interface PlanStepWatchdog {
  /** Watch a step (replaces any watch already held for the plan). */
  arm: (watch: PlanStepWatch) => void
  /** Stop watching a plan. Idempotent. */
  disarm: (planId: string) => void
  /** True when `planId` is watched (and, when given, for exactly `stepId`). */
  isArmed: (planId: string, stepId?: string) => boolean
  /** Snapshot of the watched plan ids. */
  armed: () => string[]
  /** Unmount: drop every watch and the store subscription. */
  dispose: () => void
}

interface Entry {
  watch: PlanStepWatch
  baselineDiagnostic: WatchedSessionSlice["errorDiagnostic"]
  baselineErrorMessage: string | null
  baselineRunId: number
  started: boolean
  /** Where the "never started" clock runs from: dispatch, or the last time
   *  the turn was seen waiting for admission. */
  startClockAt: number
  lastSlice: WatchedSessionSlice | undefined
  lastActivityAt: number
  settledAt?: number
  timer?: unknown
}

function isActive(slice: WatchedSessionSlice): boolean {
  return slice.status === "streaming" || slice.status === "awaiting_approval"
}

/** A human is being asked something, or a tool is mid-flight: silence is expected. */
function isLegitimatelyQuiet(slice: WatchedSessionSlice): boolean {
  if (slice.status === "awaiting_approval" || slice.pendingApprovals.length > 0) return true
  return Object.values(slice.toolTimestamps).some((timing) => timing.endedAt === undefined)
}

function seconds(ms: number): number {
  return Math.round(ms / 1000)
}

export function createPlanStepWatchdog(deps: PlanStepWatchdogDeps): PlanStepWatchdog {
  const budgets: PlanStepWatchdogBudgets = {
    startMs: deps.budgets?.startMs ?? PLAN_STEP_START_TIMEOUT_MS,
    silenceMs: deps.budgets?.silenceMs ?? PLAN_STEP_SILENCE_TIMEOUT_MS,
    unrecordedMs: deps.budgets?.unrecordedMs ?? PLAN_STEP_UNRECORDED_GRACE_MS,
  }
  const entries = new Map<string, Entry>()
  let unsubscribe: (() => void) | null = null

  const clearEntryTimer = (entry: Entry) => {
    if (entry.timer !== undefined) deps.clearTimer(entry.timer)
    entry.timer = undefined
  }

  const releaseSubscriptionIfIdle = () => {
    if (entries.size > 0 || !unsubscribe) return
    unsubscribe()
    unsubscribe = null
  }

  const drop = (planId: string) => {
    const entry = entries.get(planId)
    if (!entry) return
    clearEntryTimer(entry)
    entries.delete(planId)
    releaseSubscriptionIfIdle()
  }

  const fire = (entry: Entry, cause: PlanStepStallCause, detail: string) => {
    drop(entry.watch.planId)
    try {
      deps.onStall({ watch: entry.watch, cause, detail })
    } catch {
      // A reporting failure must not take the store subscription down with it.
    }
  }

  const schedule = (entry: Entry, ms: number) => {
    clearEntryTimer(entry)
    entry.timer = deps.setTimer(() => evaluate(entry), Math.max(0, ms))
  }

  const evaluate = (entry: Entry) => {
    // A superseded or dropped watch evaluates to nothing.
    if (entries.get(entry.watch.planId) !== entry) return
    const now = deps.now()
    const slice = deps.readSlice(entry.watch.sessionId)
    if (slice !== entry.lastSlice) {
      entry.lastSlice = slice
      entry.lastActivityAt = now
    }
    if (!slice) {
      // The session's slice is gone (its tab was closed). No data is not
      // evidence of a stall — look again later rather than guess.
      schedule(entry, budgets.startMs)
      return
    }

    const active = isActive(slice)
    if (!entry.started && slice.runId > entry.baselineRunId) entry.started = true

    // A failure the session reports is attributed to the step only when it is
    // NEW since the step was armed — a stale banner from an earlier turn is
    // not this step's error — and never the chat's own `turnSilent` warning,
    // which describes a live turn.
    if (!active) {
      const diagnostic = slice.errorDiagnostic
      if (
        diagnostic &&
        diagnostic !== entry.baselineDiagnostic &&
        diagnostic.code !== "turnSilent"
      ) {
        fire(entry, "turn_failed", diagnostic.message || diagnostic.code || "the turn failed")
        return
      }
      if (
        !diagnostic &&
        slice.status === "error" &&
        slice.errorMessage &&
        slice.errorMessage !== entry.baselineErrorMessage
      ) {
        fire(entry, "turn_failed", slice.errorMessage)
        return
      }
    }

    let deadline: number | null
    let cause: PlanStepStallCause
    let detail: string
    if (!entry.started) {
      if (deps.isQueued?.(entry.watch.sessionId)) {
        // Waiting for admission, not stalled. Admission flips the session to
        // streaming (a store change re-evaluates); a withdrawal or a missed
        // edge is caught by looking again after one start budget.
        entry.startClockAt = now
        schedule(entry, budgets.startMs)
        return
      }
      deadline = entry.startClockAt + budgets.startMs
      cause = "not_started"
      detail = `no turn started within ${seconds(budgets.startMs)}s of the step being dispatched`
    } else if (active) {
      entry.settledAt = undefined
      deadline = isLegitimatelyQuiet(slice) ? null : entry.lastActivityAt + budgets.silenceMs
      cause = "silent"
      detail = `the turn produced no output for ${seconds(budgets.silenceMs)}s`
    } else {
      if (entry.settledAt === undefined) entry.settledAt = now
      deadline = entry.settledAt + budgets.unrecordedMs
      cause = "unrecorded"
      detail = `the turn ended but the step was not recorded as finished within ${seconds(budgets.unrecordedMs)}s`
    }

    if (deadline === null) {
      // Suspended: the next store change (the tool finishing, the approval
      // being answered) re-evaluates and restarts the clock.
      clearEntryTimer(entry)
      return
    }
    if (now >= deadline) {
      fire(entry, cause, detail)
      return
    }
    schedule(entry, deadline - now)
  }

  const onStoreChange = () => {
    for (const entry of [...entries.values()]) {
      // Only sessions whose slice actually changed are worth a look: the chat
      // store writes once per streaming delta across every open session.
      if (deps.readSlice(entry.watch.sessionId) === entry.lastSlice) continue
      evaluate(entry)
    }
  }

  return {
    arm(watch) {
      drop(watch.planId)
      const slice = deps.readSlice(watch.sessionId)
      const entry: Entry = {
        watch,
        baselineDiagnostic: slice?.errorDiagnostic ?? null,
        baselineErrorMessage: slice?.errorMessage ?? null,
        baselineRunId: slice?.runId ?? 0,
        // Armed while the session is already busy (a previous turn still
        // sealing): count the step as started so the "never started" clock
        // cannot misfire; the silence / settle rules still bound it.
        started: slice ? isActive(slice) : false,
        startClockAt: watch.dispatchedAt,
        lastSlice: slice,
        lastActivityAt: deps.now(),
      }
      entries.set(watch.planId, entry)
      if (!unsubscribe) unsubscribe = deps.subscribe(onStoreChange)
      evaluate(entry)
    },
    disarm(planId) {
      drop(planId)
    },
    isArmed(planId, stepId) {
      const entry = entries.get(planId)
      return !!entry && (stepId === undefined || entry.watch.stepId === stepId)
    },
    armed() {
      return [...entries.keys()]
    },
    dispose() {
      for (const entry of entries.values()) clearEntryTimer(entry)
      entries.clear()
      unsubscribe?.()
      unsubscribe = null
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer singleton
// ─────────────────────────────────────────────────────────────────────────────

let singleton: PlanStepWatchdog | null = null
let loading: Promise<PlanStepWatchdog> | null = null

/**
 * The renderer's watchdog, wired to the chat store and the plan runtime.
 * Created on first arm (lazy imports keep the driver free of the chat store in
 * its own unit tests and on surfaces that never run an in-session plan).
 */
function loadPlanStepWatchdog(): Promise<PlanStepWatchdog> {
  if (singleton) return Promise.resolve(singleton)
  if (!loading) {
    loading = Promise.all([import("@/stores/chat"), import("@/lib/execution/chat-lease")]).then(
      ([{ useChatStore }, { isChatTurnQueued }]) => {
        singleton = createPlanStepWatchdog({
          now: () => Date.now(),
          readSlice: (sessionId) => useChatStore.getState().sessions[sessionId],
          subscribe: (listener) => useChatStore.subscribe(listener),
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
          isQueued: isChatTurnQueued,
          onStall: (stall) => {
            void import("./runtime")
              .then(({ getPlanRuntime }) =>
                getPlanRuntime().failInSessionStep(stall.watch.planId, {
                  stepId: stall.watch.stepId,
                  cause: stall.cause,
                  detail: stall.detail,
                  capturedGenerationId: stall.watch.generationId,
                })
              )
              .catch((error: unknown) => {
                console.warn("plan step watchdog: could not record the stall", error)
              })
          },
        })
        return singleton
      }
    )
  }
  return loading
}

/** Watch an in-session step the driver just started. Never throws. */
export async function armPlanStepWatch(watch: PlanStepWatch): Promise<void> {
  try {
    const watchdog = await loadPlanStepWatchdog()
    watchdog.arm(watch)
  } catch (error) {
    console.warn("plan step watchdog: could not arm", error)
  }
}

/**
 * Stop watching a plan. Synchronous when the watchdog exists; otherwise queued
 * behind the load so it lands AFTER any arm that was requested first.
 */
export function disarmPlanStepWatch(planId: string): void {
  if (singleton) {
    singleton.disarm(planId)
    return
  }
  if (loading) void loading.then((watchdog) => watchdog.disarm(planId)).catch(() => undefined)
}

/** Test-only: drop the singleton (and every timer / subscription it holds). */
export function __resetPlanStepWatchdogForTesting(): void {
  singleton?.dispose()
  singleton = null
  loading = null
}
