import { render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { TypographyApplier, resolveTypographyVars } from "./typography-applier"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { TypographyExtSettings } from "@/types/appearance"

const baseSettings = {
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

function setSettings(typographyExt: TypographyExtSettings | undefined) {
  useSettingsStore.setState({
    settings: typographyExt ? { ...baseSettings, typographyExt } : { ...baseSettings },
  })
}

afterEach(() => {
  document.documentElement.removeAttribute("style")
  useSettingsStore.setState({ settings: null })
})

describe("resolveTypographyVars", () => {
  it("returns sensible fallbacks when no typography is set", () => {
    const vars = resolveTypographyVars(undefined)
    expect(vars["--font-sans"]).toContain("var(--font-geist-sans)")
    expect(vars["--font-mono"]).toContain("var(--font-geist-mono)")
    expect(vars["--line-height-scale"]).toBe("1")
    expect(vars["--letter-spacing-em"]).toBe("0em")
    expect(vars["--font-serif"]).toBeUndefined()
  })

  it("quotes families containing spaces and prepends them to the fallback chain", () => {
    const vars = resolveTypographyVars({
      fontFamily: "Source Sans 3",
      monoFamily: "JetBrains Mono",
      lineHeightScale: 1.1,
      letterSpacingEm: 0.01,
    })
    expect(vars["--font-sans"]).toMatch(/^"Source Sans 3", /)
    expect(vars["--font-mono"]).toMatch(/^"JetBrains Mono", /)
  })

  it("does not double-quote already-quoted families", () => {
    const vars = resolveTypographyVars({
      fontFamily: '"Inter"',
      monoFamily: "monospace",
      lineHeightScale: 1,
      letterSpacingEm: 0,
    })
    expect(vars["--font-sans"]?.startsWith('"Inter",')).toBe(true)
    // monospace has no whitespace; passes through unquoted
    expect(vars["--font-mono"]?.startsWith("monospace,")).toBe(true)
  })

  it("clamps line-height-scale outside 0.875..1.25 and letter-spacing outside ±0.02", () => {
    const vars = resolveTypographyVars({
      lineHeightScale: 5,
      letterSpacingEm: -0.5,
    })
    expect(vars["--line-height-scale"]).toBe("1.25")
    expect(vars["--letter-spacing-em"]).toBe("-0.02em")
  })

  it("includes --font-serif only when serifFamily is provided", () => {
    const withSerif = resolveTypographyVars({
      serifFamily: "Georgia",
      lineHeightScale: 1,
      letterSpacingEm: 0,
    })
    expect(withSerif["--font-serif"]).toMatch(/^Georgia, /)
  })
})

describe("TypographyApplier", () => {
  it("writes typography vars onto <html> on mount and clears them on unmount", () => {
    setSettings({
      fontFamily: "Inter",
      monoFamily: "Fira Code",
      lineHeightScale: 1.1,
      letterSpacingEm: 0.005,
    })
    const root = document.documentElement
    const { unmount } = render(<TypographyApplier />)
    expect(root.style.getPropertyValue("--font-sans")).toMatch(/^Inter, /)
    expect(root.style.getPropertyValue("--font-mono")).toMatch(/^"Fira Code", /)
    expect(root.style.getPropertyValue("--line-height-scale")).toBe("1.1")
    expect(root.style.getPropertyValue("--letter-spacing-em")).toBe("0.005em")
    unmount()
    expect(root.style.getPropertyValue("--font-sans")).toBe("")
    expect(root.style.getPropertyValue("--line-height-scale")).toBe("")
  })

  it("falls back cleanly when no typography slice is stored", () => {
    setSettings(undefined)
    render(<TypographyApplier />)
    const root = document.documentElement
    expect(root.style.getPropertyValue("--font-sans")).toContain("var(--font-geist-sans)")
    expect(root.style.getPropertyValue("--line-height-scale")).toBe("1")
  })
})
