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
 * The runner is platform-agnostic: it short-circuits to a no-op when
 * `usePlatform() === "web"` and only the desktop is reachable. Outside the
 * mobile shell it never runs.
 */

import {
  claimNext,
  listByStatus,
  markSent,
  recordFailure,
  vacuumSent,
} from "@/lib/db/mobile-outbound-queue"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { detectNativePlatform } from "@/lib/capacitor/_shared"
import { subscribe as subscribeNetwork } from "@/lib/capacitor/network"

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
}

export interface OutboundRunner {
  /** Kick a single drain pass — useful immediately after enqueue. */
  kick(): Promise<void>
  /** Tear down listeners. Idempotent. */
  stop(): void
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
  const { dispatcher, now, random, enforceMobile, vacuumKeepMs } = {
    ...DEFAULT_OPTS,
    ...opts,
  }

  let draining = false
  let stopped = false
  let unsubNetwork: (() => void) | null = null

  void (async () => {
    unsubNetwork = await subscribeNetwork((status) => {
      if (status.connected && !stopped) {
        void drain()
      }
    })
  })()

  async function drain(): Promise<void> {
    if (stopped) return
    if (enforceMobile && detectNativePlatform() !== "mobile") return
    if (draining) return
    draining = true
    try {
      // Vacuum opportunistically; cheap if nothing to do.
      await vacuumSent(vacuumKeepMs).catch(() => 0)
      // Drain until no more ready rows.
      while (!stopped) {
        const claimed = await claimNext(now())
        if (!claimed) break
        await dispatchOne(claimed)
      }
    } finally {
      draining = false
    }
  }

  async function dispatchOne(row: MobileOutboundJobRow): Promise<void> {
    try {
      await dispatcher.call(row.command, row.payload, {
        idempotencyKey: row.idempotencyKey,
      })
      await markSent(row.id)
    } catch (err) {
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
    stop() {
      if (stopped) return
      stopped = true
      if (unsubNetwork) {
        try {
          unsubNetwork()
        } catch {
          // Best effort.
        }
      }
    },
    isDraining() {
      return draining
    },
  }
}

/**
 * Read-only helper for the offline banner / queue UI.
 */
export async function getQueueSummary(): Promise<{
  pending: number
  failed: number
  deadlettered: number
}> {
  const [pending, failed, deadlettered] = await Promise.all([
    listByStatus("pending"),
    listByStatus("failed"),
    listByStatus("deadlettered"),
  ])
  return {
    pending: pending.length,
    failed: failed.length,
    deadlettered: deadlettered.length,
  }
}
