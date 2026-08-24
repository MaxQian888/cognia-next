import {
  COMPACT_TOOLBAR_PX,
  COMPOSER_SKIN_IDS,
  COMPOSER_SKINS,
  DEFAULT_COMPOSER_SKIN,
  MOBILE_MIN_TOUCH_PX,
  composerSkinVars,
  resolveComposerSkin,
  resolveToolbarLayout,
  type ComposerSkinId,
} from "./composer-skin"

const NON_CLASSIC = COMPOSER_SKIN_IDS.filter((id) => id !== "classic")

describe("the default is today's composer", () => {
  it("falls back to classic when nothing is set", () => {
    expect(resolveComposerSkin(undefined, { isMobile: false }).id).toBe("classic")
    expect(DEFAULT_COMPOSER_SKIN).toBe("classic")
  })

  it("falls back to classic for an unknown id rather than throwing", () => {
    const skin = resolveComposerSkin({ skin: "nope" as ComposerSkinId }, { isMobile: false })
    expect(skin.id).toBe("classic")
  })

  it("marks classic so the box can render its original literal classes", () => {
    expect(resolveComposerSkin({ skin: "classic" }, { isMobile: false }).isClassic).toBe(true)
    for (const id of NON_CLASSIC) {
      expect(resolveComposerSkin({ skin: id }, { isMobile: false }).isClassic).toBe(false)
    }
  })

  it("emits NO css variables for classic, so nothing can drift", () => {
    const skin = resolveComposerSkin({ skin: "classic" }, { isMobile: false })
    expect(composerSkinVars(skin)).toBeUndefined()
  })

  it("ignores overrides under classic — its contract is 'untouched'", () => {
    const skin = resolveComposerSkin(
      { skin: "classic", skinOverrides: { radiusPx: 2, mono: true, padXPx: 24 } },
      { isMobile: false }
    )
    expect(skin.radiusPx).toBe(COMPOSER_SKINS.classic.radiusPx)
    expect(skin.padXPx).toBe(COMPOSER_SKINS.classic.padXPx)
    expect(skin.mono).toBe(false)
  })
})

describe("compactLayout is inert outside classic", () => {
  it("still drives the stacked layout under classic", () => {
    expect(
      resolveComposerSkin({ skin: "classic", compactLayout: true }, { isMobile: false })
        .compactLayout
    ).toBe(true)
    expect(
      resolveComposerSkin({ skin: "classic", compactLayout: false }, { isMobile: false })
        .compactLayout
    ).toBe(false)
  })

  it.each(NON_CLASSIC)("changes nothing under %s", (id) => {
    const on = resolveComposerSkin({ skin: id, compactLayout: true }, { isMobile: false })
    const off = resolveComposerSkin({ skin: id, compactLayout: false }, { isMobile: false })
    expect(on).toEqual(off)
  })
})

describe("overrides", () => {
  it("layer on top of the chosen preset", () => {
    const skin = resolveComposerSkin(
      { skin: "airy", skinOverrides: { radiusPx: 4, mono: true } },
      { isMobile: false }
    )
    expect(skin.radiusPx).toBe(4)
    expect(skin.mono).toBe(true)
    // untouched fields still come from the preset
    expect(skin.padXPx).toBe(COMPOSER_SKINS.airy.padXPx)
  })

  it("clamps a hand-edited settings row to a usable box", () => {
    const wild = resolveComposerSkin(
      { skin: "airy", skinOverrides: { radiusPx: 9999, padXPx: -50 } },
      { isMobile: false }
    )
    expect(wild.radiusPx).toBeLessThanOrEqual(32)
    expect(wild.padXPx).toBeGreaterThanOrEqual(2)
  })

  it("survives a NaN without producing a broken length", () => {
    const skin = resolveComposerSkin(
      { skin: "airy", skinOverrides: { radiusPx: Number.NaN } },
      { isMobile: false }
    )
    expect(Number.isFinite(skin.radiusPx)).toBe(true)
    expect(composerSkinVars(skin)?.["--composer-radius"]).not.toContain("NaN")
  })
})

describe("mobile floors", () => {
  it.each(NON_CLASSIC)("keeps the send button tappable on %s", (id) => {
    const skin = resolveComposerSkin({ skin: id }, { isMobile: true })
    expect(skin.sendSizePx).toBeGreaterThanOrEqual(MOBILE_MIN_TOUCH_PX)
  })

  it("floors a dense override that would go below the touch minimum", () => {
    const skin = resolveComposerSkin(
      { skin: "dense", skinOverrides: { padXPx: 2, radiusPx: 0 } },
      { isMobile: true }
    )
    expect(skin.padXPx).toBeGreaterThanOrEqual(10)
    expect(skin.radiusPx).toBeGreaterThanOrEqual(12)
  })

  it("leaves a skin that already clears the floor alone", () => {
    const desktop = resolveComposerSkin({ skin: "airy" }, { isMobile: false })
    const mobile = resolveComposerSkin({ skin: "airy" }, { isMobile: true })
    expect(mobile.radiusPx).toBe(desktop.radiusPx)
    expect(mobile.padXPx).toBe(desktop.padXPx)
  })

  it("degrades the information-maximal roster instead of overflowing it", () => {
    expect(resolveComposerSkin({ skin: "full" }, { isMobile: false }).toolbarLayout).toBe(
      "expanded"
    )
    expect(resolveComposerSkin({ skin: "full" }, { isMobile: true }).toolbarLayout).toBe("embedded")
  })

  it("does not conflate the legacy compact flag with running on a phone", () => {
    // Mobile stacking is the box's `isMobile` prop, not this flag. Folding the
    // platform in here would hand a phone the desktop compact skin's geometry.
    expect(resolveComposerSkin({ skin: "classic" }, { isMobile: true }).compactLayout).toBe(false)
    for (const id of NON_CLASSIC) {
      expect(resolveComposerSkin({ skin: id }, { isMobile: true }).compactLayout).toBe(false)
    }
  })
})

describe("skin proposes, width disposes", () => {
  it("keeps the proposal in a comfortable pane", () => {
    expect(resolveToolbarLayout("expanded", COMPACT_TOOLBAR_PX + 1)).toBe("expanded")
    expect(resolveToolbarLayout("detached", 900)).toBe("detached")
  })

  it("packs a roster that cannot fit, whatever the user chose", () => {
    expect(resolveToolbarLayout("expanded", 300)).toBe("embedded")
    expect(resolveToolbarLayout("rail", 300)).toBe("embedded")
  })

  it("leaves detached alone — it owns its own narrow packing", () => {
    // Rewriting it would move the row from below the box to inside it the
    // moment a pane narrowed, which narrowing has never meant for classic.
    expect(resolveToolbarLayout("detached", 300)).toBe("detached")
  })

  it("leaves the tightest arrangement alone — narrowing cannot improve it", () => {
    expect(resolveToolbarLayout("folded", 300)).toBe("folded")
  })

  it("keeps the proposal before the pane has been measured", () => {
    // width 0 means "not measured yet"; degrading here would flash a compact
    // layout on first paint and then snap back.
    expect(resolveToolbarLayout("expanded", 0)).toBe("expanded")
  })
})

describe("the table stays coherent", () => {
  it("gives every skin a distinct toolbar arrangement", () => {
    const layouts = COMPOSER_SKIN_IDS.map((id) => COMPOSER_SKINS[id].toolbarLayout)
    expect(new Set(layouts).size).toBe(COMPOSER_SKIN_IDS.length)
  })

  it("emits a complete, unit-bearing variable set for every non-classic skin", () => {
    for (const id of NON_CLASSIC) {
      const vars = composerSkinVars(resolveComposerSkin({ skin: id }, { isMobile: false }))
      expect(vars).toBeDefined()
      for (const [key, value] of Object.entries(vars!)) {
        expect(key.startsWith("--composer-")).toBe(true)
        expect(value).toMatch(/^\d+(px)$|^9999px$/)
      }
    }
  })

  it("echoes the outer curve on inner controls", () => {
    const circle = composerSkinVars(resolveComposerSkin({ skin: "airy" }, { isMobile: false }))
    expect(circle!["--composer-inner-radius"]).toBe("9999px")
    const boxy = composerSkinVars(resolveComposerSkin({ skin: "dense" }, { isMobile: false }))
    expect(boxy!["--composer-inner-radius"]).not.toBe("9999px")
  })
})
