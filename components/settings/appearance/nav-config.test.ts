import {
  APPEARANCE_NAV_GROUPS,
  APPEARANCE_PANEL_ICONS,
  DEFAULT_APPEARANCE_PANEL,
  resolveAppearancePanel,
} from "./nav-config"
import enAppearance from "../../../i18n/messages/en/settings/appearance.json"
import zhAppearance from "../../../i18n/messages/zh-CN/settings/appearance.json"

describe("APPEARANCE_NAV_GROUPS", () => {
  it("covers twelve panels across three groups", () => {
    expect(APPEARANCE_NAV_GROUPS).toHaveLength(3)
    expect(APPEARANCE_NAV_GROUPS.flatMap((g) => g.items)).toHaveLength(12)
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

  it.each([
    ["en", enAppearance],
    ["zh-CN", zhAppearance],
  ])("has a %s label and description for every entry", (_locale, messages) => {
    for (const group of APPEARANCE_NAV_GROUPS) {
      for (const item of group.items) {
        expect(messages.nav.items[item.id]).toEqual({
          label: expect.any(String),
          description: expect.any(String),
        })
      }
    }
  })
})

describe("APPEARANCE_PANEL_ICONS", () => {
  it("covers every panel", () => {
    const ids = APPEARANCE_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(Object.keys(APPEARANCE_PANEL_ICONS).sort()).toEqual([...ids].sort())
  })

  // The detail header and the nav entry must show the same glyph, which they
  // only do while this map is derived from the groups rather than retyped.
  it("reuses each entry's own icon", () => {
    for (const group of APPEARANCE_NAV_GROUPS) {
      for (const item of group.items) {
        expect(APPEARANCE_PANEL_ICONS[item.id]).toBe(item.icon)
      }
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
