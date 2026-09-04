import { join } from "node:path"

import {
  appRoutePages,
  REPO_ROOT,
  reachesSource,
  resolveSpecifier,
  routeSegment,
} from "./test-route-module-graph"

describe("route module graph", () => {
  it("resolves an aliased specifier to a real file", () => {
    expect(
      resolveSpecifier(join(REPO_ROOT, "app/devices/page.tsx"), "@/components/surface/surface")
    ).toBe(join(REPO_ROOT, "components/surface/surface.tsx"))
  })

  /**
   * The walk is deliberately confined to the app's own component tree. Chasing
   * `lucide-react` or `next/link` would make every route reach everything.
   */
  it("refuses a specifier outside components/ and app/", () => {
    const from = join(REPO_ROOT, "app/devices/page.tsx")
    expect(resolveSpecifier(from, "lucide-react")).toBeNull()
    expect(resolveSpecifier(from, "@/lib/utils")).toBeNull()
  })

  /**
   * The whole reason this is a graph walk rather than a grep: a route reaches
   * the feature shell through two or three re-exports, so the page file itself
   * names neither the shell nor the marker.
   */
  it("follows re-exports to a marker the route file never mentions", () => {
    const page = join(REPO_ROOT, "app/workspace/page.tsx")
    expect(reachesSource(page, (src) => src.includes("FeaturePageShell"))).toBe(true)
    expect(reachesSource(page, (src) => src.includes("NoSuchTokenAnywhere"))).toBe(false)
  })

  it("enumerates the top-level routes and names their segment", () => {
    const pages = appRoutePages()
    expect(pages.length).toBeGreaterThanOrEqual(40)
    expect(pages).toContain("app/workspace/page.tsx")
    expect(routeSegment("app/workspace/page.tsx")).toBe("workspace")
  })
})
