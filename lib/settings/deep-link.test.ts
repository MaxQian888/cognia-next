import { connectionsHref, mcpHref, SETTINGS_ROUTE, settingsHref } from "./deep-link"
import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"

describe("settingsHref", () => {
  it("builds a section link", () => {
    expect(settingsHref("providers")).toBe("/settings?section=providers")
  })

  it("adds the focus param that use-setting-focus consumes", () => {
    // The point of `focus` is landing on the control, not the top of the pane.
    expect(settingsHref("providers", "anthropic-key")).toBe(
      "/settings?section=providers&focus=anthropic-key"
    )
  })

  it("drops a focus id that use-setting-focus would reject", () => {
    // That hook guards its selector with /^[a-z0-9-]+$/i; emitting an id it
    // refuses would produce a link that silently does nothing.
    expect(settingsHref("providers", "not a control id")).toBe("/settings?section=providers")
    expect(settingsHref("providers", "a.b")).toBe("/settings?section=providers")
    expect(settingsHref("providers", "")).toBe("/settings?section=providers")
  })

  it("produces a URL the settings route can parse back", () => {
    const url = new URL(settingsHref("external-bridge", "agent-command"), "https://x.test")
    expect(url.pathname).toBe(SETTINGS_ROUTE)
    expect(url.searchParams.get("section")).toBe("external-bridge")
    expect(url.searchParams.get("focus")).toBe("agent-command")
  })

  it("resolves to a section the settings navigation actually renders", () => {
    const known = new Set(SETTINGS_NAV.map((item) => item.id))
    for (const item of SETTINGS_NAV) {
      const section = new URL(settingsHref(item.id), "https://x.test").searchParams.get("section")
      expect(known.has(section as (typeof SETTINGS_NAV)[number]["id"])).toBe(true)
    }
  })
})

describe("settingsHref params", () => {
  it("appends section-owned params", () => {
    expect(settingsHref("connections", { params: { connectionsTab: "outbound" } })).toBe(
      "/settings?section=connections&connectionsTab=outbound"
    )
  })

  it("drops undefined and empty params so callers need not branch", () => {
    expect(settingsHref("mcp", { params: { preset: undefined, server: "" } })).toBe(
      "/settings?section=mcp"
    )
  })

  it("still accepts a bare focus id (the original signature)", () => {
    expect(settingsHref("providers", "anthropic-key")).toBe(
      "/settings?section=providers&focus=anthropic-key"
    )
  })

  it("escapes a param value rather than splicing it in", () => {
    const url = new URL(
      settingsHref("connections", { params: { adapter: "a&b=c" } }),
      "https://x.test"
    )
    expect(url.searchParams.get("adapter")).toBe("a&b=c")
    expect(url.searchParams.get("section")).toBe("connections")
  })
})

describe("connectionsHref", () => {
  it("points at the section itself with no selection", () => {
    expect(connectionsHref()).toBe("/settings?section=connections")
  })

  it("names a tab", () => {
    // The bug this replaces: six call sites emitted `/settings/connections`,
    // a path with no route under `output: "export"`, with `?tab=` that the
    // section (which reads `connectionsTab`) never looked at.
    expect(connectionsHref({ tab: "outbound" })).toBe(
      "/settings?section=connections&connectionsTab=outbound"
    )
  })

  it("implies the adapters tab when selecting an instance", () => {
    expect(connectionsHref({ adapter: "cai_1" })).toBe(
      "/settings?section=connections&connectionsTab=adapters&adapter=cai_1"
    )
  })

  it("implies the adapters tab when landing on a platform", () => {
    expect(connectionsHref({ platform: "telegram" })).toBe(
      "/settings?section=connections&connectionsTab=adapters&platform=telegram"
    )
  })

  it("lets an explicit tab win over the implied one", () => {
    expect(connectionsHref({ tab: "health" as "audit", adapter: "cai_1" })).toContain(
      "connectionsTab=health"
    )
  })
})

describe("mcpHref", () => {
  it("points at the section itself", () => {
    expect(mcpHref()).toBe("/settings?section=mcp")
  })

  it("opens one preset in the gallery", () => {
    expect(mcpHref({ preset: "filesystem" })).toBe("/settings?section=mcp&preset=filesystem")
  })

  it("opens one configured server's detail pane", () => {
    // How a managed external service points at the MCP row it provisioned.
    expect(mcpHref({ server: "srv-1" })).toBe("/settings?section=mcp&server=srv-1")
  })
})
