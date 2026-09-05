import {
  CONNECTIVITY_NAV_GROUPS,
  CONNECTIVITY_NAV_ITEMS,
  DEFAULT_CONNECTIVITY_PANEL,
  panelForLegacySection,
  resolveConnectivityPanel,
} from "./nav-config"

describe("connectivity nav-config", () => {
  it("lists the seven topics exactly once", () => {
    const ids = CONNECTIVITY_NAV_ITEMS.map((item) => item.id)
    expect(ids).toEqual([
      "overview",
      "local-host",
      "cloud-relay",
      "pairing",
      "remote-hosts",
      "push",
      "sync",
    ])
    expect(new Set(ids).size).toBe(ids.length)
    expect(CONNECTIVITY_NAV_GROUPS.every((group) => group.items.length > 0)).toBe(true)
  })

  it("narrows a deep link to a known panel", () => {
    expect(resolveConnectivityPanel("push")).toBe("push")
    expect(resolveConnectivityPanel("nope")).toBe(DEFAULT_CONNECTIVITY_PANEL)
    expect(resolveConnectivityPanel(null)).toBe("overview")
  })

  it("routes the retired sections' links to the panel that replaced them", () => {
    expect(panelForLegacySection("companion")).toBe("overview")
    expect(panelForLegacySection("remote-hosts")).toBe("remote-hosts")
    expect(panelForLegacySection("companion", "add")).toBe("remote-hosts")
  })
})
