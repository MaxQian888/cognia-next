/** @jest-environment jsdom */

import {
  DEFAULT_PERF_DASHBOARD_STATE,
  mergePerfDashboardParams,
  parsePerfDashboardParams,
  perfDashboardHref,
  writePerfDashboardParams,
} from "./dashboard-url"

describe("performance dashboard URL state", () => {
  it("parses known values and falls back to defaults for unknown ones", () => {
    expect(
      parsePerfDashboardParams(
        new URLSearchParams("tab=resources&resource=managed&metric=renderer.fps")
      )
    ).toEqual({ tab: "resources", resource: "managed", metric: "renderer.fps" })
    expect(
      parsePerfDashboardParams(new URLSearchParams("tab=bogus&resource=x&metric=cpu"))
    ).toEqual(DEFAULT_PERF_DASHBOARD_STATE)
    expect(parsePerfDashboardParams(null)).toEqual(DEFAULT_PERF_DASHBOARD_STATE)
  })

  it("drops defaults, keeps foreign params, and clears a null metric", () => {
    expect(mergePerfDashboardParams("foo=1", { tab: "overview", resource: "processes" })).toBe(
      "foo=1"
    )
    expect(mergePerfDashboardParams("metric=renderer.fps", { tab: "captures" })).toBe(
      "metric=renderer.fps&tab=captures"
    )
    expect(mergePerfDashboardParams("metric=renderer.fps&tab=captures", { metric: null })).toBe(
      "tab=captures"
    )
  })

  it("builds hrefs into the dashboard", () => {
    expect(perfDashboardHref()).toBe("/performance")
    expect(perfDashboardHref({ tab: "captures" })).toBe("/performance?tab=captures")
    expect(perfDashboardHref({ tab: "overview", metric: "host.main.cpu-pct" })).toBe(
      "/performance?metric=host.main.cpu-pct"
    )
  })

  it("writes in place without navigating and returns the query", () => {
    window.history.replaceState(null, "", "/performance?keep=1")
    expect(writePerfDashboardParams({ tab: "diagnose" })).toBe("keep=1&tab=diagnose")
    expect(window.location.pathname).toBe("/performance")
    expect(window.location.search).toBe("?keep=1&tab=diagnose")
  })
})
