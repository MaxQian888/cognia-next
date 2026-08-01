import {
  buildCursorSvg,
  CURSOR_DENY_COLOR,
  CURSOR_SHAPE_DEFS,
  CURSOR_VIEWBOX,
  roleHotspot,
  roleMarkup,
  scaledHotspot,
} from "./cursor-art"
import { CURSOR_ROLES, CURSOR_SHAPES, type CursorPalette } from "@/types/appearance"

const PALETTE: CursorPalette = {
  fill: "#ffffff",
  stroke: "#101010",
  accent: "#3b82f6",
}

const GLOW_PALETTE: CursorPalette = { ...PALETTE, glow: "#22d3ee" }

describe("CURSOR_SHAPE_DEFS", () => {
  it("defines every shape in the union exactly once, keyed by its own id", () => {
    for (const shape of CURSOR_SHAPES) {
      expect(CURSOR_SHAPE_DEFS[shape]).toBeDefined()
      expect(CURSOR_SHAPE_DEFS[shape].id).toBe(shape)
    }
    expect(Object.keys(CURSOR_SHAPE_DEFS)).toHaveLength(CURSOR_SHAPES.length)
  })

  it("keeps every hotspot inside the authoring box", () => {
    for (const shape of CURSOR_SHAPES) {
      const { x, y } = CURSOR_SHAPE_DEFS[shape].hotspot
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(CURSOR_VIEWBOX)
      expect(y).toBeLessThanOrEqual(CURSOR_VIEWBOX)
    }
  })

  it("starts every silhouette path with an absolute move so the geometry is anchored", () => {
    for (const shape of CURSOR_SHAPES) {
      expect(CURSOR_SHAPE_DEFS[shape].path.trimStart().startsWith("M")).toBe(true)
    }
  })
})

describe("roleHotspot", () => {
  const shape = CURSOR_SHAPE_DEFS.arrow

  it("gives the arrow family the shape's own tip", () => {
    for (const role of ["default", "pointer", "progress"] as const) {
      expect(roleHotspot(role, shape)).toEqual(shape.hotspot)
    }
  })

  it("centres the symmetric glyphs", () => {
    for (const role of ["text", "grab", "grabbing", "notAllowed", "crosshair"] as const) {
      expect(roleHotspot(role, shape)).toEqual({ x: 16, y: 16 })
    }
  })
})

describe("scaledHotspot", () => {
  it("scales into device pixels and rounds — a fractional hotspot is truncated by browsers", () => {
    // Blade tip is (2.6, 2.2) in a 32-unit box; at 48px the scale is 1.5.
    expect(scaledHotspot("default", CURSOR_SHAPE_DEFS.blade, 48)).toEqual({ x: 4, y: 3 })
  })

  it("keeps the centred roles centred at any size", () => {
    expect(scaledHotspot("text", CURSOR_SHAPE_DEFS.arrow, 64)).toEqual({ x: 32, y: 32 })
  })
})

describe("roleMarkup", () => {
  const shape = CURSOR_SHAPE_DEFS.arrow

  it("emits non-empty markup for every role of every shape", () => {
    for (const shapeId of CURSOR_SHAPES) {
      for (const role of CURSOR_ROLES) {
        const markup = roleMarkup(role, CURSOR_SHAPE_DEFS[shapeId], PALETTE)
        expect(markup.length).toBeGreaterThan(0)
      }
    }
  })

  it("adds the interactive badge only to the pointer role", () => {
    const base = roleMarkup("default", shape, PALETTE)
    const pointer = roleMarkup("pointer", shape, PALETTE)
    expect(pointer.startsWith(base)).toBe(true)
    expect(pointer.length).toBeGreaterThan(base.length)
    expect(pointer).toContain('cx="23.5"')
  })

  it("draws the deny glyph in the fixed safety red, not the pack accent", () => {
    const deny = roleMarkup("notAllowed", shape, PALETTE)
    expect(deny).toContain(CURSOR_DENY_COLOR)
    expect(deny).not.toContain(PALETTE.accent)
  })

  it("contracts grab into a filled disc for grabbing", () => {
    expect(roleMarkup("grab", shape, PALETTE)).toContain('fill="none"')
    expect(roleMarkup("grabbing", shape, PALETTE)).toContain(`fill="${PALETTE.fill}"`)
  })

  it("renders an outline shape hollow and a solid shape filled", () => {
    expect(roleMarkup("default", CURSOR_SHAPE_DEFS.neon, PALETTE)).toContain('fill="none"')
    expect(roleMarkup("default", CURSOR_SHAPE_DEFS.arrow, PALETTE)).toContain(
      `fill="${PALETTE.fill}"`
    )
  })

  it("layers the shape ornament onto the default role", () => {
    const wand = roleMarkup("default", CURSOR_SHAPE_DEFS.wand, PALETTE)
    // The wand's sparkle is drawn in the accent color.
    expect(wand).toContain(`fill="${PALETTE.accent}"`)
  })

  it("escapes a hostile color instead of letting it close the attribute", () => {
    const markup = roleMarkup("default", shape, {
      fill: '"/><script>alert(1)</script>',
      stroke: "#000000",
      accent: "#000000",
    })
    expect(markup).not.toContain("<script>")
    expect(markup).toContain("&lt;script&gt;")
  })
})

describe("buildCursorSvg", () => {
  it("wraps the body in a sized SVG whose viewBox stays in authoring units", () => {
    const svg = buildCursorSvg({
      role: "default",
      shape: CURSOR_SHAPE_DEFS.arrow,
      palette: PALETTE,
      sizePx: 40,
    })
    expect(svg).toContain('width="40" height="40"')
    expect(svg).toContain(`viewBox="0 0 ${CURSOR_VIEWBOX} ${CURSOR_VIEWBOX}"`)
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg.endsWith("</svg>")).toBe(true)
  })

  it("adds a blurred under-layer only when the palette declares a glow", () => {
    const plain = buildCursorSvg({
      role: "default",
      shape: CURSOR_SHAPE_DEFS.neon,
      palette: PALETTE,
      sizePx: 24,
    })
    const glowing = buildCursorSvg({
      role: "default",
      shape: CURSOR_SHAPE_DEFS.neon,
      palette: GLOW_PALETTE,
      sizePx: 24,
    })
    expect(plain).not.toContain("feDropShadow")
    expect(glowing).toContain("feDropShadow")
    expect(glowing).toContain(GLOW_PALETTE.glow!)
  })

  it("marks the pixel pack crisp so its stair-steps do not get anti-aliased away", () => {
    const pixel = buildCursorSvg({
      role: "default",
      shape: CURSOR_SHAPE_DEFS.pixel,
      palette: PALETTE,
      sizePx: 24,
    })
    expect(pixel).toContain('shape-rendering="crispEdges"')
    const arrow = buildCursorSvg({
      role: "default",
      shape: CURSOR_SHAPE_DEFS.arrow,
      palette: PALETTE,
      sizePx: 24,
    })
    expect(arrow).not.toContain("shape-rendering")
  })
})
