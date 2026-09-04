import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  appRoutePages,
  appRouteUrls,
  REPO_ROOT,
  reachesSource,
  routeSegment,
} from "@/components/feature-shell/test-route-module-graph"

import { FULL_VIEWPORT_ROUTE_PATTERNS, needsFullViewport } from "./full-viewport-routes"

interface Exemption {
  /** Why the feature-shell sweep does not apply to this route. */
  reason: string
  /**
   * The compact body that replaces the shell, when there is one.
   *
   * Named rather than described, because "a mobile body replaces the shell" is
   * only half an answer: it says the SHELL's `h-full` chain is out of play, not
   * that the replacement needs no definite height of its own. The body is read
   * below and has to prove it scrolls with the document.
   */
  mobileBody?: string
}

/**
 * Routes that reach `FeaturePageShell` but do NOT need a definite height, with
 * the reason. Each one has a compact branch of its own that never renders the
 * shell on a phone, so the shell's `h-full` chain is not in play there.
 *
 * An exemption is NOT a licence to stay out of the pattern list. `/templates`
 * and `/discover` sat here with exactly this reason while their compact bodies
 * were `flex h-full min-h-0` — the same collapse, one component further down.
 * The test below reads each named body and only accepts the exemption when the
 * body scrolls the document (`min-h-[100dvh]`); otherwise the route must be in
 * `FULL_VIEWPORT_ROUTE_PATTERNS`.
 */
const EXEMPT: Record<string, Exemption> = {
  issues: {
    reason: "IssuesMobileBody replaces the shell on the compact branch",
    mobileBody: "components/mobile/issues/issues-mobile-body.tsx",
  },
  memory: {
    reason: "MemoryMobileBody replaces the shell on the compact branch",
    mobileBody: "components/mobile/memory/memory-mobile-body.tsx",
  },
  templates: {
    reason: "TemplatesMobileBody replaces the shell on the compact branch",
    mobileBody: "components/mobile/templates/templates-mobile-body.tsx",
  },
  goals: {
    reason: "GoalsMobileBody replaces the shell on the compact branch",
    mobileBody: "components/mobile/goals/goals-mobile-body.tsx",
  },
  discover: {
    reason: "DiscoverMobileBody replaces the shell on the compact branch",
    mobileBody: "components/mobile/discover/discover-mobile-body.tsx",
  },
  inbox: { reason: "redirect-only route" },
}

/** The document-scrolling shape. Anything else needs a definite height. */
function scrollsWithTheDocument(body: string): boolean {
  return readFileSync(join(REPO_ROOT, body), "utf8").includes("min-h-[100dvh]")
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

  /**
   * `SubPageShell` is `flex h-full min-h-0 flex-1 overflow-y-auto` with a
   * sticky header on all 48 `/me/*` pages. Only `/me/terminal` used to be
   * listed, so the other 47 resolved `h-full` against a parent with no height
   * and rendered as a short strip under a sticky header that had stopped
   * sticking. `/me` itself is a scrolling row list and must not be caught.
   */
  it("gives every /me sub-page a height without catching /me itself", () => {
    expect(needsFullViewport("/me")).toBe(false)
    for (const route of ["/me/terminal", "/me/scheduler", "/me/storage", "/me/notifications"]) {
      expect(needsFullViewport(route)).toBe(true)
    }
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
    // A named body that has moved makes the check below read an empty file and
    // silently pass, which is how this guard would rot into a no-op.
    const missingBodies = Object.entries(EXEMPT)
      .filter(([, exemption]) => exemption.mobileBody)
      .filter(([, exemption]) => !existsSync(join(REPO_ROOT, exemption.mobileBody!)))
      .map(([name]) => name)
    expect(missingBodies).toEqual([])
  })

  /**
   * The hole this closes. "A mobile body replaces the shell" excused
   * `/templates` and `/discover` from the sweep above, but both bodies are
   * `flex h-full min-h-0 flex-col` — the exact chain that collapses to zero
   * under the wrapper's `min-h-[100dvh]`. The excuse only holds for a body that
   * actually scrolls the document, which `MemoryMobileBody` and
   * `GoalsMobileBody` do and those two did not.
   */
  it("only excuses a route whose compact body scrolls the document", () => {
    const unexcused = Object.entries(EXEMPT)
      .filter(([, exemption]) => exemption.mobileBody)
      .filter(([name, exemption]) => {
        if (scrollsWithTheDocument(exemption.mobileBody!)) return false
        return !needsFullViewport(`/${name}`)
      })
      .map(([name]) => `/${name}`)

    expect(unexcused).toEqual([])
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
