import { render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { ComponentStyles } from "@/types/appearance"
import {
  ComponentStyleApplier,
  __INTERNALS__,
  applyComponentStyleCss,
  clampRadiusScale,
  resolveComponentStyleCss,
} from "./component-style-applier"

const { STYLE_ELEMENT_ID } = __INTERNALS__

const baseSettings = {
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

function setComponentStyles(componentStyles: ComponentStyles | undefined) {
  useSettingsStore.setState({
    settings: componentStyles ? { ...baseSettings, componentStyles } : { ...baseSettings },
  })
}

afterEach(() => {
  document.getElementById(STYLE_ELEMENT_ID)?.remove()
  useSettingsStore.setState({ settings: null })
})

describe("clampRadiusScale", () => {
  it("clamps to 0.5..2 and rounds to 2dp", () => {
    expect(clampRadiusScale(0.1)).toBe(0.5)
    expect(clampRadiusScale(9)).toBe(2)
    expect(clampRadiusScale(1.333)).toBe(1.33)
  })
  it("treats non-finite as 1 (inherit)", () => {
    expect(clampRadiusScale(Number.NaN)).toBe(1)
  })
})

describe("resolveComponentStyleCss", () => {
  it("returns empty string for no overrides", () => {
    expect(resolveComponentStyleCss(undefined)).toBe("")
    expect(resolveComponentStyleCss({})).toBe("")
    expect(resolveComponentStyleCss({ card: {} })).toBe("")
  })

  it("emits a wallpaper-gated tonality rule for an inline surface (Card → --card)", () => {
    const css = resolveComponentStyleCss({ card: { tonality: "glass" } })
    expect(css).toContain(
      'body[data-bg-enabled="true"][data-bg-scope] [data-bg-target] [data-slot="card"]'
    )
    expect(css).toContain(
      "color-mix(in oklch,var(--card) var(--surface-tonality-glass),transparent)"
    )
    expect(css).toContain("backdrop-filter:blur(var(--surface-blur-regular))")
  })

  it("emits a body-level tonality rule for a portaled overlay (Popover → --popover)", () => {
    const css = resolveComponentStyleCss({ popover: { tonality: "translucent" } })
    // No [data-bg-target] step for portaled surfaces.
    expect(css).toContain(
      'body[data-bg-enabled="true"][data-bg-scope] [data-slot="popover-content"]'
    )
    expect(css).not.toContain("[data-bg-target]")
    expect(css).toContain("var(--surface-tonality-translucent)")
    expect(css).toContain("blur(var(--surface-blur-subtle))")
  })

  it("solid tonality forces the base colour and disables blur", () => {
    const css = resolveComponentStyleCss({ dialog: { tonality: "solid" } })
    expect(css).toContain("background-color:var(--background);backdrop-filter:none")
  })

  it("covers every slot listed for a multi-slot component", () => {
    const css = resolveComponentStyleCss({ dropdownMenu: { tonality: "glass" } })
    expect(css).toContain('[data-slot="dropdown-menu-content"]')
    expect(css).toContain('[data-slot="dropdown-menu-sub-content"]')
  })

  it("emits ungated elevation + radius without a wallpaper gate", () => {
    const css = resolveComponentStyleCss({ card: { elevation: "2", radiusScale: 1.5 } })
    expect(css).toContain('body [data-slot="card"]')
    expect(css).toContain("box-shadow:0 4px 12px -2px")
    expect(css).toContain("border-radius:calc(var(--radius) * 1.5)")
    // Elevation/radius block is not wallpaper-gated.
    const radiusLine = css.split("\n").find((l) => l.includes("border-radius"))
    expect(radiusLine).not.toContain("data-bg-enabled")
  })

  it("omits radius when scale is 1 (inherit)", () => {
    expect(resolveComponentStyleCss({ card: { radiusScale: 1 } })).toBe("")
  })

  it("clamps an out-of-range radius scale", () => {
    const css = resolveComponentStyleCss({ card: { radiusScale: 9 } })
    expect(css).toContain("calc(var(--radius) * 2)")
  })

  // ── ai-elements chat surfaces ───────────────────────────────────────────
  it("inserts the `within` ancestor for a gated chat surface (aiMessage → .is-user)", () => {
    const css = resolveComponentStyleCss({ aiMessage: { tonality: "translucent" } })
    expect(css).toContain('[data-bg-target] .is-user [data-slot="ai-message-content"]')
    expect(css).toContain(
      "color-mix(in oklch,var(--secondary) var(--surface-tonality-translucent),transparent)"
    )
  })

  it("carries the `within` ancestor into the ungated elevation/radius selector too", () => {
    const css = resolveComponentStyleCss({ aiMessage: { elevation: "1" } })
    expect(css).toContain('body .is-user [data-slot="ai-message-content"]')
  })

  it("terminal tonality mixes into the mode-fixed --terminal-surface token", () => {
    const css = resolveComponentStyleCss({ aiTerminal: { tonality: "glass" } })
    expect(css).toContain('[data-slot="ai-terminal"]')
    expect(css).toContain(
      "color-mix(in oklch,var(--terminal-surface) var(--surface-tonality-glass),transparent)"
    )
  })

  it("treats the context footer as portaled — no [data-bg-target] step", () => {
    const css = resolveComponentStyleCss({ aiContext: { tonality: "translucent" } })
    expect(css).toContain('body[data-bg-enabled="true"][data-bg-scope] [data-slot="ai-context"]')
    expect(css).not.toContain("[data-bg-target]")
  })
})

describe("applyComponentStyleCss", () => {
  it("creates, updates, and removes the singleton style tag", () => {
    applyComponentStyleCss("a{}")
    const tag = document.getElementById(STYLE_ELEMENT_ID)
    expect(tag?.tagName).toBe("STYLE")
    expect(tag?.textContent).toBe("a{}")

    applyComponentStyleCss("b{}")
    expect(document.getElementById(STYLE_ELEMENT_ID)?.textContent).toBe("b{}")

    applyComponentStyleCss("")
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull()
  })
})

describe("ComponentStyleApplier", () => {
  it("injects CSS from the store and cleans up on unmount", () => {
    setComponentStyles({ card: { tonality: "frosted" } })
    const { unmount } = render(<ComponentStyleApplier />)
    expect(document.getElementById(STYLE_ELEMENT_ID)?.textContent).toContain(
      "--surface-tonality-frosted"
    )
    unmount()
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull()
  })

  it("removes the tag when there are no overrides", () => {
    applyComponentStyleCss("stale{}")
    setComponentStyles({})
    render(<ComponentStyleApplier />)
    expect(document.getElementById(STYLE_ELEMENT_ID)).toBeNull()
  })
})
