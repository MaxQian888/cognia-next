import { join } from "node:path"

import { appRoutePages, REPO_ROOT, reachesSource, routeSegment } from "./route-module-graph"

/**
 * Routes that deliberately render no wallpaper, with the reason. Everything
 * here is either a paint-through native window (the wallpaper is force-disabled
 * for those in `background-applier.tsx` and again in globals.css), a chrome-less
 * full-bleed surface that owns its own backdrop, or a route with no visual
 * output at all.
 */
const EXEMPT: Record<string, string> = {
  inbox: "redirect-only route — renders nothing",
  "deep-link": "invisible handoff route, redirects immediately",
  fleet: "transparent island window — wallpaper is force-disabled there",
  island: "transparent island window — wallpaper is force-disabled there",
  onboarding: "owns a full-bleed narrative backdrop (ADR-0141)",
  pet: "transparent pet window — wallpaper is force-disabled there",
  "pet-overlay": "transparent pet window — wallpaper is force-disabled there",
  "pet-popup": "transparent pet window — wallpaper is force-disabled there",
  portal: "standalone public surface, not the app shell",
  "recorder-controller": "transparent recorder window — wallpaper force-disabled",
  "selection-toolbar": "transparent measuring window — wallpaper force-disabled",
  "share-target": "invisible OS share handoff route",
  status: "standalone public status page",
  "tray-panel": "transparent tray window — wallpaper is force-disabled there",
  workflows: 'marks data-bg-target="canvas" itself (its own scope)',
}

/**
 * The wallpaper reaches a route either because the route marks a target itself
 * or because something it imports does. `FeaturePageShell` owns the marker for
 * every route built on it.
 */
function reachesBackgroundTarget(file: string): boolean {
  return reachesSource(
    file,
    (src) => src.includes("data-bg-target") || src.includes("FeaturePageShell")
  )
}

describe("every route can render the wallpaper", () => {
  const routes = appRoutePages()

  /**
   * Guard the guard. An empty walk makes the assertion below vacuously true,
   * which is exactly how a dormancy sweep rots into a no-op.
   */
  it("scans the routes it claims to scan", () => {
    expect(routes.length).toBeGreaterThanOrEqual(40)
  })

  it("leaves no route without a reachable [data-bg-target]", () => {
    const unmarked = routes
      .map((route) => ({ route, name: routeSegment(route) }))
      .filter(({ name }) => !(name in EXEMPT))
      .filter(({ route }) => !reachesBackgroundTarget(join(REPO_ROOT, route)))
      .map(({ route }) => route)

    expect(unmarked).toEqual([])
  })

  it("keeps the exemption list honest", () => {
    const names = new Set(routes.map(routeSegment))
    // A stale exemption hides a route that has since started needing coverage.
    const stale = Object.keys(EXEMPT).filter((name) => !names.has(name))
    expect(stale).toEqual([])
  })
})
