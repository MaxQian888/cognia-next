/**
 * @jest-environment node
 *
 * The appliers in this directory write custom properties onto `<html>`, and
 * stylesheets are the only thing that can turn them into pixels. Nothing else
 * in the test suite can catch a knob whose `var()` reader is missing: Jest maps
 * every `.css` import to `__mocks__/styleMock.js` (jest.config.ts), so an
 * applier with a perfect unit test and no consumer anywhere still passes.
 *
 * That is exactly how `--line-height-scale`, `--letter-spacing-em` and the five
 * `--density-*` properties all shipped inert — written on every settings change,
 * read by nobody, sliders that moved nothing.
 *
 * So this reads the stylesheets as text and asserts the other half of the
 * contract.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(__dirname, "..", "..")

function css(...relativePaths: string[]): string {
  return relativePaths.map((p) => readFileSync(join(REPO_ROOT, p), "utf8")).join("\n")
}

const STYLESHEETS = css("app/globals.css", "app/typeset.css")

/** `var(--name` anywhere, i.e. somebody actually reads the property. */
function isRead(property: string): boolean {
  return STYLESHEETS.includes(`var(${property}`)
}

describe("appearance custom properties have a consumer", () => {
  // Written by `typography-applier.tsx` (line-height / letter-spacing sliders)
  // and by the `:root[data-density]` blocks in globals.css.
  it.each(["--line-height-scale", "--letter-spacing-em", "--density-line-height"])(
    "%s is read by at least one rule",
    (property) => {
      expect(isRead(property)).toBe(true)
    }
  )

  it("routes both leading knobs through a single multiplier", () => {
    expect(STYLESHEETS).toMatch(/--leading-multiplier:\s*calc\(/)
    // Guarded on both sides: an undefined var inside calc() invalidates the
    // whole property and would drop every line-height in the app to `normal`.
    expect(STYLESHEETS).toContain("var(--density-line-height, 1.5)")
    expect(STYLESHEETS).toContain("var(--line-height-scale, 1)")
  })

  it("scales every line-height token Tailwind compiles utilities down to", () => {
    // Tailwind v4 emits `line-height: var(--tw-leading, var(--text-<size>--line-height))`
    // for size utilities and `var(--leading-<name>)` for explicit ones, so these
    // are the only properties a line-height can come from. Display sizes
    // (5xl and up) ship at exactly 1 and are deliberately left unscaled.
    const tokens = [
      "--text-xs--line-height",
      "--text-sm--line-height",
      "--text-base--line-height",
      "--text-lg--line-height",
      "--text-xl--line-height",
      "--text-2xl--line-height",
      "--text-3xl--line-height",
      "--text-4xl--line-height",
      "--leading-tight",
      "--leading-snug",
      "--leading-normal",
      "--leading-relaxed",
    ]
    for (const token of tokens) {
      const rule = new RegExp(`${token}:[^;]*var\\(--leading-multiplier\\)`)
      expect(STYLESHEETS).toMatch(rule)
    }
  })

  it("re-resolves the multiplier inside a per-surface density container", () => {
    // A custom property is substituted where it is DECLARED. Declared only on
    // `:root`, `--leading-multiplier` bakes in the root density and descendants
    // inherit the finished number — so the `[data-density-surface]` blocks
    // would set `--density-line-height` for a reader that no longer exists and
    // per-surface line-height would stay at the global value.
    expect(STYLESHEETS).toMatch(
      /\[data-surface\]\[data-density-surface\][^{]*\{[^}]*--leading-multiplier:\s*calc\(/
    )
  })

  it("scales the loose leading token too", () => {
    // `leading-loose` is a real Tailwind utility; leaving it out made one rung
    // of the scale ignore the slider.
    expect(STYLESHEETS).toMatch(/--leading-loose:[^;]*var\(--leading-multiplier\)/)
  })

  it("gives typeset its own multiplier hookup", () => {
    // typeset writes `line-height` directly rather than through a utility, so
    // the theme tokens above cannot reach it.
    expect(STYLESHEETS).toMatch(/--typeset-leading:\s*calc\([^)]*var\(--leading-multiplier\)/)
  })

  it("applies letter-spacing where it can inherit to the whole document", () => {
    expect(STYLESHEETS).toMatch(/letter-spacing:\s*var\(--letter-spacing-em\)/)
  })

  // ADR-0127 gave the three surfaces the density card names (chat / tables /
  // sidebar) real `data-surface` containers via `densitySurfaceProps`, and the
  // surface components read the tokens through Tailwind arbitrary values
  // (`py-(--density-gap)` etc.), which live in TSX rather than in a
  // stylesheet — so the consumer scan for these includes the surface files.
  const SURFACE_SOURCES = css(
    "components/chat/message-list.tsx",
    "components/chat/message-renderer.tsx",
    "components/desktop/channel-list.tsx",
    "components/ui/table.tsx"
  )
  const isReadAnywhere = (property: string) =>
    isRead(property) ||
    SURFACE_SOURCES.includes(`var(${property}`) ||
    SURFACE_SOURCES.includes(`(${property}`)

  it.each(["--density-spacing", "--density-row-padding", "--density-gap"])(
    "%s is read by a density surface (ADR-0127)",
    (property) => {
      expect(isReadAnywhere(property)).toBe(true)
    }
  )

  it("mounts every density surface the settings card names", () => {
    expect(SURFACE_SOURCES).toContain('densitySurfaceProps("chat"')
    expect(SURFACE_SOURCES).toContain('densitySurfaceProps("sidebar"')
    expect(SURFACE_SOURCES).toContain('densitySurfaceProps("table"')
  })

  // Honest baseline for what is still inert. This list may only shrink.
  it("records the density knobs that are still inert", () => {
    const stillDead = ["--density-input-height"].filter((property) => !isReadAnywhere(property))
    expect(stillDead).toEqual(["--density-input-height"])
  })
})
