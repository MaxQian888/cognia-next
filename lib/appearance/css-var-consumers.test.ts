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

  // The wallpaper legibility guard writes `--wp-max-weight` on <body>; without
  // a reader it would solve, persist and write a cap that nothing paints.
  it.each([
    "--wp-max-weight",
    "--app-bg-painted-opacity",
    "--control-bg",
    "--surface-tonality-control",
  ])("%s (wallpaper legibility) is read by at least one rule", (property) => {
    expect(isRead(property)).toBe(true)
  })

  it("caps every wallpaper layer at the guard's weight", () => {
    // Guarded with a fallback: an unset cap must mean uncapped, never an
    // invalid `min()` that drops opacity to its initial value.
    expect(STYLESHEETS).toContain("min(var(--app-bg-opacity), var(--wp-max-weight, 1))")
    // No layer may read the raw slider value past the cap.
    expect(STYLESHEETS).not.toMatch(/opacity:\s*var\(--app-bg-opacity\)/)
  })

  // Translucent layers compounded: body, #app and each shell target repaint
  // the wallpaper under scope all/global, so a 21% cap showed ~60% image.
  it("paints every wallpaper layer as one opaque veiled composite", () => {
    const layers = STYLESHEETS.match(
      /background-image: linear-gradient\(var\(--app-bg-veil\), var\(--app-bg-veil\)\), var\(--app-bg-image(-b)?\);/g
    )
    // body ::before / ::after and the scoped target ::before / ::after.
    expect(layers).toHaveLength(4)
    expect(STYLESHEETS).not.toMatch(/background-image:\s*var\(--app-bg-image(-b)?\);/)
    expect(STYLESHEETS).not.toMatch(/opacity:\s*var\(--app-bg-painted-opacity\)/)
    expect(isRead("--app-bg-fade")).toBe(true)
    expect(isRead("--app-bg-veil")).toBe(true)
  })

  // A feature rail reads these as `bg-[var(--sidebar-pane-bg,var(--sidebar))]`;
  // defined only inside a wallpaper scope, so outside one the rail keeps its
  // solid tint and inside one it turns to the glass the guard solves for.
  it.each(["--sidebar-pane-bg", "--sidebar-pane-filter"])(
    "%s is defined in the wallpaper scope and read by the scheduler rail",
    (property) => {
      expect(STYLESHEETS).toMatch(new RegExp(`${property}:\\s*\\S`))
      expect(css("components/scheduler/scheduler-shell.tsx")).toContain(`var(${property},`)
    }
  )

  // Five scope selectors per wallpaper-only rule: chat, canvas, sidebar, all,
  // global. A rule missing one would leave that scope's panels solid (or its
  // glow on) while the rest adapt.
  it.each([
    ["hairline grid plate", String.raw`\[data-hairline-grid\]\s*[,{]`],
    ["hairline grid cells", String.raw`\[data-hairline-grid\]\s*>\s*\*`],
    ["ambient glows", String.raw`\[data-ambient-glow\]\s*[,{]`],
  ])("scopes the %s rule to every wallpaper scope", (_name, tail) => {
    for (const scope of ["chat", "canvas", "sidebar", "all", "global"]) {
      const head = String.raw`body\[data-bg-enabled="true"\]\[data-bg-scope="${scope}"\][^,{]*`
      expect(STYLESHEETS).toMatch(new RegExp(head + tail))
    }
  })

  it("inks muted text inside a highlighted item for the accent fill", () => {
    // The command palette's selected row and a hovered menu item's shortcut
    // dropped toward 1:1 under a colour preset or high-contrast dark.
    const start = STYLESHEETS.indexOf('[data-slot="command-item"][data-selected="true"]')
    expect(start).toBeGreaterThan(-1)
    const rule = STYLESHEETS.slice(start, STYLESHEETS.indexOf("}", start))
    expect(rule).toContain(".text-muted-foreground")
    expect(rule).toContain("[data-highlighted]")
    expect(rule).toContain("color: var(--accent-foreground)")
  })

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
    // ADR-0148 made this a sum rather than a plain read: the style pack's
    // tightening and the user's typography slider are separate inputs and must
    // both survive. Asserting the composition (not just the presence of one
    // var) is what stops a future edit from dropping either side.
    expect(STYLESHEETS).toMatch(
      /letter-spacing:\s*calc\(\s*var\(--letter-spacing-em\)\s*\+\s*var\(--style-letter-spacing-em[^)]*\)\s*\)/
    )
  })

  it("gives every style-pack custom property a consumer", () => {
    // `StylePackApplier` writes these onto <html>; a token nobody reads is the
    // exact failure mode ADR-0007 catalogued (a whole `scope` feature whose
    // target attribute no component ever applied).
    expect(STYLESHEETS).toMatch(/--radius-pill:\s*var\(--pill-radius\)/)
    expect(STYLESHEETS).toMatch(/html\[data-border-tone="hairline"\]/)
    expect(STYLESHEETS).toMatch(/html\[data-border-tone="strong"\]/)
    expect(STYLESHEETS).toMatch(/html\[data-elevation-max="0"\]/)
    expect(STYLESHEETS).toMatch(/html\[data-elevation-max="1"\]/)
    expect(STYLESHEETS).toMatch(/html\[data-micro-label="mono-upper"\]/)
  })

  it("derives the named radius scale from the same base as sm/md/lg/xl", () => {
    // The named scale is an ALIAS, not a parallel system — that is what lets
    // the ~1,777 existing `rounded-sm/md/lg/xl` sites follow a style pack with
    // zero migration.
    for (const name of ["control", "panel", "stage"]) {
      expect(STYLESHEETS).toMatch(
        new RegExp(`--radius-${name}:\\s*max\\(0px,\\s*calc\\(var\\(--radius\\)`)
      )
    }
  })

  it("scales every radius step proportionally so a 0 base really is square", () => {
    // shadcn ships these as fixed ±px offsets, which leaves `rounded-xl` at 4px
    // when the base is 0 — "no rounded corners" was unreachable. Multipliers
    // hit the same 6/8/10/14px at the default base and collapse with it.
    for (const [step, factor] of [
      ["sm", "0.6"],
      ["md", "0.8"],
      ["xl", "1.4"],
    ] as const) {
      expect(STYLESHEETS).toMatch(
        new RegExp(`--radius-${step}: max\\(0px, calc\\(var\\(--radius\\) \\* ${factor}\\)\\)`)
      )
    }
    // No step may keep an absolute offset, or it survives a 0 base.
    expect(STYLESHEETS).not.toMatch(
      /--radius-(sm|md|lg|xl|control|panel|stage):[^;]*var\(--radius\)\s*[-+]\s*\d/
    )
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
    // The sidebar row reads `--density-row-padding` for its own vertical rhythm.
    "components/desktop/session-row.tsx",
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
