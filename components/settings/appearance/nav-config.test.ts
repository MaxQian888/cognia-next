import {
  APPEARANCE_NAV_GROUPS,
  DEFAULT_APPEARANCE_PANEL,
  resolveAppearancePanel,
} from "./nav-config"

describe("APPEARANCE_NAV_GROUPS", () => {
  it("covers ten panels across three groups", () => {
    expect(APPEARANCE_NAV_GROUPS).toHaveLength(3)
    expect(APPEARANCE_NAV_GROUPS.flatMap((g) => g.items)).toHaveLength(11)
  })

  it("has no duplicate panel ids", () => {
    const ids = APPEARANCE_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every entry an icon", () => {
    for (const group of APPEARANCE_NAV_GROUPS) {
      for (const item of group.items) expect(item.icon).toBeDefined()
    }
  })
})

describe("resolveAppearancePanel", () => {
  it("defaults when the param is absent", () => {
    expect(resolveAppearancePanel(null, true)).toBe(DEFAULT_APPEARANCE_PANEL)
  })

  it("defaults when the param names nothing", () => {
    expect(resolveAppearancePanel("garbage", true)).toBe("theme")
  })

  it("passes through a live panel id", () => {
    expect(resolveAppearancePanel("wallpaper", true)).toBe("wallpaper")
    expect(resolveAppearancePanel("custom", true)).toBe("custom")
  })

  // The pre-merge deep links.
  it.each([
    ["themePack", "library"],
    ["import", "library"],
    ["layout", "typography"],
  ])("maps the legacy %s link to %s", (raw, expected) => {
    expect(resolveAppearancePanel(raw, true)).toBe(expected)
  })

  describe("plugins gate", () => {
    it("resolves when something contributes to the slot", () => {
      expect(resolveAppearancePanel("plugins", true)).toBe("plugins")
    })

    it("falls back rather than showing an empty panel when nothing does", () => {
      expect(resolveAppearancePanel("plugins", false)).toBe(DEFAULT_APPEARANCE_PANEL)
    })
  })
})
