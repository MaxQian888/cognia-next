/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import appearanceEn from "@/i18n/messages/en/settings/appearance.json"
import appearanceZh from "@/i18n/messages/zh-CN/settings/appearance.json"
import type { ActiveThemeVariant } from "@/lib/appearance/active-theme-variant"

import {
  ActiveThemeAppliedNote,
  ActiveThemeBadge,
  activeThemeMessageKey,
} from "./active-theme-status"

// No local next-intl mock: the global one (jest.setup.ts) resolves keys
// against the real English catalog, so these assert on what the user reads.

const status = (
  kind: ActiveThemeVariant["kind"],
  mode: ActiveThemeVariant["mode"],
  themeVariant: ActiveThemeVariant["themeVariant"]
): ActiveThemeVariant => ({ kind, mode, themeVariant })

describe("activeThemeMessageKey", () => {
  it("keys by kind and the current mode", () => {
    expect(activeThemeMessageKey(status("authored", "dark", "dark"))).toBe("authored.dark")
    expect(activeThemeMessageKey(status("derived", "light", "dark"))).toBe("derived.light")
    expect(activeThemeMessageKey(status("fixed", "light", "dark"))).toBe("fixed")
  })

  it("names the theme's own mode for a theme dormant outside it", () => {
    expect(activeThemeMessageKey(status("dormant", "light", "dark"))).toBe("dormantOnly.dark")
    expect(activeThemeMessageKey(status("dormant", "dark", null))).toBe("dormant.dark")
    expect(activeThemeMessageKey(status("dormant", "dark", "dark"))).toBe("dormant.dark")
  })

  it("every key it can produce exists in both locales", () => {
    const kinds: ActiveThemeVariant["kind"][] = ["authored", "derived", "fixed", "dormant"]
    const modes = ["light", "dark"] as const
    const variants = ["light", "dark", null] as const
    const resolve = (root: unknown, path: string) =>
      path.split(".").reduce<unknown>((node, seg) => (node as Record<string, unknown>)?.[seg], root)
    for (const kind of kinds)
      for (const mode of modes)
        for (const variant of variants) {
          const key = activeThemeMessageKey(status(kind, mode, variant))
          for (const catalog of [appearanceEn, appearanceZh]) {
            for (const surface of ["badge", "applied"]) {
              expect(typeof resolve(catalog, `vscode.activeVariant.${surface}.${key}`)).toBe(
                "string"
              )
            }
          }
        }
  })
})

describe("ActiveThemeBadge", () => {
  it("says which mode the theme is active for", () => {
    render(<ActiveThemeBadge status={status("authored", "dark", "dark")} />)
    expect(screen.getByTestId("active-theme-badge")).toHaveTextContent("Active · Dark")
  })

  it("marks a palette derived for the current mode", () => {
    render(<ActiveThemeBadge status={status("derived", "light", "dark")} />)
    expect(screen.getByTestId("active-theme-badge")).toHaveTextContent("Active · Light (derived)")
  })

  it("says a single-palette plugin theme looks the same in both modes", () => {
    render(<ActiveThemeBadge status={status("fixed", "light", "dark")} />)
    expect(screen.getByTestId("active-theme-badge")).toHaveTextContent(
      "Active · Same in both modes"
    )
  })

  // Intentional dormancy, labeled inert: never a bare "Active" for a theme the
  // current mode is not painting.
  it("labels a dormant theme as inactive in the current mode", () => {
    render(<ActiveThemeBadge status={status("dormant", "light", "dark")} />)
    const badge = screen.getByTestId("active-theme-badge")
    expect(badge).toHaveTextContent("Active · Dark only · inactive in light mode")
    expect(badge).toHaveAttribute("data-dormant", "true")
    expect(badge).toHaveClass("text-muted-foreground")
    expect(badge).not.toHaveClass("text-primary")
  })

  it("labels a dormant theme with no recorded variant", () => {
    render(<ActiveThemeBadge status={status("dormant", "dark", null)} />)
    expect(screen.getByTestId("active-theme-badge")).toHaveTextContent(
      "Active · Inactive in dark mode"
    )
  })

  it("falls back to the plain label before a mode has resolved", () => {
    render(<ActiveThemeBadge status={null} />)
    const badge = screen.getByTestId("active-theme-badge")
    expect(badge).toHaveTextContent(/^Active$/)
    expect(badge).not.toHaveAttribute("data-active-kind")
  })
})

describe("ActiveThemeAppliedNote", () => {
  it("names what the current mode is painting", () => {
    render(<ActiveThemeAppliedNote status={status("derived", "light", "dark")} name="Dracula" />)
    expect(screen.getByRole("status")).toHaveTextContent(
      "Light mode is showing a light palette derived from Dracula’s dark one."
    )
  })

  it("explains a dormant theme and when it applies again", () => {
    render(<ActiveThemeAppliedNote status={status("dormant", "light", "dark")} name="Legacy" />)
    const note = screen.getByRole("status")
    expect(note).toHaveTextContent(
      "Legacy only has a dark palette, so it is inactive in light mode"
    )
    expect(note).toHaveTextContent("It applies again when you switch to dark mode.")
    expect(note).toHaveAttribute("data-dormant", "true")
  })

  it("renders nothing without a status or a name", () => {
    const { container } = render(<ActiveThemeAppliedNote status={null} name="Dracula" />)
    expect(container).toBeEmptyDOMElement()
    render(<ActiveThemeAppliedNote status={status("authored", "dark", "dark")} name={null} />)
    expect(screen.queryByRole("status")).toBeNull()
  })
})
