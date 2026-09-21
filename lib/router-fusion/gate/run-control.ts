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
 * rows), chat cascade and panel runs (`local` rows, B3) and companion runs
 * (`local` rows too, B4 — a paired device is the same person at another
 * screen). Every other Router + Fusion run is stopped through the engine that
 * owns it.
 */
export const PROJECTED_RUN_SURFACES = ["gatewayRuns", "chat", "companion"] as const
export type ProjectedRunSurface = (typeof PROJECTED_RUN_SURFACES)[number]

export interface CancelRouterFusionRunDeps {
  settings: RouterFusionGateSettings | null | undefined
  /** The surface the run belongs to; a Run API run when omitted. */
  surface?: ProjectedRunSurface
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

/**
 * Which Router + Fusion surface a projected run belongs to, read from the run
 * itself.
 *
 * The cockpit knows only the projected ORIGIN, and two surfaces project as
 * `local`: a chat cascade/panel and a companion run. They are gated
 * differently — one by the `chat` switch, the other by `companion` — so a
 * control that guessed from the origin would refuse a companion run on a
 * device where chat is off, and check the wrong breaker where it is on.
 *
 * Nothing is opened when every projected surface is off: `null` then, and the
 * caller falls back to what the projection suggested, which refuses with the
 * honest "switched off" message.
 */
export async function projectedRunSurfaceOf(
  runId: string,
  deps: {
    settings: RouterFusionGateSettings | null | undefined
    loadHost?: () => Promise<RouterFusionHost>
  }
): Promise<ProjectedRunSurface | null> {
  const readable = PROJECTED_RUN_SURFACES.some(
    (surface) => routerFusionGate(deps.settings, surface) === "on"
  )
  if (!readable) return null
  try {
    const host = await (deps.loadHost ?? loadRouterFusionHost)()
    const store = await host.currentFusionStore()
    const run = await store.getRun(runId)
    const surface = run?.surface
    return surface && (PROJECTED_RUN_SURFACES as readonly string[]).includes(surface)
      ? (surface as ProjectedRunSurface)
      : null
  } catch {
    // Reading which surface a run belongs to is a hint, not the control. A
    // fault here falls back to the projection's guess, and the control itself
    // still fails explicitly (D38).
    return null
  }
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

export interface DecideRouterFusionApprovalDeps extends CancelRouterFusionRunDeps {
  /** The interrupt the person answered; it is the approval's own id (API-08). */
  interruptId?: string | null
  /** Drive the resumed run. The cockpit's own control plane has no driver. */
  drive?: (runId: string) => void
}

/**
 * Answer, from the cockpit, the approval a parked delegate run is waiting on
 * (ADR-0188 B4, D21).
 *
 * The cockpit's `expectedRevision` belongs to the EXECUTION run, not the
 * fusion run, and the control gate has already checked it before any handler
 * runs — so the binding that matters here is the one API-08 is about: the
 * interrupt id, which is derived from the request digest. A stale or foreign
 * id is refused and the standing request is left pending.
 *
 * Deliberately no actor check, for the reason stopping has none: whoever is at
 * the device may decide what the device is about to do to their own files.
 */
export async function decideRouterFusionApproval(
  runId: string,
  decision: "approve" | "deny",
  deps: DecideRouterFusionApprovalDeps
): Promise<void> {
  const surface = deps.surface ?? "gatewayRuns"
  const gate = routerFusionGate(deps.settings, surface)
  if (gate === "tripped") throw trippedSurfaceError(surface)
  if (gate !== "on") {
    throw new Error("Router + Fusion runs are switched off for this host")
  }
  const load = deps.loadHost ?? loadRouterFusionHost
  await runExplicitFusion<void>({
    surface,
    threshold: breakerThresholdOf(deps.settings),
    fusion: async () => {
      const host = await load()
      const store = await host.currentFusionStore()
      const { decideFusionApproval } = await import("../runtime/delegate-approvals")
      const outcome = await decideFusionApproval(store, {
        runId,
        approvalId: deps.interruptId ?? null,
        decision,
      })
      if (!outcome.ok) {
        // A refusal the person can act on, not a silent no-op: the control
        // plane turns a throw into `source_rejected` with this message.
        throw new Error(`the decision was refused: ${outcome.code}`)
      }
      // The resumed run must be driven by something; the cockpit is not a
      // worker. `run-driver.ts` takes the lease and carries on from the
      // journal, replaying the steps that already happened.
      if (deps.drive) deps.drive(runId)
      else {
        const { liveSettingsReader } = await import("../calls/live-settings")
        host.driveRun(runId, liveSettingsReader(null))
      }
      await host.drainAccountOutbox(store).catch(() => undefined)
    },
  })
}
