/**
 * Stopping a Router + Fusion run from this device (ADR-0188 D21/D24, B2).
 *
 * `/agent-runs` renders its buttons from the projection's `allowedActions`, and
 * a projected `fusion` row offers `stop`. The control plane dispatches by run
 * KIND, so the handler itself lives in the shared `lib/execution/control-handlers.ts`
 * and reaches the engine through this module — the only Router + Fusion import a
 * shared module may hold, and the reason the engine still loads lazily.
 *
 * Deliberately NOT `cancelRunFromApi`: that check exists so one API key cannot
 * touch another's run (AUTH-03), and the person at this machine is not an API
 * key. Whoever is at the device may stop work the device is doing; the key that
 * asked learns about it the same way it learns about any other terminal state.
 *
 * Pressing stop is explicitly chosen fusion work, so an infrastructure fault
 * fails with `ROUTER_FUSION_UNAVAILABLE` rather than reporting a cancel that did
 * not happen (D38).
 */

import { breakerThresholdOf, routerFusionGate, type RouterFusionGateSettings } from "./feature-gate"
import { runExplicitFusion, trippedSurfaceError } from "./guard"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"

/**
 * The surfaces whose runs are projected as `fusion` rows (see
 * `projectedOriginOf` in `db/ledger-store.ts`): Run API runs (`gateway-api`
 * rows) and chat cascade and panel runs (`local` rows, B3). Every other Router +
 * Fusion run is stopped through the engine that owns it.
 */
export type ProjectedRunSurface = "gatewayRuns" | "chat"

export interface CancelRouterFusionRunDeps {
  settings: RouterFusionGateSettings | null | undefined
  /** The surface the run belongs to; a Run API run when omitted. */
  surface?: ProjectedRunSurface
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

/**
 * Cancel one projected fusion run. `false` means there was no such run — the
 * caller reports that rather than claiming a cancel.
 */
export async function cancelRouterFusionRun(
  runId: string,
  deps: CancelRouterFusionRunDeps
): Promise<boolean> {
  const surface = deps.surface ?? "gatewayRuns"
  const gate = routerFusionGate(deps.settings, surface)
  if (gate === "tripped") throw trippedSurfaceError(surface)
  if (gate !== "on") {
    // The row is in the cockpit because the run happened; the switch went off
    // afterwards. Saying so is better than a button that silently does nothing.
    throw new Error("Router + Fusion runs are switched off for this host")
  }
  const load = deps.loadHost ?? loadRouterFusionHost
  return runExplicitFusion<boolean>({
    surface,
    threshold: breakerThresholdOf(deps.settings),
    fusion: async () => {
      const host = await load()
      const store = await host.currentFusionStore()
      const cancelled = (await store.cancelRun(runId)) !== undefined
      // A queued run is sealed right here, with no worker left to drain what
      // the seal queued, so the cockpit row would stay "queued". Apply it now.
      if (cancelled) await host.drainAccountOutbox(store).catch(() => undefined)
      return cancelled
    },
  })
}
