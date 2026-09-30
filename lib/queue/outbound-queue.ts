"use client"

/**
 * Mobile outbound queue runner (Wave 2.1).
 *
 * Drains the `mobileOutboundQueue` Dexie table by:
 *   1. Pulling the next ready row (`claimNext`) and flipping it to "sending".
 *   2. Dispatching it to the desktop server via `transport.call(command, payload,
 *      { idempotencyKey })`.
 *   3. On success → mark "sent". On retryable failure → back off + retry.
 *      On 4xx-class failure → deadletter.
 *
 * Triggered by:
 *   - Network online events (Capacitor `@capacitor/network` or browser
 *     `navigator.onLine`).
 *   - App-resume events (`@capacitor/app:resume`).
 *   - Manual `kick()` calls — used by composer / approval-panel after
 *     enqueueing a row to start dispatch immediately when online.
 *
 * The runner is platform-agnostic. Attached Web, Mobile and Desktop callers
 * pass `enforceMobile: false`; the legacy default remains mobile-only for
 * older call sites that have not opted into the shared HostState lifecycle.
 */

import {
  CLAIM_RENEW_INTERVAL_MS,
  claimNext,
  deleteRow,
  listByStatus,
  markHostStateResult,
  markCollabConflict,
  markSent,
  nextQueueWakeAt,
  recordFailure,
  releaseClaim,
  releaseStaleClaims,
  renewClaim,
  vacuumSent,
} from "@/lib/db/mobile-outbound-queue"
import { acknowledgeMobileStepResultChunk } from "@/lib/db/mobile-step-receipts"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { isHostStateAction, isHostStateSubmitResponse } from "@cognia/agent-config-types/host-state"
import { detectNativePlatform } from "@/lib/capacitor/_shared"
import { subscribe as subscribeNetwork } from "@/lib/capacitor/network"
import type { RuntimeTargetScope } from "@/lib/runtime/runtime-target-context"
import { transportCommandTimeoutMs } from "@/lib/tauri/transport-types"

/**
 * Headroom past a command's own transport deadline before the runner stops
 * waiting on it. The transport arms its timeout only once it starts the
 * request; anything awaited before that (routing, credentials, a native
 * bridge) had no bound at all, and one promise that never settled left its row
 * `sending` and the whole drain parked behind it for the life of the app.
 */
export const DISPATCH_DEADLINE_GRACE_MS = 15_000

/**
 * The longest the pre-flight gate (`canDispatch`: rollout policy, the
 * interactive-approval lease) may take before the row is treated as not
 * dispatchable right now. It asks the Host for a lease over the same transport,
 * so it inherits the same unbounded prefix.
 */
export const PREFLIGHT_DEADLINE_MS = 45_000

/**
 * How long a row the pre-flight gate refused stays out of the runner's claims.
 *
 * A refused row is released back to `pending`, and that write is exactly what
 * the pending-jobs subscription kicks the runner on. Without a hold the runner
 * reclaimed it at once, was refused again and released it again — a tight
 * claim/release loop against IndexedDB for as long as the refusal lasted, with
 * the row flickering between "Queued" and "Sending" under the user's finger.
 * `kick({ thaw: true })` lifts every hold early for the events that can change
 * the answer (an approval, a new Host manifest).
 */
export const FROZEN_RECHECK_MS = 15_000

/** Floor for a scheduled wake-up, so a clock at the boundary cannot spin. */
const MIN_WAKE_DELAY_MS = 250
/** `setTimeout` clamps anything longer to an immediate fire. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** A dispatch or pre-flight that produced no answer within its deadline. */
export class OutboundDeadlineError extends Error {
  constructor(
    readonly command: string,
    readonly phase: "dispatch" | "preflight",
    readonly afterMs: number
  ) {
    super(`outbound ${phase} of ${command} got no answer within ${Math.round(afterMs / 1000)}s`)
    this.name = "OutboundDeadlineError"
  }
}

/** The dispatch deadline for one command: its transport deadline plus grace. */
export function dispatchDeadlineMs(command: string): number {
  return transportCommandTimeoutMs(command) + DISPATCH_DEADLINE_GRACE_MS
}

/**
 * Settle with `work`, or reject with {@link OutboundDeadlineError} once
 * `afterMs` passes. A late settlement of `work` is swallowed: the caller has
 * already moved the row on, and must not also see an unhandled rejection.
 */
function withDeadline<T>(
  work: Promise<T>,
  command: string,
  phase: "dispatch" | "preflight",
  afterMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OutboundDeadlineError(command, phase, afterMs)), afterMs)
  })
  work.catch(() => undefined)
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

export interface OutboundDispatcher {
  /** Resolves with the RPC return body. Throws on transport failure. */
  call(
    command: string,
    payload: Record<string, unknown>,
    opts: { idempotencyKey: string }
  ): Promise<unknown>
}

export interface RunnerOptions {
  dispatcher: OutboundDispatcher
  /** Immutable delivery scope captured when this runner is created. */
  scope: RuntimeTargetScope
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
  /** Test seam — defaults to `Math.random`. */
  random?: () => number
  /**
   * If true, the runner refuses to dispatch on non-mobile platforms. Set
   * to false in unit tests so behaviour can be exercised without a fake
   * mobile shell.
   */
  enforceMobile?: boolean
  /** Drop sent rows older than this. Default 24 h. */
  vacuumKeepMs?: number
  /** Leave a claimed row pending when rollout/capability policy freezes it. */
  canDispatch?: (row: MobileOutboundJobRow) => boolean | Promise<boolean>
  /** Test seam — defaults to {@link dispatchDeadlineMs}. */
  dispatchDeadlineMs?: (command: string) => number
  /** Test seam — defaults to {@link PREFLIGHT_DEADLINE_MS}. */
  preflightDeadlineMs?: number
  /** Test seam — defaults to {@link FROZEN_RECHECK_MS}. */
  frozenRecheckMs?: number
  /** Test seam — defaults to `CLAIM_RENEW_INTERVAL_MS`. */
  claimRenewIntervalMs?: number
}

export interface OutboundKickOptions {
  /**
   * Lift every pre-flight hold ({@link FROZEN_RECHECK_MS}) before draining. For
   * events that can change the gate's answer — an approval granted elsewhere, a
   * new Host manifest — not for the pending-jobs subscription, whose own
   * release writes would otherwise re-arm the claim/release loop.
   */
  thaw?: boolean
}

export interface OutboundRunner {
  /** Kick a single drain pass — useful immediately after enqueue. */
  kick(options?: OutboundKickOptions): Promise<void>
  /** Stop accepting work and await any in-flight dispatch + completion write. */
  quiesce(): Promise<void>
  /** Tear down listeners and await quiescence. Idempotent. */
  stop(): Promise<void>
  /** True when the loop is currently dispatching at least one row. */
  isDraining(): boolean
}

const DEFAULT_OPTS: Pick<
  Required<RunnerOptions>,
  | "now"
  | "random"
  | "enforceMobile"
  | "vacuumKeepMs"
  | "dispatchDeadlineMs"
  | "preflightDeadlineMs"
  | "frozenRecheckMs"
  | "claimRenewIntervalMs"
> = {
  now: () => Date.now(),
  random: Math.random,
  enforceMobile: true,
  vacuumKeepMs: 24 * 60 * 60 * 1000,
  dispatchDeadlineMs,
  preflightDeadlineMs: PREFLIGHT_DEADLINE_MS,
  frozenRecheckMs: FROZEN_RECHECK_MS,
  claimRenewIntervalMs: CLAIM_RENEW_INTERVAL_MS,
}

/**
 * Build the runner. Caller must `kick()` once after construction (e.g. in
 * the boot provider). The runner subscribes to `network` change events
 * itself; consumers don't have to plumb online/offline.
 */
export function createOutboundRunner(opts: RunnerOptions): OutboundRunner {
  const {
    dispatcher,
    scope,
    now,
    random,
    enforceMobile,
    vacuumKeepMs,
    canDispatch,
    dispatchDeadlineMs: deadlineFor,
    preflightDeadlineMs,
    frozenRecheckMs,
    claimRenewIntervalMs,
  } = {
    ...DEFAULT_OPTS,
    ...opts,
  }

  let draining = false
  let stopped = false
  let unsubNetwork: (() => void) | null = null
  let activeDrain: Promise<void> | null = null
  /** Rows the pre-flight gate refused, and when each may be asked about again. */
  const frozenUntil = new Map<string, number>()
  /** The one pending wake-up (backoff expiry, abandoned claim, frozen recheck). */
  let wakeTimer: ReturnType<typeof setTimeout> | null = null

  void (async () => {
    unsubNetwork = await subscribeNetwork((status) => {
      if (status.connected && !stopped) {
        void drain()
      }
    })
    // stop() ran while the subscribe was in flight — it saw a null unsub,
    // so drop the just-created listener here.
    if (stopped) {
      try {
        unsubNetwork()
      } catch {
        // Best effort.
      }
    }
  })()

  function clearWake(): void {
    if (wakeTimer !== null) {
      clearTimeout(wakeTimer)
      wakeTimer = null
    }
  }

  /**
   * Arm one timer for the next thing only the clock can move. Everything else
   * that makes a row ready is a write or an event, and already kicks a drain.
   */
  async function scheduleWake(): Promise<void> {
    clearWake()
    if (stopped) return
    const at = now()
    let wakeAt = await nextQueueWakeAt(scope, at).catch(() => null)
    for (const until of frozenUntil.values()) {
      if (until > at && (wakeAt === null || until < wakeAt)) wakeAt = until
    }
    if (wakeAt === null || stopped) return
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_WAKE_DELAY_MS, wakeAt - at))
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      void drain().catch(() => undefined)
    }, delay)
  }

  function drain(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (enforceMobile && detectNativePlatform() !== "mobile") return Promise.resolve()
    if (activeDrain) return activeDrain
    activeDrain = (async () => {
      draining = true
      try {
        // Every drain, not just the first. `releaseStaleClaims` only frees a
        // claim nobody has renewed for `CLAIM_ABANDONED_AFTER_MS`, and every
        // live dispatcher renews its own (see `holdClaim`), so this can never
        // take a row out from under a dispatch that is still running. Doing it
        // once per runner left a claim abandoned shortly before a restart
        // "Sending" for as long as the app then stayed open.
        await releaseStaleClaims(scope, now()).catch(() => 0)
        // Vacuum opportunistically; cheap if nothing to do.
        await vacuumSent(vacuumKeepMs).catch(() => 0)
        // Drain until no more ready rows. Once quiescing begins, finish only
        // the already-claimed row so its terminal write lands in the old DB.
        // Refused in this pass: never asked twice in one drain, whatever the
        // clock says (the hold below is what spans drains).
        const refusedThisDrain = new Set<string>()
        while (!stopped) {
          const at = now()
          for (const [id, until] of frozenUntil) {
            if (until <= at) frozenUntil.delete(id)
          }
          const claimed = await claimNext(
            at,
            scope,
            new Set([...refusedThisDrain, ...frozenUntil.keys()])
          )
          if (!claimed) break
          await holdClaim(claimed.id, async () => {
            if (canDispatch && !(await preflight(claimed))) {
              await releaseClaim(claimed.id)
              refusedThisDrain.add(claimed.id)
              frozenUntil.set(claimed.id, now() + frozenRecheckMs)
              return
            }
            await dispatchOne(claimed)
          })
        }
      } finally {
        draining = false
        activeDrain = null
      }
      await scheduleWake()
    })()
    return activeDrain
  }

  /**
   * Keep a claim visibly alive while `work` runs, so `releaseStaleClaims` — in
   * this runner or another for the same scope — can tell it from one whose
   * process died.
   */
  async function holdClaim(id: string, work: () => Promise<void>): Promise<void> {
    const renewal = setInterval(() => {
      void renewClaim(id, now()).catch(() => undefined)
    }, claimRenewIntervalMs)
    try {
      await work()
    } finally {
      clearInterval(renewal)
    }
  }

  /**
   * The pre-flight gate, bounded. No answer in time, or a gate that threw, is
   * a "not now": the row goes back to `pending` with its attempts untouched.
   * A throw used to escape the drain with the row still claimed, leaving it
   * "Sending" until the claim aged out.
   */
  async function preflight(row: MobileOutboundJobRow): Promise<boolean> {
    if (!canDispatch) return true
    try {
      return await withDeadline(
        Promise.resolve().then(() => canDispatch(row)),
        row.command,
        "preflight",
        preflightDeadlineMs
      )
    } catch (error) {
      if (!(error instanceof OutboundDeadlineError)) {
        console.warn("outbound-queue: pre-flight gate failed; holding the row", error)
      }
      return false
    }
  }

  async function dispatchOne(row: MobileOutboundJobRow): Promise<void> {
    try {
      let idempotencyKey = row.idempotencyKey
      if (row.command === "bot_delivery_replay" || row.command === "bot_trigger_set_armed") {
        const { normalizeLegacyBotWriteKey } = await import("@/lib/bot/control-writes/remote")
        idempotencyKey = await normalizeLegacyBotWriteKey(row)
      }
      const result = await withDeadline(
        dispatcher.call(row.command, row.payload, { idempotencyKey }),
        row.command,
        "dispatch",
        deadlineFor(row.command)
      )
      if (row.protocol === "host-state") {
        const receipt = hostStateReceipt(result, row.actionId)
        if (!receipt) throw new Error("host_state_malformed_response")
        await markHostStateResult(row.id, receipt)
        await settleRefusedHostStateRow(row, receipt.outcome, receipt.rejection?.code)
        await reconcileTerminalHostState(receipt.outcome)
      } else if (row.command === "workflow_step_result") {
        const response = result as { ok?: unknown; reason?: unknown } | null
        if (!response || response.ok !== true) {
          throw new Error(
            typeof response?.reason === "string"
              ? `workflow_step_result rejected: ${response.reason}`
              : "workflow_step_result malformed acknowledgement"
          )
        }
        const requestId = row.payload.requestId
        const seq = row.payload.seq
        if (typeof requestId !== "string" || !Number.isInteger(seq)) {
          throw new Error("workflow_step_result queue payload is malformed")
        }
        await acknowledgeMobileStepResultChunk(requestId, seq as number, now())
        // Result chunks may contain camera data. Unlike ordinary sent rows,
        // never retain these for the 24-hour queue history after Host ACK.
        await deleteRow(row.id)
      } else {
        await markSent(row.id)
      }
    } catch (err) {
      if (row.protocol === "collab-v1" && isCollabConflict(err)) {
        await markCollabConflict(row.id, err.message, err.authoritative)
        return
      }
      if (row.protocol === "host-state") {
        const rejectionCode = terminalHostStateErrorCode(err)
        if (rejectionCode) {
          await markHostStateResult(row.id, {
            outcome: "rejected",
            rejection: { code: rejectionCode },
          })
          await settleRefusedHostStateRow(row, "rejected", rejectionCode)
          await reconcileTerminalHostState("rejected")
          return
        }
      }
      await recordFailure({
        id: row.id,
        error: err,
        nowMs: now(),
        random,
      })
    }
  }

  return {
    async kick(options) {
      if (options?.thaw) frozenUntil.clear()
      await drain()
    },
    async quiesce() {
      clearWake()
      if (!stopped) {
        stopped = true
        if (unsubNetwork) {
          try {
            unsubNetwork()
          } catch {
            // Best effort.
          }
        }
      }
      await activeDrain
    },
    async stop() {
      clearWake()
      if (stopped) {
        await activeDrain
        return
      }
      stopped = true
      if (unsubNetwork) {
        try {
          unsubNetwork()
        } catch {
          // Best effort.
        }
      }
      await activeDrain
    },
    isDraining() {
      return draining
    },
  }
}

function isCollabConflict(
  error: unknown
): error is { status: 409; message: string; authoritative: unknown } {
  return (
    error instanceof Error &&
    (error as { status?: unknown }).status === 409 &&
    "authoritative" in error
  )
}

/**
 * Give a refused list intent its client-side consequence — a local fallback
 * against a Host too old to know it, or discarding an optimistic folder — see
 * `lib/sync/host-state-intent-settlement.ts`. Runs after the receipt is
 * recorded, so it can never turn a settled row back into a retry.
 */
async function settleRefusedHostStateRow(
  row: MobileOutboundJobRow,
  outcome: "applied" | "duplicate" | "rejected" | "conflicted",
  rejectionCode: string | undefined
): Promise<void> {
  if (outcome !== "rejected" && outcome !== "conflicted") return
  const actions = (row.payload as { actions?: unknown }).actions
  const action = Array.isArray(actions) && actions.length === 1 ? actions[0] : undefined
  if (!isHostStateAction(action)) return
  const { settleRejectedHostStateIntent } = await import("@/lib/sync/host-state-intent-settlement")
  await settleRejectedHostStateIntent(action, rejectionCode)
}

async function reconcileTerminalHostState(
  outcome: "applied" | "duplicate" | "rejected" | "conflicted"
): Promise<void> {
  if (outcome !== "rejected" && outcome !== "conflicted") return
  const { remoteEventResyncCoordinator } = await import("@/lib/tauri/resync-coordinator")
  if (!remoteEventResyncCoordinator.hasResolverForEvent("host-state://action")) return
  await remoteEventResyncCoordinator.resolve(["host-state"]).catch(() => undefined)
}

function terminalHostStateErrorCode(error: unknown): string | null {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null
  const candidate =
    (typeof record?.code === "string" ? record.code : undefined) ??
    (error instanceof Error ? error.message : String(error))
  return (
    [
      "stale_host_generation",
      "upgrade_required",
      "host_state_invalid_action",
      "host_state_scope_mismatch",
      "host_state_not_authoritative",
      "host_state_action_too_large",
      // A Host that predates an intent kind refuses the whole submit. Retrying
      // cannot change that answer, and holding the row would block its channel.
      "host_state_invalid_submit_request",
    ].find((code) => candidate.includes(code)) ?? null
  )
}

function hostStateReceipt(
  value: unknown,
  expectedActionId?: string
): {
  outcome: "applied" | "duplicate" | "rejected" | "conflicted"
  rejection?: { code: string; currentRevision?: number }
} | null {
  if (!isHostStateSubmitResponse(value) || value.results.length !== 1) return null
  const receipt = value.results[0]
  if (!receipt || (expectedActionId && receipt.actionId !== expectedActionId)) return null
  const parsedOutcome = receipt.outcome
  const rejectionValue = receipt.rejection
  if (rejectionValue === undefined) return { outcome: parsedOutcome }
  return {
    outcome: parsedOutcome,
    rejection: {
      code: rejectionValue.code,
      ...(rejectionValue.currentRevision === undefined
        ? {}
        : { currentRevision: rejectionValue.currentRevision }),
    },
  }
}

/**
 * Read-only helper for the offline banner / queue UI.
 *
 * Reports the two terminal HostState outcomes alongside the transport ones.
 * They used to be counted by nothing at all: a `rejected` or `conflicted`
 * receipt moved the row out of `pending` and it simply vanished from every
 * surface, so an action the Host had refused looked, to the user, exactly like
 * one that had gone through.
 *
 * Counts `sending` rather than `failed`, which no row can ever hold — see
 * {@link QueueSummary.sending}.
 */
export async function getQueueSummary(): Promise<QueueSummary> {
  const [pending, sending, deadlettered, rejected, conflicted] = await Promise.all([
    listByStatus("pending"),
    listByStatus("sending"),
    listByStatus("deadlettered"),
    listByStatus("rejected"),
    listByStatus("conflicted"),
  ])
  return {
    pending: pending.length,
    sending: sending.length,
    deadlettered: deadlettered.length,
    rejected: rejected.length,
    conflicted: conflicted.length,
  }
}

export interface QueueSummary {
  /** Waiting for a dispatch attempt — including one backing off before a retry. */
  pending: number
  /**
   * Claimed and currently being dispatched.
   *
   * This lane replaces a `failed` count that was structurally always zero:
   * `recordFailure` stores `decideNextAttempt`'s verdict, which is `pending` or
   * `deadlettered`, so no row ever held `failed` and the banner's "in flight"
   * total silently omitted the rows actually on the wire.
   */
  sending: number
  /** Out of retries — the user decides whether to retry or discard. */
  deadlettered: number
  /** The Host refused it outright. Retrying unchanged will fail again. */
  rejected: number
  /** It raced another writer; the client must refresh and re-submit. */
  conflicted: number
}

/** Rows the user must look at, because nothing else will move them. */
export function needsAttention(summary: QueueSummary): number {
  return summary.deadlettered + summary.rejected + summary.conflicted
}

/** Rows still on their way to the Host. */
export function inFlight(summary: QueueSummary): number {
  return summary.pending + summary.sending
}
