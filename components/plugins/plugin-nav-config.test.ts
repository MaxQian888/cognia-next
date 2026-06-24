import {
  PLUGIN_NAV_SECTIONS,
  PLUGIN_LIBRARY_SUBFILTERS,
  PLUGIN_GOVERNANCE_VIEWS,
} from "./plugin-nav-config"

describe("plugin-nav-config", () => {
  it("exposes the 4 top-level nav sections in order", () => {
    expect(PLUGIN_NAV_SECTIONS.map((item) => item.section)).toEqual([
      "library",
      "discover",
      "governance",
      "devtools",
    ])
  })

  it("gates devtools behind the devtools featureFlag", () => {
    const devtools = PLUGIN_NAV_SECTIONS.find((item) => item.section === "devtools")
    expect(devtools?.featureFlag).toBe("devtools")
  })

  it("does not gate library / discover / governance", () => {
    const ungated = PLUGIN_NAV_SECTIONS.filter((item) => item.section !== "devtools")
    for (const item of ungated) {
      expect(item.featureFlag).toBeUndefined()
    }
  })

  it("exposes the 5 library sub-filters in the chip order: all → enabled → updates → configurable → errored", () => {
    expect(PLUGIN_LIBRARY_SUBFILTERS.map((s) => s.value)).toEqual([
      "all",
      "enabled",
      "updates",
      "configurable",
      "errored",
    ])
  })

  it("exposes the governance views in order: permissions → scheduled → analytics → audit → policy", () => {
    expect(PLUGIN_GOVERNANCE_VIEWS.map((v) => v.value)).toEqual([
      "permissions",
      "scheduled",
      "analytics",
      "audit",
      "policy",
    ])
  })
})
