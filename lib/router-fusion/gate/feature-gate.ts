/**
 * The Router + Fusion gate every shared call site asks first (ADR-0188 D36–D38).
 *
 *   off      master or surface switch is not literally on → run the existing code,
 *            untouched. This is the default for every user.
 *   on       run the surface under Router + Fusion.
 *   tripped  the surface is on but its breaker is open → ordinary traffic runs
 *            the existing code (with a notice); explicit fusion work fails.
 *
 * Call sites write `if (routerFusionGate(settings, surface) !== "on") { …existing… }`
 * and dynamically import everything else. This module and its imports are the
 * only Router + Fusion code the off path ever evaluates.
 */

import {
  effectiveSurface,
  type RouterFusionSurface,
  type RouterFusionSwitches,
} from "@cognia/router-fusion/settings/switches"

import { isSurfaceTripped } from "./breaker"

export type RouterFusionGateState = "off" | "on" | "tripped"

export interface RouterFusionGateSettings {
  routerFusion?:
    | (RouterFusionSwitches & {
        trippedSurfaces?: Partial<Record<RouterFusionSurface, { trippedAt?: unknown } | undefined>>
      })
    | null
}

export function routerFusionGate(
  settings: RouterFusionGateSettings | null | undefined,
  surface: RouterFusionSurface
): RouterFusionGateState {
  const routerFusion = settings?.routerFusion
  if (!effectiveSurface(routerFusion, surface)) return "off"
  if (isSurfaceTripped(surface)) return "tripped"
  const persisted = routerFusion?.trippedSurfaces?.[surface]
  if (persisted && typeof persisted.trippedAt === "number") return "tripped"
  return "on"
}

/** Consecutive faults before a trip, from the persisted settings (default 3). */
export function breakerThresholdOf(settings: RouterFusionGateSettings | null | undefined): number {
  const raw = (settings?.routerFusion as { breakerThreshold?: unknown } | null | undefined)
    ?.breakerThreshold
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= 100 ? raw : 3
}
