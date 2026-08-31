import {
  PLUGIN_NAV_SECTIONS,
  PLUGIN_LIBRARY_SUBFILTERS,
  PLUGIN_GOVERNANCE_VIEWS,
  visiblePluginSections,
} from "./plugin-nav-config"

describe("plugin-nav-config", () => {
  it("exposes the 5 top-level nav sections in order", () => {
    expect(PLUGIN_NAV_SECTIONS.map((item) => item.section)).toEqual([
      "library",
      "discover",
      "agent-packages",
      "governance",
      "devtools",
    ])
  })

  it("gates devtools behind the devtools featureFlag", () => {
    const devtools = PLUGIN_NAV_SECTIONS.find((item) => item.section === "devtools")
    expect(devtools?.featureFlag).toBe("devtools")
  })

  /**
   * Pi's package manager reads a config file and shells out to a CLI. Neither
   * exists in the browser or on mobile, so the section is hidden there rather
   * than rendered broken.
   */
  it("gates agent-packages to the desktop shell", () => {
    const section = PLUGIN_NAV_SECTIONS.find((item) => item.section === "agent-packages")
    expect(section?.featureFlag).toBe("desktop")
  })

  it("does not gate library / discover / governance", () => {
    const ungated = PLUGIN_NAV_SECTIONS.filter(
      (item) => item.section !== "devtools" && item.section !== "agent-packages"
    )
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

describe("visiblePluginSections", () => {
  // Shared by the desktop rail and the phone body. If the two ever filtered
  // separately, one shell would offer a section the other refused to.
  it("hides the desktop-only and devtools sections off a Tauri shell", () => {
    const ids = visiblePluginSections({ devtoolsEnabled: false, isDesktop: false }).map(
      (s) => s.section
    )
    expect(ids).toEqual(["library", "discover", "governance"])
  })

  it("offers agent packages on a desktop shell", () => {
    const ids = visiblePluginSections({ devtoolsEnabled: false, isDesktop: true }).map(
      (s) => s.section
    )
    expect(ids).toContain("agent-packages")
    expect(ids).not.toContain("devtools")
  })

  it("adds devtools only behind its opt-in flag, and keeps nav order", () => {
    const ids = visiblePluginSections({ devtoolsEnabled: true, isDesktop: true }).map(
      (s) => s.section
    )
    expect(ids).toEqual(["library", "discover", "agent-packages", "governance", "devtools"])
  })
})
