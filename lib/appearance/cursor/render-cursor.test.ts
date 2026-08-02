/** @jest-environment jsdom */

// jsdom, not node: `rasterizeCursorSvg` drives `document.createElement("canvas")`
// and `new Image()`, and the whole point of the raster pass is what happens in a
// browser. jsdom gives no real 2D context, so the canvas is stubbed per test —
// which is also how the "no canvas available" fallback gets covered.

import {
  clearCursorRasterCache,
  cursorCssValue,
  cursorPixelSize,
  CURSOR_BASE_PX,
  CURSOR_MAX_PX,
  deriveOutline,
  rasterizeCursorSvg,
  renderPackRoles,
  resolveCursorPalette,
  shapeForPack,
  svgToDataUrl,
} from "./render-cursor"
import { CURSOR_PACKS_BY_ID } from "./cursor-packs"
import { wcagContrast } from "@/lib/appearance/contrast"
import { CURSOR_ROLE_CSS_KEYWORD, CURSOR_SIZE_MAX, CURSOR_SIZE_MIN } from "@/types/appearance"

const AERO = CURSOR_PACKS_BY_ID.get("aero")!
const GRAPHITE = CURSOR_PACKS_BY_ID.get("graphite")!
const NEON = CURSOR_PACKS_BY_ID.get("neon")!

afterEach(() => {
  clearCursorRasterCache()
  jest.restoreAllMocks()
})

describe("cursorPixelSize", () => {
  it("scales the base size", () => {
    expect(cursorPixelSize(1)).toBe(CURSOR_BASE_PX)
    expect(cursorPixelSize(2)).toBe(CURSOR_BASE_PX * 2)
  })

  it("clamps a corrupt persisted scale to the offered range", () => {
    expect(cursorPixelSize(99)).toBe(Math.round(CURSOR_BASE_PX * CURSOR_SIZE_MAX))
    expect(cursorPixelSize(0)).toBe(Math.round(CURSOR_BASE_PX * CURSOR_SIZE_MIN))
    expect(cursorPixelSize(-5)).toBe(Math.round(CURSOR_BASE_PX * CURSOR_SIZE_MIN))
  })

  it("falls back to neutral for a non-numeric persisted value", () => {
    expect(cursorPixelSize(undefined)).toBe(CURSOR_BASE_PX)
    expect(cursorPixelSize(Number.NaN)).toBe(CURSOR_BASE_PX)
  })

  it("keeps the whole size range inside the 128px browser ceiling", () => {
    // Past 128px a browser silently drops the cursor image and shows the
    // keyword fallback instead. Widening CURSOR_SIZE_MAX must fail here first.
    expect(cursorPixelSize(CURSOR_SIZE_MAX)).toBeLessThanOrEqual(CURSOR_MAX_PX)
  })
})

describe("deriveOutline", () => {
  it("picks whichever of near-white / near-black contrasts more", () => {
    expect(deriveOutline("#0b0b0f")).toBe("#ffffff")
    expect(deriveOutline("#fefefe")).toBe("#12121a")
  })

  it("always clears 3:1 against the fill it was derived for", () => {
    for (const fill of ["#3b82f6", "#808080", "#ffd166", "#7c3aed", "#00ff00"]) {
      expect(wcagContrast(deriveOutline(fill), fill)).toBeGreaterThanOrEqual(3)
    }
  })
})

describe("resolveCursorPalette", () => {
  it("returns the pack's own palette in pack mode", () => {
    expect(resolveCursorPalette({ pack: AERO, colorMode: "pack" })).toEqual(AERO.palette)
  })

  it("re-tints with the theme accent and re-derives a legible outline", () => {
    const palette = resolveCursorPalette({
      pack: AERO,
      colorMode: "accent",
      accentColor: "#7c3aed",
    })
    expect(palette.fill).toBe("#7c3aed")
    expect(wcagContrast(palette.stroke, palette.fill)).toBeGreaterThanOrEqual(3)
    expect(palette.accent).not.toBe(palette.fill)
  })

  it("re-tints with a custom color", () => {
    const palette = resolveCursorPalette({
      pack: AERO,
      colorMode: "custom",
      customColor: "#00b894",
      accentColor: "#7c3aed",
    })
    expect(palette.fill).toBe("#00b894")
  })

  it("preserves whether the pack glows, so a tinted Neon still glows", () => {
    const tinted = resolveCursorPalette({ pack: NEON, colorMode: "accent", accentColor: "#ff0000" })
    expect(tinted.glow).toBe("#ff0000")
    const flat = resolveCursorPalette({ pack: AERO, colorMode: "accent", accentColor: "#ff0000" })
    expect(flat.glow).toBeUndefined()
  })

  it("falls back to the pack palette when the tint color is missing or unparseable", () => {
    expect(resolveCursorPalette({ pack: AERO, colorMode: "accent" })).toEqual(AERO.palette)
    expect(
      resolveCursorPalette({ pack: AERO, colorMode: "custom", customColor: "not-a-color" })
    ).toEqual(AERO.palette)
  })

  it("accepts the oklch values the theme layer actually stores", () => {
    const palette = resolveCursorPalette({
      pack: AERO,
      colorMode: "accent",
      accentColor: "oklch(0.62 0.19 260)",
    })
    expect(palette.fill).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe("svgToDataUrl", () => {
  it('percent-encodes the characters that would break out of url("…")', () => {
    const url = svgToDataUrl('<svg><path fill="#fff"/></svg>')
    expect(url.startsWith("data:image/svg+xml,")).toBe(true)
    expect(url).not.toContain("<")
    expect(url).not.toContain(">")
    expect(url).not.toContain('"')
    expect(url).toContain("%23fff")
  })
})

describe("cursorCssValue", () => {
  it("emits the image, the hotspot, and a keyword fallback", () => {
    expect(cursorCssValue("data:image/png;base64,AAA", { x: 3, y: 2 }, "pointer")).toBe(
      'url("data:image/png;base64,AAA") 3 2, pointer'
    )
  })
})

describe("renderPackRoles", () => {
  it("renders exactly the roles a pack declares", () => {
    const rendered = renderPackRoles(GRAPHITE, GRAPHITE.palette, 24, CURSOR_ROLE_CSS_KEYWORD)
    expect(rendered.map((r) => r.role)).toEqual([...GRAPHITE.roles])
    expect(rendered.some((r) => r.role === "progress")).toBe(false)
  })

  it("gives each role a keyword fallback matching its CSS role", () => {
    const rendered = renderPackRoles(AERO, AERO.palette, 24, CURSOR_ROLE_CSS_KEYWORD)
    const deny = rendered.find((r) => r.role === "notAllowed")!
    expect(deny.svgCss.endsWith(", not-allowed")).toBe(true)
  })

  it("scales the hotspot with the rendered size", () => {
    const small = renderPackRoles(AERO, AERO.palette, 24, CURSOR_ROLE_CSS_KEYWORD)[0]
    const large = renderPackRoles(AERO, AERO.palette, 48, CURSOR_ROLE_CSS_KEYWORD)[0]
    expect(large.hotspot.x).toBeGreaterThan(small.hotspot.x)
  })
})

describe("shapeForPack", () => {
  it("resolves the pack's silhouette", () => {
    expect(shapeForPack(AERO).id).toBe("arrow")
  })
})

// ---------------------------------------------------------------------------
// Rasterization
// ---------------------------------------------------------------------------

interface StubOptions {
  /** `null` simulates a canvas with no 2D context. */
  context?: { drawImage: jest.Mock } | null
  dataUrl?: string
  /** Make `drawImage` throw, as a tainted canvas would. */
  throwOnDraw?: boolean
}

function stubCanvas(options: StubOptions = {}): { toDataURL: jest.Mock } {
  const drawImage = jest.fn(() => {
    if (options.throwOnDraw) throw new Error("tainted")
  })
  const toDataURL = jest.fn(() => options.dataUrl ?? "data:image/png;base64,STUB")
  const canvas = {
    width: 0,
    height: 0,
    getContext: jest.fn(() => (options.context === undefined ? { drawImage } : options.context)),
    toDataURL,
  }
  jest.spyOn(document, "createElement").mockImplementation(() => canvas as unknown as HTMLElement)
  return { toDataURL }
}

/** Replace `Image` with a stub that fires load or error on `src` assignment. */
function stubImage(outcome: "load" | "error" | "never"): void {
  class StubImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      if (outcome === "never") return
      queueMicrotask(() => {
        if (outcome === "load") this.onload?.()
        else this.onerror?.()
      })
    }
  }
  ;(globalThis as unknown as { Image: unknown }).Image = StubImage
}

describe("rasterizeCursorSvg", () => {
  const originalImage = (globalThis as unknown as { Image: unknown }).Image

  afterEach(() => {
    ;(globalThis as unknown as { Image: unknown }).Image = originalImage
  })

  it("returns a PNG data URL when the decode succeeds", async () => {
    stubCanvas()
    stubImage("load")
    await expect(rasterizeCursorSvg("<svg/>", 24)).resolves.toBe("data:image/png;base64,STUB")
  })

  it("renders at 2x so the cursor does not soften on a HiDPI display", async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ({ drawImage: jest.fn() })),
      toDataURL: jest.fn(() => "data:image/png;base64,STUB"),
    }
    jest.spyOn(document, "createElement").mockImplementation(() => canvas as unknown as HTMLElement)
    stubImage("load")
    await rasterizeCursorSvg("<svg/>", 24)
    expect(canvas.width).toBe(48)
    expect(canvas.height).toBe(48)
  })

  it("memoises per svg+size so a theme change does not re-encode every glyph", async () => {
    const { toDataURL } = stubCanvas()
    stubImage("load")
    await rasterizeCursorSvg("<svg id='a'/>", 24)
    await rasterizeCursorSvg("<svg id='a'/>", 24)
    expect(toDataURL).toHaveBeenCalledTimes(1)
    await rasterizeCursorSvg("<svg id='a'/>", 48)
    expect(toDataURL).toHaveBeenCalledTimes(2)
  })

  it("resolves null — never rejects — when the image fails to decode", async () => {
    stubCanvas()
    stubImage("error")
    await expect(rasterizeCursorSvg("<svg/>", 24)).resolves.toBeNull()
  })

  it("resolves null when the canvas has no 2D context", async () => {
    stubCanvas({ context: null })
    stubImage("load")
    await expect(rasterizeCursorSvg("<svg/>", 24)).resolves.toBeNull()
  })

  it("resolves null when drawing throws, rather than propagating", async () => {
    stubCanvas({ throwOnDraw: true })
    stubImage("load")
    await expect(rasterizeCursorSvg("<svg/>", 24)).resolves.toBeNull()
  })

  it("resolves null when toDataURL returns something that is not a PNG", async () => {
    stubCanvas({ dataUrl: "data:," })
    stubImage("load")
    await expect(rasterizeCursorSvg("<svg/>", 24)).resolves.toBeNull()
  })

  it("resolves null when there is no Image constructor at all (SSR / locked-down CSP)", async () => {
    stubCanvas()
    ;(globalThis as unknown as { Image: unknown }).Image = undefined
    await expect(rasterizeCursorSvg("<svg/>", 24)).resolves.toBeNull()
  })

  it("clearCursorRasterCache forces a re-encode", async () => {
    const { toDataURL } = stubCanvas()
    stubImage("load")
    await rasterizeCursorSvg("<svg id='b'/>", 24)
    clearCursorRasterCache()
    await rasterizeCursorSvg("<svg id='b'/>", 24)
    expect(toDataURL).toHaveBeenCalledTimes(2)
  })
})
