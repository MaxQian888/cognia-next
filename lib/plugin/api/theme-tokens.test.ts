/** @jest-environment jsdom */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  PLUGIN_DESIGN_TOKENS,
  REDUCE_MOTION_CLASS,
  buildWebviewTokenCss,
  prefersReducedMotion,
  readAppliedDesignTokens,
  readAppliedThemeTokens,
} from "./theme-tokens"

const root = () => document.documentElement

afterEach(() => {
  root().className = ""
  root().removeAttribute("style")
  root().removeAttribute("data-density")
  // @ts-expect-error — restore whatever the suite stubbed.
  delete window.matchMedia
})

function setTokens(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    root().style.setProperty(name, value)
  }
}

describe("PLUGIN_DESIGN_TOKENS", () => {
  /**
   * These names are a public contract: they appear in installed plugins'
   * stylesheets, which we cannot edit. Renaming one in globals.css without
   * noticing would break every plugin silently — nothing throws, the UI just
   * loses its colors. So pin the contract against the stylesheet itself.
   */
  it("is fully defined by app/globals.css", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8")
    const missing = PLUGIN_DESIGN_TOKENS.filter((token) => !css.includes(`${token}:`))
    expect(missing).toEqual([])
  })

  it("covers color, density, typography, radius and motion", () => {
    expect(PLUGIN_DESIGN_TOKENS).toContain("--primary")
    expect(PLUGIN_DESIGN_TOKENS).toContain("--density-spacing")
    expect(PLUGIN_DESIGN_TOKENS).toContain("--line-height-scale")
    expect(PLUGIN_DESIGN_TOKENS).toContain("--radius")
    expect(PLUGIN_DESIGN_TOKENS).toContain("--motion-duration-scale")
  })

  it("lists no token twice", () => {
    expect(new Set(PLUGIN_DESIGN_TOKENS).size).toBe(PLUGIN_DESIGN_TOKENS.length)
  })
})

describe("readAppliedDesignTokens", () => {
  it("reads applied custom properties off the root element", () => {
    setTokens({ "--primary": "oklch(0.5 0 0)", "--radius": "0.75rem" })
    const tokens = readAppliedDesignTokens()
    expect(tokens["--primary"]).toBe("oklch(0.5 0 0)")
    expect(tokens["--radius"]).toBe("0.75rem")
  })

  it("omits tokens that are not set rather than reporting empty strings", () => {
    const tokens = readAppliedDesignTokens()
    expect(tokens["--density-gap"]).toBeUndefined()
  })
})

describe("prefersReducedMotion", () => {
  it("is false by default", () => {
    expect(prefersReducedMotion()).toBe(false)
  })

  it("is true when the in-app toggle put the class on <html>", () => {
    root().classList.add(REDUCE_MOTION_CLASS)
    expect(prefersReducedMotion()).toBe(true)
  })

  it("is true from the OS preference even with no class on <html>", () => {
    // The app handles `prefers-reduced-motion` purely in CSS, so a plugin
    // animating from JS would otherwise never learn about it. This is the case
    // that makes the whole helper worth having.
    window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as never
    expect(root().classList.contains(REDUCE_MOTION_CLASS)).toBe(false)
    expect(prefersReducedMotion()).toBe(true)
  })

  it("is false when the OS preference is explicitly no-preference", () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as never
    expect(prefersReducedMotion()).toBe(false)
  })

  it("survives a webview with a partial matchMedia implementation", () => {
    window.matchMedia = jest.fn(() => {
      throw new Error("not implemented")
    }) as never
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe("readAppliedThemeTokens", () => {
  it("projects motion, density, typography and radius", () => {
    root().setAttribute("data-density", "compact")
    setTokens({
      "--motion-duration-scale": "1.5",
      "--density-spacing": "0.25rem",
      "--density-gap": "0.5rem",
      "--density-row-padding": "0.125rem",
      "--density-input-height": "2rem",
      "--density-line-height": "1.2",
      "--line-height-scale": "1.1",
      "--letter-spacing-em": "0.01",
      "--radius": "0.75rem",
    })

    const applied = readAppliedThemeTokens()
    expect(applied.motion).toEqual({ durationScale: 1.5, reduced: false })
    expect(applied.density.level).toBe("compact")
    expect(applied.density.spacing).toBe("0.25rem")
    expect(applied.density.gap).toBe("0.5rem")
    expect(applied.typography).toEqual({ lineHeightScale: 1.1, letterSpacingEm: 0.01 })
    expect(applied.radius).toBe(0.75)
  })

  it("falls back to neutral values when nothing is applied", () => {
    const applied = readAppliedThemeTokens()
    expect(applied.motion.durationScale).toBe(1)
    expect(applied.density.level).toBe("comfortable")
    expect(applied.typography.lineHeightScale).toBe(1)
    expect(applied.typography.letterSpacingEm).toBe(0)
    expect(applied.radius).toBe(0.625)
  })

  it("ignores an unrecognised density level", () => {
    root().setAttribute("data-density", "enormous")
    expect(readAppliedThemeTokens().density.level).toBe("comfortable")
  })

  it("falls back when a numeric token is not a number", () => {
    setTokens({ "--motion-duration-scale": "fast", "--radius": "chunky" })
    const applied = readAppliedThemeTokens()
    expect(applied.motion.durationScale).toBe(1)
    expect(applied.radius).toBe(0.625)
  })

  it("reports reduced motion so JS animation can honour it", () => {
    root().classList.add(REDUCE_MOTION_CLASS)
    expect(readAppliedThemeTokens().motion.reduced).toBe(true)
  })
})

describe("buildWebviewTokenCss", () => {
  it("emits the tokens as a :root rule the frame can use", () => {
    const css = buildWebviewTokenCss({ "--primary": "red", "--radius": "0.5rem" }, false)
    expect(css).toContain(":root {")
    expect(css).toContain("--primary: red;")
    expect(css).toContain("--radius: 0.5rem;")
  })

  it("adds a reduce-motion reset when motion is suppressed", () => {
    // The frame is a separate document, so the host's globals.css reset does
    // not reach it — the rule has to be re-stated inside.
    const css = buildWebviewTokenCss({ "--primary": "red" }, true)
    expect(css).toContain("animation-duration: 1ms !important")
    expect(css).toContain("transition-duration: 1ms !important")
  })

  it("omits the reset when motion is allowed", () => {
    const css = buildWebviewTokenCss({ "--primary": "red" }, false)
    expect(css).not.toContain("animation-duration")
  })

  it("reads the live host tokens when called with no arguments", () => {
    setTokens({ "--primary": "oklch(0.2 0 0)" })
    expect(buildWebviewTokenCss()).toContain("--primary: oklch(0.2 0 0);")
  })
})
