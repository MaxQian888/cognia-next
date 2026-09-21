/**
 * The learned router's active-manifest pointer, as an evaluation configuration
 * target (ADR-0188 B6).
 *
 * `lib/ai/eval/configuration-targets.ts` reads and writes a recommended
 * configuration through one `read`/`write` pair per target type, and records
 * the previous value so a rollback is a single call. Promotion of a learned
 * router is exactly that shape — one pointer, one previous value — so it goes
 * through the same mechanism as a recommended default model or routing policy
 * rather than growing a second rollback story of its own.
 *
 * The value is deliberately tiny: `{ manifestSha256: string | null }`. The
 * manifests themselves live in the fusion database and are never copied into
 * the account database, so a rollback record carries a 64-character pointer,
 * not a model.
 *
 * Every entry point re-checks the gate. A configuration apply can be triggered
 * from a recommendation flow that knows nothing about Router + Fusion, and with
 * every surface off that must not open the fusion database.
 */

import { effectiveSurface, ROUTER_FUSION_SURFACES } from "@cognia/router-fusion/settings/switches"

import { currentRouterFusionGateSettings } from "../gate/current-settings"
import { currentFusionStore } from "../chat/store-provider"
import {
  activatePredictorManifest,
  activePredictorManifest,
  deactivatePredictor,
} from "./routing-store"
import { ROUTING_FEATURES_VERSION } from "./routing-sample"

export interface ActivePredictorPointer {
  manifestSha256: string | null
}

export class RoutingPredictorTargetUnavailableError extends Error {
  constructor() {
    super("Router + Fusion is off on every surface; the learned router cannot be changed")
    this.name = "RoutingPredictorTargetUnavailableError"
  }
}

async function assertAvailable(): Promise<void> {
  const settings = await currentRouterFusionGateSettings()
  const routerFusion = (settings as { routerFusion?: unknown } | null)?.routerFusion as
    Parameters<typeof effectiveSurface>[0] | undefined
  const on = ROUTER_FUSION_SURFACES.some((surface) => effectiveSurface(routerFusion, surface))
  if (!on) throw new RoutingPredictorTargetUnavailableError()
}

/** The manifest currently in front of the shadow router, or null when none is. */
export async function readActivePredictorPointer(): Promise<ActivePredictorPointer> {
  await assertAvailable()
  const store = await currentFusionStore()
  const row = await activePredictorManifest(store.db)
  return { manifestSha256: row?.manifestSha256 ?? null }
}

/**
 * Move the pointer. A sha256 promotes that manifest (it must already be sealed
 * into the registry and published); null switches the learned router off.
 */
export async function writeActivePredictorPointer(
  value: ActivePredictorPointer,
  options: { now: number }
): Promise<void> {
  await assertAvailable()
  const store = await currentFusionStore()
  if (value.manifestSha256 === null) {
    await deactivatePredictor(store.db, { now: options.now })
    return
  }
  await activatePredictorManifest(store.db, value.manifestSha256, {
    now: options.now,
    expectedFeaturesVersion: ROUTING_FEATURES_VERSION,
  })
}

/** Parse the configuration value a generic apply hands back. */
export function parseActivePredictorPointer(
  value: Record<string, unknown>
): ActivePredictorPointer {
  const raw = value.manifestSha256
  if (raw === null || raw === undefined) return { manifestSha256: null }
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) {
    throw new Error("manifestSha256 must be a 64-character hex digest or null")
  }
  return { manifestSha256: raw }
}
