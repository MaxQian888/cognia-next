/**
 * Router + Fusion work at window boot (ADR-0188 D38/D39).
 *
 * Recovery: a window that closed mid-turn left its run holding the session lock
 * and the budget hold. The run's lease lapses on its own; this sweep seals such
 * runs and replays their outbox as soon as a window opens, instead of waiting
 * for the next send on that session to find them. An orchestrated run (a Run
 * API run, a chat panel) is not lost with its window: on a surface that is
 * still on, the sweep drives it again from the ledger (REC-03). It covers every wired
 * surface, because a Run API run or a utility call can be abandoned the same
 * way a chat turn can. A fault here is a fault like any other — counted,
 * never thrown into the boot sequence.
 *
 * Retention: a daily sweep applies the fusion database's retention
 * (`db/retention.ts`). It is maintenance, not traffic, so a failure is logged
 * and retried on the next tick; it never feeds a surface's breaker, which
 * would take a working surface away from the user over housekeeping.
 *
 * Both only while a wired surface is on: the off path neither loads Router +
 * Fusion nor opens its database.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { WIRED_ROUTER_FUSION_SURFACES } from "@cognia/router-fusion/settings/switches"

import { recordFusionFault } from "./breaker"
import { toInfrastructureFault } from "./faults"
import { breakerThresholdOf, routerFusionGate, type RouterFusionGateSettings } from "./feature-gate"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"

type FusionRetentionReport = Awaited<ReturnType<RouterFusionHost["pruneFusionDatabase"]>>

/** Retention runs once a day, matching the day resolution of its windows. */
export const ROUTER_FUSION_RETENTION_INTERVAL_MS = 86_400_000

/** The wired surfaces currently switched on. Empty means nothing to sweep or load. */
function liveSurfaces(settings: RouterFusionGateSettings | null | undefined) {
  return WIRED_ROUTER_FUSION_SURFACES.filter(
    (surface) => routerFusionGate(settings, surface) === "on"
  )
}

/** Seal the runs earlier windows abandoned. Returns how many, or null when nothing ran. */
export async function recoverRouterFusionRuns(
  settings: RouterFusionGateSettings | null | undefined,
  loadHost: () => Promise<RouterFusionHost> = loadRouterFusionHost
): Promise<number | null> {
  const live = liveSurfaces(settings)
  if (live.length === 0) return null
  const onFault = (error: unknown) => {
    const fault = toInfrastructureFault(error)
    // One database, one sweep: a fault here is every live surface's problem,
    // so it counts against each of them rather than against whichever one the
    // sweep happened to be named after.
    const now = Date.now()
    for (const surface of live) {
      recordFusionFault(surface, fault?.code ?? "internal", breakerThresholdOf(settings), now)
    }
    console.warn("[router-fusion] boot recovery could not run", error)
  }
  try {
    const host = await loadHost()
    return await host.recoverStaleFusionRuns({
      ...host.chatRunDeps(onFault),
      // An orchestrated run on a live surface is carried on, not sealed. Every
      // caller hands this sweep the full account settings; the gate type only
      // names the part it reads.
      resumeOrchestrated: host.orchestratedRunResumer(
        settings as AppSettings | null | undefined,
        live
      ),
    })
  } catch (error) {
    onFault(error)
    return null
  }
}

/** Apply the fusion database's retention once. Null when no wired surface is on or the sweep failed. */
export async function pruneRouterFusionData(
  settings: RouterFusionGateSettings | null | undefined,
  loadHost: () => Promise<RouterFusionHost> = loadRouterFusionHost,
  now: () => number = Date.now
): Promise<FusionRetentionReport | null> {
  if (liveSurfaces(settings).length === 0) return null
  try {
    const host = await loadHost()
    const store = await host.currentFusionStore()
    return await host.pruneFusionDatabase(store.db, now())
  } catch (error) {
    console.warn("[router-fusion] retention sweep could not run", error)
    return null
  }
}

export interface RetentionScheduleDeps {
  loadHost?: () => Promise<RouterFusionHost>
  intervalMs?: number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

/**
 * Sweep now and then daily. Each tick re-reads the settings, so switching the
 * surface off stops the work at the next tick even before the caller stops the
 * schedule. Overlapping ticks are skipped. Returns the stop function.
 *
 * The reader may be asynchronous: the desktop window reads its loaded store,
 * while a headless brain reads the account row from the database each tick.
 */
export function startRouterFusionRetention(
  readSettings: () =>
    | RouterFusionGateSettings
    | null
    | undefined
    | Promise<RouterFusionGateSettings | null | undefined>,
  deps: RetentionScheduleDeps = {}
): () => void {
  const schedule = deps.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms))
  const cancel =
    deps.clearInterval ??
    ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>))
  let running = false
  let stopped = false
  const sweep = () => {
    if (running || stopped) return
    running = true
    void Promise.resolve()
      .then(readSettings)
      .then((settings) => (stopped ? null : pruneRouterFusionData(settings, deps.loadHost)))
      .catch((error: unknown) => {
        // An unreadable settings row is a skipped tick, never a crashed schedule.
        console.warn("[router-fusion] retention could not read its settings", error)
      })
      .finally(() => {
        running = false
      })
  }
  sweep()
  const handle = schedule(sweep, deps.intervalMs ?? ROUTER_FUSION_RETENTION_INTERVAL_MS)
  return () => {
    stopped = true
    cancel(handle)
  }
}
