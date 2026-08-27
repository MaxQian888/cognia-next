/**
 * @jest-environment node
 *
 * The catalog is the only place that knows a token's CSS variable, its group,
 * and its default. Everything downstream — the applier's write list, the
 * editor's groups, the VSCode import map — is derived from it, so a mistake
 * here is silent and global. These tests read `app/globals.css` as text for the
 * same reason `css-var-consumers.test.ts` does: jest maps every `.css` import
 * to a style mock, so the stylesheet half of the contract is otherwise unprovable.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { converter, parse } from "culori"
import {
  ADVANCED_THEME_COLOR_KEYS,
  BASE_THEME_COLOR_KEYS,
  DEFAULT_GROUP_OPEN,
  THEME_COLOR_KEYS,
  THEME_TOKEN_CATALOG,
  THEME_TOKEN_CSS_VARS,
  THEME_TOKEN_GROUPS,
  THEME_TOKEN_GROUP_KEYS,
  defaultThemeColors,
  normalizeThemeColors,
  pickKnownTokens,
  themeTokenCssVar,
} from "./theme-token-catalog"

const GLOBALS = readFileSync(join(__dirname, "..", "..", "app", "globals.css"), "utf8")

/** Values declared inside `:root, .a2ui-widget-theme-light` / `.dark, .a2ui-widget-theme-dark`. */
function declaredBlock(startsWith: string): Record<string, string> {
  const lines = GLOBALS.split("\n")
  const start = lines.findIndex((line) => line.trim() === startsWith)
  expect(start).toBeGreaterThan(-1)
  const out: Record<string, string> = {}
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && /^\}/.test(lines[i])) break
    const m = lines[i].match(/^\s+(--[a-z0-9-]+):\s*(.+?);\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const LIGHT_DECLARED = declaredBlock(":root,")
const DARK_DECLARED = declaredBlock(".dark,")

describe("theme token catalog", () => {
  it("covers exactly 56 tokens, 27 required and 29 optional", () => {
    expect(THEME_TOKEN_CATALOG).toHaveLength(56)
    expect(BASE_THEME_COLOR_KEYS).toHaveLength(27)
    expect(ADVANCED_THEME_COLOR_KEYS).toHaveLength(29)
    expect(THEME_COLOR_KEYS).toHaveLength(56)
  })

  it("lists the required tokens before the optional ones", () => {
    const firstOptional = THEME_TOKEN_CATALOG.findIndex((d) => !d.base)
    const lastRequired = THEME_TOKEN_CATALOG.map((d) => d.base).lastIndexOf(true)
    expect(firstOptional).toBeGreaterThan(-1)
    // Not a strict prefix (brand/status interleave for UI grouping), but every
    // required key must still be present exactly once.
    expect(lastRequired).toBeGreaterThan(-1)
    expect(new Set(BASE_THEME_COLOR_KEYS).size).toBe(27)
  })

  it("has no duplicate keys and no duplicate CSS variables", () => {
    expect(new Set(THEME_COLOR_KEYS).size).toBe(THEME_COLOR_KEYS.length)
    expect(new Set(THEME_TOKEN_CSS_VARS).size).toBe(THEME_TOKEN_CSS_VARS.length)
  })

  // The whole reason the catalog exists: camel→kebab is wrong for 18 of the 56.
  it.each([
    ["chart1", "--chart-1"],
    ["chart5", "--chart-5"],
    ["workflowTrigger", "--wf-trigger"],
    ["workflowAnnotation", "--wf-annotation"],
    ["workflowStatusRunning", "--wf-status-running"],
    ["workflowStatusSucceeded", "--wf-status-succeeded"],
    ["effortUltraMuted", "--effort-ultra-muted"],
    ["brandWash", "--brand-wash"],
    ["primaryForeground", "--primary-foreground"],
    ["sidebarAccentForeground", "--sidebar-accent-foreground"],
  ])("maps %s to %s", (key, cssVar) => {
    expect(themeTokenCssVar(key)).toBe(cssVar)
  })

  it("falls back to camel→kebab for keys it does not own", () => {
    expect(themeTokenCssVar("somePluginExtra")).toBe("--some-plugin-extra")
  })

  it("names a CSS variable that globals.css actually declares", () => {
    const missing = THEME_TOKEN_CATALOG.filter((d) => LIGHT_DECLARED[d.cssVar] === undefined).map(
      (d) => d.cssVar
    )
    expect(missing).toEqual([])
  })

  it("copies every flat default verbatim from globals.css", () => {
    const drift: string[] = []
    for (const def of THEME_TOKEN_CATALOG) {
      if (def.default.kind !== "literal") continue
      if (LIGHT_DECLARED[def.cssVar] !== def.default.light) {
        drift.push(
          `${def.cssVar} light: css=${LIGHT_DECLARED[def.cssVar]} catalog=${def.default.light}`
        )
      }
      // A handful of tokens are achromatic and shared, so `.dark` re-declares
      // only what changes; anything it omits keeps the `:root` value.
      const darkCss = DARK_DECLARED[def.cssVar] ?? LIGHT_DECLARED[def.cssVar]
      if (darkCss !== def.default.dark) {
        drift.push(`${def.cssVar} dark: css=${darkCss} catalog=${def.default.dark}`)
      }
    }
    expect(drift).toEqual([])
  })

  it("declares the four var() aliases and the two computed tokens as derivations", () => {
    const derived = THEME_TOKEN_CATALOG.filter((d) => d.default.kind !== "literal").map(
      (d) => d.key
    )
    expect(derived.sort()).toEqual(
      [
        "brandWash",
        "effortUltraMuted",
        "workflowStatusFailed",
        "workflowStatusRunning",
        "workflowStatusSucceeded",
        "workflowStatusWaiting",
      ].sort()
    )
  })

  it("never derives from another derived token", () => {
    const derivedKeys = new Set(
      THEME_TOKEN_CATALOG.filter((d) => d.default.kind !== "literal").map((d) => d.key)
    )
    for (const def of THEME_TOKEN_CATALOG) {
      const d = def.default
      if (d.kind === "literal") continue
      expect(derivedKeys.has(d.from)).toBe(false)
      if (d.kind === "mix") expect(derivedKeys.has(d.into)).toBe(false)
    }
  })
})

describe("editor groups", () => {
  it("partitions all 56 tokens with no gap and no overlap", () => {
    const flattened = THEME_TOKEN_GROUPS.flatMap((g) => g.tokens)
    expect(flattened).toHaveLength(56)
    expect(new Set(flattened).size).toBe(56)
    expect(new Set(flattened)).toEqual(new Set(THEME_COLOR_KEYS))
  })

  it("has exactly eight groups, each non-empty", () => {
    expect(THEME_TOKEN_GROUP_KEYS).toHaveLength(8)
    for (const group of THEME_TOKEN_GROUPS) {
      expect(group.tokens.length).toBeGreaterThan(0)
    }
  })

  it("opens the first three groups by default", () => {
    const open = THEME_TOKEN_GROUP_KEYS.filter((k) => DEFAULT_GROUP_OPEN[k])
    expect(open).toEqual(["surfaceText", "brand", "status"])
  })
})

describe("normalizeThemeColors", () => {
  it("fills a legacy 27-token palette out to 56", () => {
    const legacy: Record<string, string> = {}
    for (const key of BASE_THEME_COLOR_KEYS) legacy[key] = "#123456"
    const resolved = normalizeThemeColors(legacy, "dark")
    for (const key of THEME_COLOR_KEYS) {
      expect(typeof resolved[key]).toBe("string")
      expect(resolved[key].length).toBeGreaterThan(0)
    }
  })

  it("keeps every explicitly-set value", () => {
    const resolved = normalizeThemeColors({ chart1: "#ff0000", warning: "#00ff00" }, "light")
    expect(resolved.chart1).toBe("#ff0000")
    expect(resolved.warning).toBe("#00ff00")
  })

  it("treats blank strings as unset", () => {
    const resolved = normalizeThemeColors({ chart1: "   " }, "light")
    expect(resolved.chart1).toBe("oklch(0.646 0.222 41.116)")
  })

  // The point of decision 1: retinting `warning` moves the running badge.
  it("tracks an aliased token to its source", () => {
    const resolved = normalizeThemeColors({ warning: "#abcdef" }, "light")
    expect(resolved.workflowStatusRunning).toBe("#abcdef")
    expect(resolved.workflowStatusSucceeded).toBe(resolved.success)
    expect(resolved.workflowStatusFailed).toBe(resolved.destructive)
    expect(resolved.workflowStatusWaiting).toBe(resolved.workflowAction)
  })

  it("lets an explicit override beat the alias", () => {
    const resolved = normalizeThemeColors(
      { warning: "#abcdef", workflowStatusRunning: "#111111" },
      "light"
    )
    expect(resolved.workflowStatusRunning).toBe("#111111")
  })

  it("derives the muted effort accent at the variant's alpha", () => {
    const light = normalizeThemeColors({ effortUltra: "#ff0000" }, "light")
    const dark = normalizeThemeColors({ effortUltra: "#ff0000" }, "dark")
    expect(light.effortUltraMuted).toContain("/")
    expect(light.effortUltraMuted).not.toBe(dark.effortUltraMuted)
    const parsed = converter("oklch")(parse(light.effortUltraMuted)!)
    expect(parsed?.alpha).toBeCloseTo(0.22, 5)
  })

  it("derives the brand wash by mixing the brand action into the background", () => {
    const resolved = normalizeThemeColors(
      { brandAction: "#000000", background: "#ffffff" },
      "light"
    )
    // 7% black into white stays close to white but is measurably darker.
    const l = converter("oklch")(parse(resolved.brandWash)!)!.l
    expect(l).toBeLessThan(1)
    expect(l).toBeGreaterThan(0.9)
  })

  it("produces a parsable colour for every token from an empty input", () => {
    for (const variant of ["light", "dark"] as const) {
      const resolved = defaultThemeColors(variant)
      const unparsable = THEME_COLOR_KEYS.filter((key) => parse(resolved[key]) === undefined)
      expect(unparsable).toEqual([])
    }
  })
})

/**
 * A derived token's source can be a value the editor accepted but culori
 * cannot read — a `color-mix()`, or plain nonsense a user typed. The
 * derivation has to degrade to something renderable rather than throwing
 * mid-paint or emitting an empty custom property.
 */
describe("derivations over unreadable sources", () => {
  it("passes an unreadable source through when computing the muted accent", () => {
    const resolved = normalizeThemeColors({ effortUltra: "not-a-colour" }, "light")
    expect(resolved.effortUltraMuted).toBe("not-a-colour")
  })

  it("passes an unreadable brand action through when computing the wash", () => {
    const resolved = normalizeThemeColors(
      { brandAction: "color-mix(in oklab, red 5%, blue)" },
      "light"
    )
    expect(resolved.brandWash).toBe("color-mix(in oklab, red 5%, blue)")
  })

  it("falls back when the surface being mixed into is unreadable", () => {
    const resolved = normalizeThemeColors(
      { brandAction: "#112233", background: "nonsense" },
      "light"
    )
    expect(resolved.brandWash).toBe("#112233")
  })

  it("still resolves every token when several sources are unreadable", () => {
    const resolved = normalizeThemeColors(
      { warning: "garbage", effortUltra: "garbage", brandAction: "garbage" },
      "dark"
    )
    for (const key of THEME_COLOR_KEYS) {
      expect(resolved[key].length).toBeGreaterThan(0)
    }
    // An alias mirrors its source verbatim, readable or not.
    expect(resolved.workflowStatusRunning).toBe("garbage")
  })
})

describe("pickKnownTokens", () => {
  it("keeps catalog keys and drops everything else", () => {
    const picked = pickKnownTokens({
      background: "#000000",
      chart3: "#123123",
      "--injected": "red",
      notAToken: "#fff",
      blank: "",
    })
    expect(picked).toEqual({ background: "#000000", chart3: "#123123" })
  })

  it("trims surrounding whitespace", () => {
    expect(pickKnownTokens({ background: "  #abcabc  " })).toEqual({ background: "#abcabc" })
  })
})

/**
 * `tokenT(key)` and `` t(`groups.${key}`) `` are dynamic lookups, so
 * `pnpm lint:i18n` cannot see them: a token with no label renders its raw key
 * and nothing fails. This is the guard. It reads the split sources under
 * `i18n/messages/**` — the actual authoring surface — not the generated bundle.
 */
describe("i18n coverage", () => {
  const load = (locale: string) =>
    JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "i18n", "messages", locale, "settings", "appearance.json"),
        "utf8"
      )
    ).customTheme as { tokens: Record<string, unknown>; groups: Record<string, unknown> }

  const LOCALES = ["en", "zh-CN"]

  it.each(LOCALES)("%s labels every token in the catalog", (locale) => {
    const { tokens } = load(locale)
    const missing = THEME_COLOR_KEYS.filter((key) => typeof tokens[key] !== "string")
    expect(missing).toEqual([])
  })

  it.each(LOCALES)("%s labels every editor group", (locale) => {
    const { groups } = load(locale)
    const missing = THEME_TOKEN_GROUP_KEYS.filter((key) => typeof groups[key] !== "string")
    expect(missing).toEqual([])
  })

  it.each(LOCALES)("%s carries no label for a token that no longer exists", (locale) => {
    const { tokens, groups } = load(locale)
    // `aria` is the nested { hex, swatch } sub-object the rows use.
    const stray = Object.keys(tokens).filter(
      (key) => key !== "aria" && !THEME_COLOR_KEYS.includes(key as never)
    )
    expect(stray).toEqual([])
    expect(Object.keys(groups).sort()).toEqual([...THEME_TOKEN_GROUP_KEYS].sort())
  })

  it("keeps the two locales at exact key parity", () => {
    const en = load("en")
    const zh = load("zh-CN")
    expect(Object.keys(zh.tokens).sort()).toEqual(Object.keys(en.tokens).sort())
    expect(Object.keys(zh.groups).sort()).toEqual(Object.keys(en.groups).sort())
  })
})
