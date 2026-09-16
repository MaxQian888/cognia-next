/**
 * The only way shared code reaches Router + Fusion (ADR-0188 D37).
 *
 * Shared send, gateway and sidecar-facing modules may import `lib/router-fusion/
 * gate/*` statically and nothing else; everything behind the gate is loaded
 * here, dynamically, and only after `routerFusionGate(...)` said "on". A switch
 * that is off therefore loads no Router + Fusion code at all.
 *
 * A failed import is an infrastructure fault (`import_failed`), and it is not
 * cached: a chunk that failed to load once (a flaky dev server, an update being
 * installed) gets another chance on the next turn.
 */

import { RouterFusionInfrastructureError } from "./faults"

export type RouterFusionHost = typeof import("../host")

let loading: Promise<RouterFusionHost> | null = null

export function loadRouterFusionHost(
  importer: () => Promise<RouterFusionHost> = () => import("../host")
): Promise<RouterFusionHost> {
  if (!loading) {
    loading = importer().catch((error: unknown) => {
      loading = null
      throw new RouterFusionInfrastructureError(
        "import_failed",
        `Router + Fusion could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
    })
  }
  return loading
}

export function __resetRouterFusionHostForTesting(): void {
  loading = null
}
