/**
 * Consolidated heartbeat sweep (v51).
 *
 * Replaces the old per-adapter timer fan-out (one active 30 s `setInterval`
 * for every adapter + one passive 60 s `setInterval` for every passive
 * adapter — up to 2N timers) with a SINGLE bus-scope interval that services
 * all running adapters per tick. It reuses `recordHeartbeatNow` /
 * `recordPassiveProbe` verbatim, so the written rows are identical; only the
 * scheduling is consolidated.
 *
 * Per tick (default 30 s):
 *   - active heartbeat for every running adapter;
 *   - on every PASSIVE_EVERY_N-th tick (≈60 s) the passive probe additionally
 *     fires for passive-transport adapters (Lark webhook, OneBot reverse-WS),
 *     matching the previous 60 s passive cadence.
 *
 * All per-adapter work runs through `Promise.allSettled` so a single slow
 * network ping (Lark `bot/v3/info`, 5 s timeout) can never delay another
 * adapter's heartbeat — preserving the isolation the per-adapter timers had.
 */

import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import { listRunningAdapters, requeueAdapter } from "@/lib/connectors/lifecycle"
import { appendAudit } from "@/lib/connectors/audit"
import { recordHeartbeatNow, HEARTBEAT_INTERVAL_MS } from "./heartbeat"
import {
  recordPassiveProbe,
  benefitsFromProbe,
  type DerivedHeartbeat,
  IDLE_THRESHOLD_MS,
  PASSIVE_HEARTBEAT_INTERVAL_MS,
} from "./passive-heartbeat"

/**
 * Run the passive probe on every Nth sweep tick. Derived from the two cadences
 * so the relationship stays explicit: 60 s / 30 s = 2. `max(1, …)` guards
 * against a future config where the passive cadence is ≤ the sweep interval.
 */
export const PASSIVE_EVERY_N = Math.max(
  1,
  Math.round(PASSIVE_HEARTBEAT_INTERVAL_MS / HEARTBEAT_INTERVAL_MS)
)

export interface HeartbeatSweepHandle {
  /** Stop the sweep. Idempotent. */
  dispose(): void
}

export interface StartHeartbeatSweepOptions {
  /** Override the sweep interval (tests use a small value). Default 30 s. */
  intervalMs?: number
  /** Override the clock (tests). */
  now?: () => number
  /** Override the timer scheduler (tests). */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  /** Source of running adapters (default: the lifecycle registry). */
  listAdapters?: () => { adapter: PlatformAdapter }[]
  /** Active-heartbeat writer (default: `recordHeartbeatNow`). Test seam. */
  recordHeartbeat?: (adapter: PlatformAdapter, now: number) => Promise<unknown>
  /** Passive-probe writer (default: `recordPassiveProbe`). Test seam. */
  recordPassive?: (row: AdapterInstanceRow, now: number) => Promise<unknown>
  /** Re-dial a probe-failed gateway (default: lifecycle requeue). */
  requeue?: (adapterId: string) => Promise<boolean>
  /** Audit a successful probe-driven redial. */
  auditReconnect?: (adapterId: string, at: number) => Promise<unknown>
  /** Loader for adapter rows used in passive gating (default: Dexie). */
  loadRows?: () => Promise<AdapterInstanceRow[]>
}

/**
 * Start the single heartbeat sweep. Returns a disposer the caller must invoke
 * on teardown. The first tick fires immediately so the Health view has data
 * without waiting one full interval (matching the old per-adapter behaviour).
 */
export function startHeartbeatSweep(
  options: StartHeartbeatSweepOptions = {}
): HeartbeatSweepHandle {
  const {
    intervalMs = HEARTBEAT_INTERVAL_MS,
    now,
    scheduler = {
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    listAdapters = listRunningAdapters,
    recordHeartbeat = (adapter, at) => recordHeartbeatNow(adapter, { now: () => at }),
    recordPassive = (row, at) => recordPassiveProbe(row, at, IDLE_THRESHOLD_MS),
    requeue = requeueAdapter,
    auditReconnect = (adapterId, at) =>
      appendAudit({
        adapterId,
        kind: "adapter.resumed",
        at,
        fields: { reason: "probe_failure" },
      }),
    loadRows = () => getDb().adapterInstances.toArray(),
  } = options

  const clock = now ?? Date.now
  let disposed = false
  let tickIndex = 0
  // Guards against overlapping sweeps: if one tick's per-adapter work (Dexie
  // prune + put + the 5 s Lark ping on passive ticks) ever outruns the
  // interval, the scheduler's next fire is skipped rather than piling a second
  // concurrent sweep on top of the first.
  let sweepRunning = false

  async function runSweepOnce(idx: number): Promise<void> {
    const running = listAdapters()
    if (running.length === 0) return
    const at = clock()

    const tasks: Promise<unknown>[] = running.map((entry) =>
      Promise.resolve(recordHeartbeat(entry.adapter, at)).catch(() => undefined)
    )

    // Passive probe on every Nth tick. Passive adapters also get the active
    // heartbeat above — mirroring the previous "both timers fire" behaviour.
    if (idx % PASSIVE_EVERY_N === 0) {
      let rows: AdapterInstanceRow[] = []
      try {
        rows = await loadRows()
      } catch {
        rows = []
      }
      const rowById = new Map(rows.map((r) => [r.id, r]))
      for (const entry of running) {
        const row = rowById.get(entry.adapter.id)
        if (row && benefitsFromProbe(row)) {
          tasks.push(
            Promise.resolve(recordPassive(row, at))
              .then(async (result) => {
                if (!isFailedProbe(result)) return
                if (await requeue(row.id)) await auditReconnect(row.id, at)
              })
              .catch(() => undefined)
          )
        }
      }
    }

    await Promise.allSettled(tasks)
  }

  const tick = () => {
    if (disposed || sweepRunning) return
    sweepRunning = true
    void runSweepOnce(tickIndex++)
      .catch(() => undefined)
      .finally(() => {
        sweepRunning = false
      })
  }

  tick()
  const handle = scheduler.setInterval(tick, intervalMs)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      scheduler.clearInterval(handle)
    },
  }
}

function isFailedProbe(value: unknown): value is DerivedHeartbeat {
  return (
    !!value &&
    typeof value === "object" &&
    "state" in value &&
    (value as { state?: unknown }).state === "degraded" &&
    "pingOk" in value &&
    (value as { pingOk?: unknown }).pingOk === false
  )
}
