import { synthesizeThemeSwatches, synthesizeThemeGradient } from "./synthesize-theme-icon"
import type { ThemeColors } from "@/types/plugin/plugin"

const FULL: Partial<ThemeColors> = {
  background: "#111111",
  foreground: "#eeeeee",
  primary: "#7c3aed",
  accent: "#22c55e",
}

describe("synthesizeThemeSwatches", () => {
  it("returns the three palette colors when all are present", () => {
    expect(synthesizeThemeSwatches(FULL)).toEqual({
      background: "#111111",
      primary: "#7c3aed",
      accent: "#22c55e",
    })
  })

  it("falls back through accent → primary → foreground → background", () => {
    expect(synthesizeThemeSwatches({ background: "#000", primary: "#fff" })).toEqual({
      background: "#000",
      primary: "#fff",
      accent: "#fff", // accent missing → reuse primary
    })
  })

  it("uses the foreground when primary is missing", () => {
    const out = synthesizeThemeSwatches({ background: "#000", foreground: "#fff" })
    expect(out.primary).toBe("#fff")
    expect(out.accent).toBe("#fff")
  })

  it("uses card / popover when background is missing", () => {
    const out = synthesizeThemeSwatches({ card: "#222" })
    expect(out.background).toBe("#222")
  })

  it("returns a neutral grey for an empty palette so cards still render", () => {
    const out = synthesizeThemeSwatches({})
    expect(out.background).toBe("#6b7280")
    expect(out.primary).toBe("#6b7280")
    expect(out.accent).toBe("#6b7280")
  })

  it("treats an undefined palette as empty", () => {
    expect(synthesizeThemeSwatches(undefined).background).toBe("#6b7280")
  })
})

describe("synthesizeThemeGradient", () => {
  it("returns a 135° gradient string containing all three colors", () => {
    const css = synthesizeThemeGradient(FULL)
    expect(css.startsWith("linear-gradient(135deg, ")).toBe(true)
    expect(css).toContain("#111111 0%")
    expect(css).toContain("#7c3aed 50%")
    expect(css).toContain("#22c55e 100%")
  })

  it("falls back gracefully on partial palettes (every slot uses background when nothing else is set)", () => {
    const css = synthesizeThemeGradient({ background: "#000" })
    // primary/accent → cascade to `background` (not the neutral grey)
    // because background is set. The card visibly degrades to a single
    // colour but always renders.
    expect(css).toContain("#000 0%")
    expect(css).toContain("#000 50%")
    expect(css).toContain("#000 100%")
  })
})
