import { join } from "node:path"

import {
  appRoutePages,
  appRouteUrls,
  REPO_ROOT,
  reachesSource,
  routeSegment,
} from "@/components/feature-shell/route-module-graph"

import { FULL_VIEWPORT_ROUTE_PATTERNS, needsFullViewport } from "./full-viewport-routes"

/**
 * Routes that reach `FeaturePageShell` but do NOT need a definite height, with
 * the reason. Each one has a compact branch of its own that never renders the
 * shell on a phone, so the shell's `h-full` chain is not in play there.
 */
const EXEMPT: Record<string, string> = {
  issues: "IssuesMobileBody replaces the shell on the compact branch",
  memory: "MemoryMobileBody replaces the shell on the compact branch",
  templates: "TemplatesMobileBody replaces the shell on the compact branch",
  goals: "GoalsMobileBody replaces the shell on the compact branch",
  discover: "DiscoverMobileBody replaces the shell on the compact branch",
  inbox: "redirect-only route",
}

describe("needsFullViewport", () => {
  it("matches an exact route without swallowing its siblings", () => {
    expect(needsFullViewport("/workspace")).toBe(true)
    // `/workspaces` is not `/workspace`, and an exact pattern must not prefix-match.
    expect(needsFullViewport("/workspaces")).toBe(false)
  })

  it("matches everything under a prefix pattern", () => {
    expect(needsFullViewport("/workflows/editor")).toBe(true)
    // The workflows LIST scrolls normally. Only its detail routes own the viewport.
    expect(needsFullViewport("/workflows")).toBe(false)
  })

  it("leaves an ordinary scrolling route alone", () => {
    expect(needsFullViewport("/")).toBe(false)
    expect(needsFullViewport("/settings")).toBe(false)
  })
})

describe("full-viewport coverage", () => {
  const pages = appRoutePages()

  /**
   * Guard the guard. An empty walk makes the assertion below vacuously true,
   * which is exactly how a sweep rots into a no-op.
   */
  it("scans the routes it claims to scan", () => {
    expect(pages.length).toBeGreaterThanOrEqual(40)
  })

  /**
   * The failure this exists to stop: `FeaturePageShell`'s compact branch is
   * `flex h-full min-h-0 flex-1 flex-col overflow-hidden`, and under the
   * wrapper's `min-h-[100dvh]` that chain resolves to `auto` and collapses to
   * zero. The route is reachable AND blank, and no overflow check catches it.
   * `/sites`, `/devices` and `/servers` each shipped that way once.
   */
  it("gives every feature-shell route a definite height", () => {
    const missing = pages
      .filter((page) => !(routeSegment(page) in EXEMPT))
      .filter((page) =>
        reachesSource(join(REPO_ROOT, page), (src) => src.includes("FeaturePageShell"))
      )
      .map((page) => `/${routeSegment(page)}`)
      .filter((route) => !needsFullViewport(route))

    expect(missing).toEqual([])
  })

  it("keeps the exemption list honest", () => {
    const names = new Set(pages.map(routeSegment))
    const stale = Object.keys(EXEMPT).filter((name) => !names.has(name))
    expect(stale).toEqual([])
  })

  /**
   * A pattern for a route that no longer exists is dead weight that hides
   * drift. Checked against every served URL rather than the top-level pages,
   * because `/pair` and `/me/terminal` are a grouped route and a nested one.
   * A check that only knew the top-level page glob would call both stale while
   * they were live.
   */
  it("keeps the pattern list honest", () => {
    const urls = appRouteUrls()
    const stale = FULL_VIEWPORT_ROUTE_PATTERNS.filter((pattern) => {
      const route = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern
      return !urls.some((url) => url === route || url.startsWith(route + "/"))
    })
    expect(stale).toEqual([])
  })
})
