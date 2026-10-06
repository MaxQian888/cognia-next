/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import {
  __resetChatDiagramPaletteForTesting,
  buildMermaidThemeVariables,
  mixHex,
  readChatDiagramPalette,
  toHex,
  useChatDiagramPalette,
} from "./diagram-palette"

const root = () => document.documentElement

afterEach(() => {
  root().removeAttribute("style")
  root().classList.remove("dark")
  __resetChatDiagramPaletteForTesting()
})

describe("toHex / mixHex", () => {
  it("resolves oklch, rgb, hex and named colours, with a fallback for junk", () => {
    expect(toHex("oklch(1 0 0)", "#000000")).toBe("#ffffff")
    expect(toHex(" rgb(255, 0, 0) ", "#000000")).toBe("#ff0000")
    expect(toHex("#0af", "#000000")).toBe("#00aaff")
    expect(toHex("not a colour", "#123456")).toBe("#123456")
    expect(toHex(undefined, "#123456")).toBe("#123456")
  })

  it("composites a translucent colour over the given background instead of dropping its alpha", () => {
    // The dark theme's border: 10% white over a near-black background is a
    // dark grey, never solid white.
    expect(toHex("oklch(1 0 0 / 10%)", "#000000", "#000000")).toBe("#191919")
    expect(toHex("rgb(255 0 0 / 0.5)", "#000000", "#ffffff")).toBe("#ff8080")
    // Without a background it composites over white.
    expect(toHex("rgb(0 0 0 / 0.5)", "#123456")).toBe("#808080")
  })

  it("mixes in oklab like color-mix", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#ffffff")
    expect(mixHex("#000000", "#ffffff", 100)).toBe("#000000")
    const mid = mixHex("#000000", "#ffffff", 50)
    expect(mid).not.toBe("#000000")
    expect(mid).not.toBe("#ffffff")
    expect(mixHex("junk", "#ffffff", 50)).toBe("#ffffff")
  })
})

describe("readChatDiagramPalette", () => {
  it("reads the tokens on <html>, including custom-theme overrides and dark mode", () => {
    root().style.setProperty("--primary", "#88c0d0")
    root().style.setProperty("--chart-1", "oklch(0.646 0.222 41.116)")
    root().classList.add("dark")
    const palette = readChatDiagramPalette()
    expect(palette.dark).toBe(true)
    expect(palette.colors.primary).toBe("#88c0d0")
    expect(palette.colors.chart[0]).toMatch(/^#[0-9a-f]{6}$/)
    expect(palette.colors.chart).toHaveLength(5)
    expect(palette.key).toContain("#88c0d0")
  })

  it("falls back to light defaults for missing tokens", () => {
    const palette = readChatDiagramPalette()
    expect(palette.colors.background).toBe("#ffffff")
    expect(palette.fontFamily.length).toBeGreaterThan(0)
  })
})

describe("buildMermaidThemeVariables", () => {
  it("maps the palette onto the base theme with chart series for pies", () => {
    root().style.setProperty("--chart-2", "#00ff00")
    const vars = buildMermaidThemeVariables(readChatDiagramPalette())
    expect(vars.darkMode).toBe(false)
    expect(vars.primaryTextColor).toBe(vars.textColor)
    expect(vars.pie2).toBe("#00ff00")
    expect(vars.cScale1).toBe("#00ff00")
    for (const [name, value] of Object.entries(vars)) {
      if (typeof value !== "string" || name === "fontFamily" || name === "fontSize") continue
      // Mermaid's colour maths only reads literal colours.
      expect(value).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe("useChatDiagramPalette", () => {
  it("updates when the mode or a token changes, and only then", async () => {
    const { result } = renderHook(() => useChatDiagramPalette())
    const first = result.current
    expect(first.dark).toBe(false)
    await act(async () => {
      root().classList.add("dark")
      await Promise.resolve()
    })
    expect(result.current.dark).toBe(true)
    const second = result.current
    await act(async () => {
      root().setAttribute("data-unrelated", "x")
      await Promise.resolve()
    })
    expect(result.current).toBe(second)
    await act(async () => {
      root().style.setProperty("--primary", "#ff0000")
      await Promise.resolve()
    })
    expect(result.current.colors.primary).toBe("#ff0000")
  })
})
