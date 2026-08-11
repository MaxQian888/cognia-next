import {
  DEFAULT_GATEWAY_PANEL,
  GATEWAY_NAV_GROUPS,
  GATEWAY_NAV_ITEMS,
  resolveGatewayPanel,
} from "./nav-config"

describe("gateway nav-config", () => {
  it("exposes every grouped item in the flat list", () => {
    const grouped = GATEWAY_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(GATEWAY_NAV_ITEMS.map((i) => i.id)).toEqual(grouped)
  })

  it("covers all nine panels exactly once", () => {
    const ids = GATEWAY_NAV_ITEMS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(
      [
        "custom",
        "exposure",
        "keys",
        "listener",
        "logs",
        "overview",
        "reliability",
        "tickets",
        "upstream",
      ].sort()
    )
  })

  it("resolves a known deep link", () => {
    expect(resolveGatewayPanel("upstream")).toBe("upstream")
    expect(resolveGatewayPanel("custom")).toBe("custom")
  })

  it("falls back to the default for unknown, empty and absent values", () => {
    expect(resolveGatewayPanel("nope")).toBe(DEFAULT_GATEWAY_PANEL)
    expect(resolveGatewayPanel("")).toBe(DEFAULT_GATEWAY_PANEL)
    expect(resolveGatewayPanel(null)).toBe(DEFAULT_GATEWAY_PANEL)
    expect(resolveGatewayPanel(undefined)).toBe(DEFAULT_GATEWAY_PANEL)
  })
})
