import {
  CURSOR_PACKS,
  CURSOR_PACKS_BY_ID,
  CURSOR_PACK_FAMILIES,
  getCursorPack,
  packsInFamily,
} from "./cursor-packs"
import { CURSOR_SHAPE_DEFS } from "./cursor-art"
import { wcagContrast } from "@/lib/appearance/contrast"
import { SYSTEM_CURSOR_PACK_ID } from "@/types/appearance"

describe("CURSOR_PACKS", () => {
  it("has unique ids and names", () => {
    const ids = CURSOR_PACKS.map((p) => p.id)
    const names = CURSOR_PACKS.map((p) => p.name)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(names).size).toBe(names.length)
  })

  it("never uses the system sentinel as a pack id", () => {
    expect(CURSOR_PACKS.some((p) => p.id === SYSTEM_CURSOR_PACK_ID)).toBe(false)
  })

  it("points every pack at a shape that exists", () => {
    for (const pack of CURSOR_PACKS) {
      expect(CURSOR_SHAPE_DEFS[pack.shape]).toBeDefined()
    }
  })

  it("declares the default role in every pack — it is the fallback for the whole app", () => {
    for (const pack of CURSOR_PACKS) {
      expect(pack.roles).toContain("default")
    }
  })

  it("declares no duplicate roles", () => {
    for (const pack of CURSOR_PACKS) {
      expect(new Set(pack.roles).size).toBe(pack.roles.length)
    }
  })

  it("keeps fill and stroke far enough apart that the outline actually reads", () => {
    // The outline is the only thing keeping a 24px glyph visible on a
    // same-colored surface. 3:1 is the floor for a non-text graphic (WCAG
    // 1.4.11); anything less and the pack is decorative but unusable.
    for (const pack of CURSOR_PACKS) {
      expect(wcagContrast(pack.palette.fill, pack.palette.stroke)).toBeGreaterThanOrEqual(3)
    }
  })

  it("keeps the interactive accent readable against the fill or the outline", () => {
    // The pointer/progress badges are drawn as an accent stroke over a wider
    // outline stroke, sitting on the body fill — so the badge reads if the
    // accent separates from EITHER neighbour. Requiring it against the fill
    // alone would fail Mecha (gold on ice blue, 1.3) even though its accent is
    // an 11:1 shout against its near-black outline.
    for (const pack of CURSOR_PACKS) {
      const vsFill = wcagContrast(pack.palette.accent, pack.palette.fill)
      const vsStroke = wcagContrast(pack.palette.accent, pack.palette.stroke)
      expect(Math.max(vsFill, vsStroke)).toBeGreaterThanOrEqual(2)
    }
  })

  it("assigns every pack to a family the picker renders", () => {
    for (const pack of CURSOR_PACKS) {
      expect(CURSOR_PACK_FAMILIES).toContain(pack.family)
    }
  })

  it("ships at least one pack per family, including the anime set", () => {
    for (const family of CURSOR_PACK_FAMILIES) {
      expect(packsInFamily(family).length).toBeGreaterThan(0)
    }
    expect(packsInFamily("anime").length).toBeGreaterThanOrEqual(4)
  })

  it("keeps the platform-deferring pack a genuine subset, so that path stays exercised", () => {
    const graphite = CURSOR_PACKS_BY_ID.get("graphite")!
    expect(graphite.roles).not.toContain("notAllowed")
    expect(graphite.roles).not.toContain("progress")
    expect(graphite.roles).not.toContain("crosshair")
  })
})

describe("getCursorPack", () => {
  it("resolves a known id", () => {
    expect(getCursorPack("sakura")?.name).toBe("Sakura")
  })

  it("reads the system sentinel as no override", () => {
    expect(getCursorPack(SYSTEM_CURSOR_PACK_ID)).toBeNull()
  })

  it("reads an undefined or unknown id as no override rather than throwing", () => {
    expect(getCursorPack(undefined)).toBeNull()
    expect(getCursorPack("")).toBeNull()
    expect(getCursorPack("a-pack-removed-in-an-upgrade")).toBeNull()
  })
})

describe("packsInFamily", () => {
  it("preserves catalogue order", () => {
    const anime = packsInFamily("anime").map((p) => p.id)
    const expected = CURSOR_PACKS.filter((p) => p.family === "anime").map((p) => p.id)
    expect(anime).toEqual(expected)
  })
})
