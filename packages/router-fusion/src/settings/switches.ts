/**
 * The Router + Fusion on/off question, as a zero-import leaf (ADR-0188 D36/D37).
 *
 * Host call sites on the shared send, gateway and utility paths may import this
 * module statically — and nothing else from `@cognia/router-fusion`. It pulls
 * in no schemas, no ledger and no workflow code, so with every switch off the
 * only Router + Fusion code that ever runs is `effectiveSurface` returning
 * false. `scripts/gates/check-router-fusion-gate.mjs` enforces the boundary.
 */

export const ROUTER_FUSION_SURFACES = [
  "chat",
  "gatewayRuns",
  "gatewayPassthroughLedger",
  "agentsWorkflows",
  "utilityLedger",
  "companion",
] as const
export type RouterFusionSurface = (typeof ROUTER_FUSION_SURFACES)[number]

/**
 * The surfaces this build wires. Every other surface is DORMANT: its switch is
 * declared so settings round-trip unchanged across releases, but no call site
 * reads it yet — the settings section shows it disabled and labelled "later
 * release", and `switches.test.ts` pins the list. Turning a dormant switch on
 * by editing the stored settings changes nothing.
 */
export const WIRED_ROUTER_FUSION_SURFACES: readonly RouterFusionSurface[] = [
  "chat",
  "gatewayRuns",
  "gatewayPassthroughLedger",
  "utilityLedger",
  "agentsWorkflows",
]

export function isRouterFusionSurfaceWired(surface: RouterFusionSurface): boolean {
  return WIRED_ROUTER_FUSION_SURFACES.includes(surface)
}

/** The persisted shape the switch check reads; everything else is optional to it. */
export interface RouterFusionSwitches {
  enabled?: unknown
  surfaces?: Partial<Record<RouterFusionSurface, unknown>> | null
}

/**
 * Is this surface running under Router + Fusion right now? True only when the
 * master switch AND the surface switch are literally `true` — a missing,
 * malformed or truthy-but-not-boolean value is off.
 */
export function effectiveSurface(
  settings: RouterFusionSwitches | null | undefined,
  surface: RouterFusionSurface
): boolean {
  if (!settings || settings.enabled !== true) return false
  const surfaces = settings.surfaces
  return Boolean(surfaces && typeof surfaces === "object" && surfaces[surface] === true)
}
