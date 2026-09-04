import { buildPluginLogsHref } from "./plugin-logs-link"

describe("buildPluginLogsHref", () => {
  it("targets the log panel's own channel", () => {
    const url = new URL(buildPluginLogsHref({ pluginId: "web-tools" }), "http://localhost")
    expect(url.pathname).toBe("/logs")
    expect(url.searchParams.get("channel")).toBe("logs")
  })

  it("narrows to plugin output for one plugin", () => {
    const url = new URL(buildPluginLogsHref({ pluginId: "web-tools" }), "http://localhost")
    // `src` and `q` are the keys `useLogPanelUrlSync` hydrates at mount. A
    // renamed key here would deep-link to an unfiltered panel.
    expect(url.searchParams.get("src")).toBe("plugin")
    expect(url.searchParams.get("q")).toBe("web-tools")
  })

  it("defaults to the last 24 hours", () => {
    const url = new URL(buildPluginLogsHref({ pluginId: "ocr" }), "http://localhost")
    expect(url.searchParams.get("t")).toBe("24h")
  })

  it("states the all-time preset instead of dropping it", () => {
    // `all` is in the panel's `VALID_TIME_RANGES`, so it applies like any other
    // value. Omitting `t` left the panel on its own default, which made the one
    // option meaning "no time filter" the one option this could not express.
    const url = new URL(
      buildPluginLogsHref({ pluginId: "ocr", timeRange: "all" }),
      "http://localhost"
    )
    expect(url.searchParams.get("t")).toBe("all")
  })

  it("escapes ids that are not URL safe", () => {
    const href = buildPluginLogsHref({ pluginId: "scope/plugin id" })
    expect(href).toContain("q=scope%2Fplugin+id")
    expect(new URL(href, "http://localhost").searchParams.get("q")).toBe("scope/plugin id")
  })
})
