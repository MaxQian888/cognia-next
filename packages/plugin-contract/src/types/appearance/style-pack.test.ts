import {
  DEFAULT_STYLE_PACK,
  STYLE_PACKS,
  STYLE_PACK_IDS,
  isStylePackId,
  resolveStylePack,
} from "./style-pack"

describe("style pack catalogue", () => {
  it("keeps soft first and as the default", () => {
    expect(STYLE_PACK_IDS[0]).toBe("soft")
    expect(DEFAULT_STYLE_PACK.packId).toBe("soft")
    expect(DEFAULT_STYLE_PACK.overrides).toBeUndefined()
  })

  it("gives every id a row", () => {
    for (const id of STYLE_PACK_IDS) expect(STYLE_PACKS[id]).toBeDefined()
  })

  /**
   * The whole "shape vs colour" split rests on this: a pack may not carry a
   * colour token, or Sharp × Catppuccin stops being a valid combination.
   */
  it("carries no colour tokens", () => {
    for (const id of STYLE_PACK_IDS) {
      for (const value of Object.values(STYLE_PACKS[id])) {
        expect(String(value)).not.toMatch(/#|oklch|rgb|hsl|var\(--/i)
      }
    }
  })

  /**
   * Pins the marketing site's scale (web/app/globals.css: control 8 / panel 12
   * / stage 14). `--radius-control` is `base - 2px` and `--radius-stage` is
   * `base + 4px`, so a 0.625rem (10px) base lands on 8 and 14 exactly. If this
   * base ever moves, the product silently stops matching the website.
   */
  it("keeps studio on the marketing site's 8/12/14 scale", () => {
    expect(STYLE_PACKS.studio.radiusBaseRem * 16).toBe(10)
    expect(STYLE_PACKS.studio.pillRadiusPx).toBe(8) // "No oversized pills"
  })

  it("squares everything in sharp", () => {
    expect(STYLE_PACKS.sharp.radiusBaseRem).toBe(0)
    expect(STYLE_PACKS.sharp.pillRadiusPx).toBe(0)
    expect(STYLE_PACKS.sharp.elevationMax).toBe(0)
  })
})

describe("resolveStylePack", () => {
  it("reports soft as default so the applier can write nothing", () => {
    expect(resolveStylePack(undefined).isDefault).toBe(true)
    expect(resolveStylePack({ packId: "soft" }).isDefault).toBe(true)
  })

  it("falls back to soft for an unknown id rather than throwing", () => {
    const resolved = resolveStylePack({ packId: "brutal" as never })
    expect(resolved.packId).toBe("soft")
    expect(resolved.isDefault).toBe(true)
  })

  it("layers sparse overrides over the pack", () => {
    const resolved = resolveStylePack({ packId: "sharp", overrides: { density: "spacious" } })
    expect(resolved.density).toBe("spacious")
    // Untouched fields still come from the pack.
    expect(resolved.radiusBaseRem).toBe(0)
    expect(resolved.isDefault).toBe(false)
  })

  it("treats a pack customised back to soft's values as default", () => {
    const resolved = resolveStylePack({
      packId: "studio",
      overrides: { ...STYLE_PACKS.soft },
    })
    expect(resolved.isDefault).toBe(true)
    // The id is still reported, so the UI can show which pack is selected.
    expect(resolved.packId).toBe("studio")
  })

  it("clamps hand-edited values instead of trusting them", () => {
    const resolved = resolveStylePack({
      packId: "soft",
      overrides: { radiusBaseRem: 99, pillRadiusPx: -5, letterSpacingEm: 5 },
    })
    expect(resolved.radiusBaseRem).toBe(1.5)
    expect(resolved.pillRadiusPx).toBe(0)
    expect(resolved.letterSpacingEm).toBe(0.02)
  })

  it("survives NaN from a corrupt settings row", () => {
    const resolved = resolveStylePack({
      packId: "soft",
      overrides: { radiusBaseRem: Number.NaN, pillRadiusPx: Number.NaN },
    })
    expect(resolved.radiusBaseRem).toBe(STYLE_PACKS.soft.radiusBaseRem)
    expect(resolved.pillRadiusPx).toBe(STYLE_PACKS.soft.pillRadiusPx)
  })
})

describe("isStylePackId", () => {
  it("accepts known ids and rejects everything else", () => {
    expect(isStylePackId("sharp")).toBe(true)
    expect(isStylePackId("brutal")).toBe(false)
    expect(isStylePackId(undefined)).toBe(false)
    expect(isStylePackId(3)).toBe(false)
  })
})
