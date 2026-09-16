/**
 * Typed accessor over the interceptor points declared in the canonical plugin
 * point registry.
 *
 * The declarations themselves live in `lib/plugin/contracts/plugin-points.ts`
 * beside every other point contract, so `audit:slots`, the generated
 * `plugin-points.json` mirror, the docs table and the SDK all keep seeing one
 * catalog. This module is only the dispatcher-shaped read of it — it adds no
 * entries and holds no state of its own.
 */

import {
  CANONICAL_INTERCEPTOR_POINTS,
  INTERCEPTOR_POINT_SEMANTICS,
  getInterceptorPointContract,
  type CanonicalInterceptorPoint,
} from "@/lib/plugin/contracts/plugin-points"
import type { InterceptorPointSemantics } from "./types"

export { CANONICAL_INTERCEPTOR_POINTS, type CanonicalInterceptorPoint }

const pointSet = new Set<string>(CANONICAL_INTERCEPTOR_POINTS)

export function isInterceptorPoint(pointId: string): pointId is CanonicalInterceptorPoint {
  return pointSet.has(pointId)
}

/** Execution semantics for a point, or undefined when the id is unknown. */
export function getInterceptorPoint(pointId: string): InterceptorPointSemantics | undefined {
  return isInterceptorPoint(pointId) ? INTERCEPTOR_POINT_SEMANTICS[pointId] : undefined
}

/**
 * Semantics for a point that must exist.
 *
 * Dispatching an unknown point is a host bug, not a plugin one — the point id
 * is a literal in host code — so it throws rather than degrading to a default
 * that would silently pick a failure policy nobody declared.
 */
export function requireInterceptorPoint(pointId: string): InterceptorPointSemantics {
  const point = getInterceptorPoint(pointId)
  if (!point) {
    throw new Error(`[interceptors] unknown interceptor point "${pointId}"`)
  }
  return point
}

/** True when the host actually fires this point today. */
export function isInterceptorPointLive(pointId: string): boolean {
  if (!isInterceptorPoint(pointId)) return false
  return getInterceptorPointContract(pointId).status === "implemented"
}

export function listInterceptorPoints(): readonly CanonicalInterceptorPoint[] {
  return CANONICAL_INTERCEPTOR_POINTS
}
