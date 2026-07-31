/**
 * Run-scoped PR observation controller — the loop half of the Agent Team PR
 * feedback feature. Modeled on {@link import("./rate-limit-resume").RateLimitResumeController}:
 * the clock and timers are injected so it is deterministic under fake timers, and
 * `dispose()` (called in the team run's `finally`) cancels every pending poll so
 * a scheduled fetch never fires after the run ends.
 *
 * Per tracked binding it polls on an interval, semantic-diffs against the prior
 * snapshot, and on a change: reacts (guarded `review_pickup` nudges via
 * {@link PrReactionEngine}), optionally runs the internal reviewer (routing its
 * verdict through the same engine so dedup/rate-limit are shared), persists the
 * facts + derived status + dedup ledger, and stops polling once the PR is
 * merged/closed. A not-fetched poll (no PR yet) simply reschedules, so a teammate
 * that opens its PR mid-run is picked up on a later tick.
 */

import { bindingKey, type TeammatePrBinding } from "./binding"
import { derivePrStatus } from "./derive-status"
import {
  PrReactionEngine,
  type NudgeIntent,
  type PrNudge,
  type PrReactionSignature,
} from "./reactions"
import type { PrDerivedStatus, PrObservation } from "@/lib/github/pr-observe/types"

/** A persisted observation record (facts + cached derivation + dedup ledger). */
export interface PrObservationRecord {
  binding: TeammatePrBinding
  observation: PrObservation
  derivedStatus: PrDerivedStatus
  signature: PrReactionSignature
}

/** Cancelable timer handle (opaque; the real deps store the native id on it). */
export interface TimerHandle {
  cancelled: boolean
}

export interface PrFeedbackDeps {
  now: () => number
  setTimer: (fn: () => void, ms: number) => TimerHandle
  clearTimer: (h: TimerHandle) => void
  pollIntervalMs: number
  /** Fetch one observation for a binding, given the previous snapshot. */
  fetch: (binding: TeammatePrBinding, prev: PrObservation | undefined) => Promise<PrObservation>
  /** Persist a changed observation record. */
  persist: (record: PrObservationRecord) => void | Promise<void>
  /** Deliver a passed nudge (notifier + team mailbox). */
  deliver: (binding: TeammatePrBinding, nudge: PrNudge) => void
  /** Hydrate the persisted dedup ledger for a binding (restart-safe). */
  loadSignature?: (
    binding: TeammatePrBinding
  ) => PrReactionSignature | undefined | Promise<PrReactionSignature | undefined>
  /**
   * Internal reviewer pass. Invoked at most once per new head commit for an open
   * PR; returns a nudge intent when it requests changes, else null. Its intent is
   * routed through the same engine so it shares dedup + the hourly cap.
   */
  reviewer?: (binding: TeammatePrBinding, obs: PrObservation) => Promise<NudgeIntent | null>
  /** Surface a fetch/persist error without killing the loop. */
  onError?: (binding: TeammatePrBinding, err: unknown) => void
  /** Last tool-activity timestamp for the busy-signal guard. */
  lastToolActivityAt?: (binding: TeammatePrBinding) => number | undefined
  maxPerHour?: number
  busyWindowMs?: number
}

interface TrackState {
  binding: TeammatePrBinding
  engine: PrReactionEngine
  prev?: PrObservation
  handle: TimerHandle | null
  terminal: boolean
  hydrated: boolean
  lastReviewedSha: string | null
  pollCount: number
}

interface SettleWaiter {
  resolve: () => void
  /** When true (maxWaitMs<=0), one completed poll per binding is enough. */
  needFirstPoll: boolean
}

export class PrFeedbackController {
  private readonly states = new Map<string, TrackState>()
  private readonly handles = new Set<TimerHandle>()
  private disposed = false
  private settleWaiter: SettleWaiter | null = null
  private settleTimer: TimerHandle | null = null

  constructor(private readonly deps: PrFeedbackDeps) {}

  /**
   * Resolve when every tracked PR is terminal (merged/closed), or — with
   * `maxWaitMs <= 0` — once each binding has completed at least one poll, or when
   * `maxWaitMs` elapses. Lets the runtime bound the post-DAG observe window.
   */
  settle(maxWaitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.settleWaiter = { resolve, needFirstPoll: maxWaitMs <= 0 }
      if (this.trySettle()) return
      if (maxWaitMs > 0 && !this.disposed) {
        const h = this.deps.setTimer(() => this.finishSettle(), maxWaitMs)
        this.settleTimer = h
        this.handles.add(h)
      }
    })
  }

  private trySettle(): boolean {
    const w = this.settleWaiter
    if (!w) return false
    const states = [...this.states.values()]
    const done =
      this.disposed ||
      states.length === 0 ||
      states.every((s) => s.terminal || (w.needFirstPoll && s.pollCount > 0))
    if (done) {
      this.finishSettle()
      return true
    }
    return false
  }

  private finishSettle(): void {
    const w = this.settleWaiter
    if (!w) return
    this.settleWaiter = null
    if (this.settleTimer) {
      this.deps.clearTimer(this.settleTimer)
      this.handles.delete(this.settleTimer)
      this.settleTimer = null
    }
    w.resolve()
  }

  /** Begin observing a teammate's PR. Idempotent per (run, member, task). */
  track(binding: TeammatePrBinding): void {
    if (this.disposed) return
    const key = bindingKey(binding)
    if (this.states.has(key)) return
    const engine = new PrReactionEngine({
      now: this.deps.now,
      maxPerHour: this.deps.maxPerHour,
      busyWindowMs: this.deps.busyWindowMs,
    })
    const state: TrackState = {
      binding,
      engine,
      handle: null,
      terminal: false,
      hydrated: false,
      lastReviewedSha: null,
      pollCount: 0,
    }
    this.states.set(key, state)
    this.schedule(state, 0) // immediate first poll
  }

  /** Tracked binding count (diagnostics / tests). */
  tracked(): number {
    return this.states.size
  }

  /** Cancel every pending poll. Idempotent. Called in the run's `finally`. */
  dispose(): void {
    this.disposed = true
    for (const h of this.handles) this.deps.clearTimer(h)
    this.handles.clear()
    this.settleTimer = null
    this.finishSettle() // never leave an awaiting settle hanging
  }

  private schedule(state: TrackState, ms: number): void {
    if (this.disposed || state.terminal) return
    const h = this.deps.setTimer(async () => {
      this.handles.delete(h)
      state.handle = null
      await this.pollOnce(state)
    }, ms)
    state.handle = h
    this.handles.add(h)
  }

  private async pollOnce(state: TrackState): Promise<void> {
    if (this.disposed || state.terminal) return
    try {
      if (!state.hydrated) {
        if (this.deps.loadSignature)
          state.engine.hydrate((await this.deps.loadSignature(state.binding)) ?? undefined)
        state.hydrated = true
      }
      const obs = await this.deps.fetch(state.binding, state.prev)
      if (obs.fetched) await this.process(state, obs)
    } catch (err) {
      this.deps.onError?.(state.binding, err)
    } finally {
      state.pollCount += 1
      if (!this.disposed && !state.terminal) this.schedule(state, this.deps.pollIntervalMs)
      this.trySettle()
    }
  }

  private async process(state: TrackState, obs: PrObservation): Promise<void> {
    const changed = !state.prev || obs.changed.metadata || obs.changed.ci || obs.changed.review
    // Remember the discovered PR url so persistence keys stay stable.
    if (obs.pr.url && !state.binding.prUrl) {
      state.binding = { ...state.binding, prUrl: obs.pr.url }
    }
    state.prev = obs
    if (!changed) return

    const ctx = {
      memberId: state.binding.memberId,
      lastToolActivityAt: this.deps.lastToolActivityAt?.(state.binding),
      deliver: (n: PrNudge) => this.deps.deliver(state.binding, n),
    }

    // Observation-derived nudges (CI / review / conflict).
    state.engine.react(obs, ctx)

    // Internal reviewer: at most once per new head commit for an open PR.
    if (
      this.deps.reviewer &&
      !obs.pr.merged &&
      !obs.pr.closed &&
      !obs.pr.draft &&
      obs.pr.headSha &&
      obs.pr.headSha !== state.lastReviewedSha
    ) {
      state.lastReviewedSha = obs.pr.headSha
      const intent = await this.deps.reviewer(state.binding, obs)
      if (intent) state.engine.reactIntents([intent], ctx)
    }

    await this.deps.persist({
      binding: state.binding,
      observation: obs,
      derivedStatus: derivePrStatus(obs),
      signature: state.engine.exportSignature(),
    })

    // A merged/closed PR is terminal — stop polling (final state persisted above).
    if (obs.pr.merged || obs.pr.closed) state.terminal = true
  }
}

/** Real timer/clock deps (production wiring). */
export function createRealPrFeedbackTimers(): Pick<
  PrFeedbackDeps,
  "now" | "setTimer" | "clearTimer"
> {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const handle: TimerHandle = { cancelled: false }
      const id = setTimeout(() => {
        if (!handle.cancelled) fn()
      }, ms)
      ;(handle as TimerHandle & { id: ReturnType<typeof setTimeout> }).id = id
      return handle
    },
    clearTimer: (handle) => {
      handle.cancelled = true
      const id = (handle as TimerHandle & { id?: ReturnType<typeof setTimeout> }).id
      if (id) clearTimeout(id)
    },
  }
}
