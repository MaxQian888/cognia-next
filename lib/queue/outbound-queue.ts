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
  claimNext,
  deleteRow,
  listByStatus,
  markHostStateResult,
  markCollabConflict,
  markSent,
  recordFailure,
  releaseClaim,
  releaseStaleClaims,
  vacuumSent,
} from "@/lib/db/mobile-outbound-queue"
import { acknowledgeMobileStepResultChunk } from "@/lib/db/mobile-step-receipts"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { isHostStateSubmitResponse } from "@cognia/agent-config-types/host-state"
import { detectNativePlatform } from "@/lib/capacitor/_shared"
import { subscribe as subscribeNetwork } from "@/lib/capacitor/network"
import type { RuntimeTargetScope } from "@/lib/runtime/runtime-target-context"

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
}

export interface OutboundRunner {
  /** Kick a single drain pass — useful immediately after enqueue. */
  kick(): Promise<void>
  /** Stop accepting work and await any in-flight dispatch + completion write. */
  quiesce(): Promise<void>
  /** Tear down listeners and await quiescence. Idempotent. */
  stop(): Promise<void>
  /** True when the loop is currently dispatching at least one row. */
  isDraining(): boolean
}

const DEFAULT_OPTS: Pick<
  Required<RunnerOptions>,
  "now" | "random" | "enforceMobile" | "vacuumKeepMs"
> = {
  now: () => Date.now(),
  random: Math.random,
  enforceMobile: true,
  vacuumKeepMs: 24 * 60 * 60 * 1000,
}

/**
 * Build the runner. Caller must `kick()` once after construction (e.g. in
 * the boot provider). The runner subscribes to `network` change events
 * itself; consumers don't have to plumb online/offline.
 */
export function createOutboundRunner(opts: RunnerOptions): OutboundRunner {
  const { dispatcher, scope, now, random, enforceMobile, vacuumKeepMs, canDispatch } = {
    ...DEFAULT_OPTS,
    ...opts,
  }

  let draining = false
  let stopped = false
  let unsubNetwork: (() => void) | null = null
  let activeDrain: Promise<void> | null = null
  /**
   * Rows a predecessor left mid-dispatch are reclaimed once, on the first
   * drain. A `sending` row now holds its channel's head, so leaving one behind
   * blocks every later action on that session forever.
   *
   * The flag is per-runner, so it cannot by itself keep a second runner off a
   * row this one is mid-dispatch on — `releaseStaleClaims` decides that by the
   * age of the claim, not by who is asking.
   */
  let staleClaimsReleased = false

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

  function drain(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (enforceMobile && detectNativePlatform() !== "mobile") return Promise.resolve()
    if (activeDrain) return activeDrain
    activeDrain = (async () => {
      draining = true
      try {
        if (!staleClaimsReleased) {
          staleClaimsReleased = true
          await releaseStaleClaims(scope, now()).catch(() => 0)
        }
        // Vacuum opportunistically; cheap if nothing to do.
        await vacuumSent(vacuumKeepMs).catch(() => 0)
        const frozenIds = new Set<string>()
        // Drain until no more ready rows. Once quiescing begins, finish only
        // the already-claimed row so its terminal write lands in the old DB.
        while (!stopped) {
          const claimed = await claimNext(now(), scope, frozenIds)
          if (!claimed) break
          if (canDispatch && !(await canDispatch(claimed))) {
            await releaseClaim(claimed.id)
            frozenIds.add(claimed.id)
            continue
          }
          await dispatchOne(claimed)
        }
      } finally {
        draining = false
        activeDrain = null
      }
    })()
    return activeDrain
  }

  async function dispatchOne(row: MobileOutboundJobRow): Promise<void> {
    try {
      const result = await dispatcher.call(row.command, row.payload, {
        idempotencyKey: row.idempotencyKey,
      })
      if (row.protocol === "host-state") {
        const receipt = hostStateReceipt(result, row.actionId)
        if (!receipt) throw new Error("host_state_malformed_response")
        await markHostStateResult(row.id, receipt)
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
    async kick() {
      await drain()
    },
    async quiesce() {
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
