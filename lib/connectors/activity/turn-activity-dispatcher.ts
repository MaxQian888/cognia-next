/**
 * Per-turn dispatcher for the live-activity card (Feature A wiring core).
 * Mirrors `lib/connectors/a2ui-bridge/workflow-progress-runner.ts`'s mechanics
 * (in-flight guard, entry-job + platformMessageId tracking, edit-frame dispatch,
 * append fan-out) — but scoped to a SINGLE agent turn rather than a workflow
 * run. Three modes, selected from the adapter's capabilities:
 *
 *   - `cumulative` — the adapter supports `edit()`. One card is sent on the
 *     first flush; subsequent flushes EDIT it in place (throttled + per-tool).
 *   - `append`     — the adapter has NO `edit()` but CAN send. One compact
 *     single-line note per throttled boundary (capped at `APPEND_MAX_LINES`
 *     so a long turn can't spam), mirroring the progress-runner's append mode.
 *     This is the workflow⇄IM-parity fix: previously these adapters showed
 *     NOTHING during a turn.
 *   - `suppress`   — explicitly opted out (`canAppend()===false`) or flipped
 *     here on a quiet-hours defer. NO live card; the final reply +
 *     proactive-error-notify cover the conversation.
 *
 * Every dispatch goes through `enqueueOutbound`, so the card inherits the
 * outbound runner's rate-limit / circuit-breaker / quiet-hours / idempotency
 * gates automatically. The `getJob` + `sleep` seams exist for tests; in
 * production they read from Dexie and `setTimeout`. The in-flight coalesce is
 * the shared `FlushCoalescer` (`lib/connectors/_shared/flush-coalescer.ts`).
 */
import type { AuditKind } from "@/types/connectors/audit"
import type { ConversationReference } from "@/types/connectors/event"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import type { EnqueueInput } from "@/lib/db/outbound-jobs"
import type { MessageSegment } from "@/types/connectors/segment"
import { FlushCoalescer } from "../_shared/flush-coalescer"
import { buildA2UISegment } from "../a2ui-bridge/a2ui-to-segments"
import { buildActivitySurface } from "./activity-to-a2ui"
import type { ActivityI18n } from "./i18n"
import {
  createTurnActivityState,
  foldEvent,
  markEmitted,
  shouldEmit,
  summarizeForCard,
  type TurnActivityState,
} from "./turn-activity-tracker"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

type TurnStatus = "running" | "done" | "failed"

export interface TurnActivityDispatchOptions {
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  /** Per-turn unique surface id (A2UI segment key + idempotency namespace). */
  surfaceId: string
  i18n: ActivityI18n
  /** Test seam — production passes `enqueueOutbound`. */
  enqueue: (input: EnqueueInput) => Promise<OutboundJobRow>
  /** Returns true when the adapter can edit a sent message in place. */
  supportsEdit: () => boolean
  /**
   * Returns true when APPEND mode is allowed for adapters WITHOUT `edit()`
   * (default true). `false` opts the conversation out → suppress mode. Wired
   * from `overrideRow.appendActivity !== false` in the runtime.
   */
  canAppend?: () => boolean
  /** Test seam — production passes `getDb().outboundQueue.get`. */
  getJob: (jobId: string) => Promise<OutboundJobRow | undefined>
  /** Audit sink. */
  onAudit: (kind: AuditKind, fields?: Record<string, unknown>) => void
  /** Test seam — production passes a `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Override the turn-start timestamp (tests); defaults to Date.now(). */
  turnStartedAt?: number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** How long to poll for the entry card's `platformMessageId` before falling back. */
const PLATFORM_ID_POLL_MS = 100
const PLATFORM_ID_POLL_MAX_TRIES = 20 // 20 × 100ms = 2s
/** A first-dispatch deferred past this horizon flips the turn to suppress (quiet hours). */
const QUIET_DEFER_THRESHOLD_MS = 60_000
/** Hard cap on intermediate APPEND lines per turn so a long turn can't spam the chat. */
const APPEND_MAX_LINES = 8

interface FlushPayload {
  status: TurnStatus
  now: number
  force: boolean
}

export class TurnActivityDispatcher {
  private readonly opts: TurnActivityDispatchOptions
  private readonly sleep: (ms: number) => Promise<void>
  private readonly state: TurnActivityState
  private mode: "cumulative" | "append" | "suppress"
  private entryJobId: string | null = null
  private entryPlatformMessageId: string | null = null
  /** Count of intermediate APPEND lines emitted this turn (append mode only). */
  private appendCount = 0
  private readonly coalescer: FlushCoalescer<FlushPayload>
  private finalizing = false

  constructor(opts: TurnActivityDispatchOptions) {
    this.opts = opts
    this.sleep = opts.sleep ?? defaultSleep
    this.state = createTurnActivityState(opts.turnStartedAt ?? Date.now())
    this.mode = opts.supportsEdit()
      ? "cumulative"
      : (opts.canAppend?.() ?? true)
        ? "append"
        : "suppress"
    this.coalescer = new FlushCoalescer<FlushPayload>(
      (p) => this.flushInner(p.status, p.now),
      // Preserve the original behavior: the requeued flush reuses the
      // running flush's `now` (frozen for the coalesce chain); status takes
      // the latest; force OR-accumulates.
      (prev, next) => ({
        status: next.status,
        now: prev ? prev.now : next.now,
        force: (prev?.force ?? false) || next.force,
      })
    )
  }

  /** Feed a stream event; flushes a card update when the throttle gate fires. */
  onEvent(event: CaptureStreamEvent, now: number = Date.now()): void {
    if (this.finalizing || this.mode === "suppress") return
    const r = foldEvent(this.state, event, now)
    if (shouldEmit(this.state, now, { isToolBoundary: r.isToolBoundary })) {
      markEmitted(this.state, now)
      void this.coalescer.schedule({ status: "running", now, force: false })
    }
  }

  /**
   * Finalize the turn. Terminal card semantics:
   *   - suppress mode → no-op (final reply + proactive notify cover it).
   *   - cumulative, a card was sent → EDIT it to the terminal Done/Failed state.
   *   - cumulative, no card sent yet, DONE → suppress (final reply is the signal).
   *   - cumulative, no card sent yet, FAILED → send one fresh terminal card so
   *     the user learns the turn failed even if the proactive notify is off.
   */
  async finalize(status: "done" | "failed", now: number = Date.now()): Promise<void> {
    this.finalizing = true
    if (this.mode === "suppress") return
    // A terminal card/line is emitted when there's already something to update
    // (an entry card in cumulative, ≥1 append line in append) OR the turn
    // failed (so the user learns it failed even with no prior output). A clean
    // "done with no tools" stays silent — the final reply is the signal.
    const hadOutput = this.mode === "append" ? this.appendCount > 0 : this.entryJobId !== null
    if (hadOutput || status === "failed") {
      await this.coalescer.schedule({ status, now, force: true })
      this.opts.onAudit("activity.card_finalized", {
        adapterId: this.opts.adapterId,
        conversationKey: this.opts.conversationKey,
        surfaceId: this.opts.surfaceId,
        status,
        mode: this.mode,
      })
    }
  }

  /** Exposed for tests. */
  get currentMode(): "cumulative" | "append" | "suppress" {
    return this.mode
  }

  private async flushInner(status: TurnStatus, now: number): Promise<void> {
    if (this.mode === "append") {
      await this.flushAppend(status, now)
      return
    }
    const snapshot = summarizeForCard(this.state, status, now)
    const surface = buildActivitySurface(snapshot, this.opts.i18n)
    const segment = buildA2UISegment(this.opts.surfaceId, surface)

    if (!this.entryJobId) {
      const job = await this.dispatchEnqueue(
        segment,
        `activity:${this.opts.surfaceId}:entry`,
        undefined
      )
      if (job) {
        this.entryJobId = job.id
        this.opts.onAudit("activity.card_dispatched", {
          adapterId: this.opts.adapterId,
          conversationKey: this.opts.conversationKey,
          surfaceId: this.opts.surfaceId,
          status,
        })
        // Quiet-hours defer: if the first frame won't land for >1min, the
        // platformMessageId will never arrive in time and every subsequent
        // frame would fall back to a fresh send. Flip to suppress so we
        // don't churn deferred cards; the window-open drain stays clean.
        if (job.nextAttemptAt && job.nextAttemptAt > now + QUIET_DEFER_THRESHOLD_MS) {
          this.mode = "suppress"
        }
      }
      return
    }

    // Edit frame: resolve the entry card's platformMessageId (poll briefly if
    // markSent hasn't landed yet), then edit in place — or fall back to a
    // fresh send when it's still missing after the poll window.
    if (!this.entryPlatformMessageId) {
      this.entryPlatformMessageId = await this.resolvePlatformMessageId()
    }
    const editTarget = this.entryPlatformMessageId ?? undefined
    const idem = `activity:${this.opts.surfaceId}:${now}`
    if (!editTarget) {
      this.opts.onAudit("activity.edit_fallback", {
        adapterId: this.opts.adapterId,
        conversationKey: this.opts.conversationKey,
        surfaceId: this.opts.surfaceId,
        reason: "platformMessageId_unresolved",
      })
    }
    await this.dispatchEnqueue(segment, idem, editTarget)
  }

  /**
   * APPEND-mode flush: emit ONE compact text line. Intermediate lines are
   * capped at APPEND_MAX_LINES (the terminal/force line always gets through);
   * each is a fresh send (no edit target, unique idempotency key). The first
   * line's quiet-hours defer flips the turn to suppress, same as cumulative.
   */
  private async flushAppend(status: TurnStatus, now: number): Promise<void> {
    const isTerminal = status !== "running"
    if (!isTerminal && this.appendCount >= APPEND_MAX_LINES) return
    const snapshot = summarizeForCard(this.state, status, now)
    const secs = Math.round(snapshot.elapsedMs / 1000)
    const line = isTerminal
      ? this.opts.i18n.appendFinal(status === "failed" ? "failed" : "done", secs)
      : this.opts.i18n.appendLine(snapshot.toolCount, secs, snapshot.currentTool)
    const segment: MessageSegment = { type: "text", text: line }
    const idem = `activity:${this.opts.surfaceId}:append:${this.appendCount}:${now}`
    const job = await this.dispatchEnqueue(segment, idem, undefined)
    if (!job) return
    this.appendCount += 1
    this.opts.onAudit("activity.card_appended", {
      adapterId: this.opts.adapterId,
      conversationKey: this.opts.conversationKey,
      surfaceId: this.opts.surfaceId,
      appendCount: this.appendCount,
    })
    if (
      this.appendCount === 1 &&
      job.nextAttemptAt &&
      job.nextAttemptAt > now + QUIET_DEFER_THRESHOLD_MS
    ) {
      this.mode = "suppress"
    }
  }

  private async dispatchEnqueue(
    segment: MessageSegment,
    idempotencyKey: string,
    editTargetMessageId: string | undefined
  ): Promise<OutboundJobRow | null> {
    try {
      return await this.opts.enqueue({
        adapterId: this.opts.adapterId,
        conversationKey: this.opts.conversationKey,
        request: {
          conversationRef: this.opts.conversationRef,
          segments: [segment],
          metadata: { idempotencyKey },
          ...(editTargetMessageId ? { editTargetMessageId } : {}),
        },
        source: "ai-run",
      })
    } catch (err) {
      console.error("[turn-activity-dispatcher] enqueue failed", err)
      return null
    }
  }

  private async resolvePlatformMessageId(): Promise<string | null> {
    for (let i = 0; i < PLATFORM_ID_POLL_MAX_TRIES; i++) {
      if (!this.entryJobId) return null
      const job = await this.opts.getJob(this.entryJobId)
      if (job?.platformMessageId) return job.platformMessageId
      await this.sleep(PLATFORM_ID_POLL_MS)
    }
    return null
  }
}
