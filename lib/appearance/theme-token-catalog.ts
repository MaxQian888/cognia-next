/**
 * The one table that says what a theme color token *is*.
 *
 * Before this module the answer was spread across four places that disagreed:
 * `THEME_COLOR_KEYS` listed 27 of the 56 tokens the app actually paints with,
 * `themeKeyToCssVar` guessed the CSS variable name by camel→kebab, the light and
 * dark defaults lived only in `app/globals.css`, and the VSCode import map was a
 * separate exhaustive record. The other 29 tokens — status, charts, workflow
 * nodes and statuses, the effort accent, the brand triple — were fully wired
 * into Tailwind via `@theme inline` and consumed all over the app, yet no theme
 * could touch them: a custom theme could recolour the entire shell and the
 * charts stayed factory orange.
 *
 * Each entry declares, for exactly one token:
 *   - the `ThemeColors` key,
 *   - the CSS custom property it writes — **explicitly**, because camel→kebab
 *     turns `chart1` into `--chart1` and `workflowTrigger` into
 *     `--workflow-trigger`, neither of which any stylesheet reads,
 *   - which editor group it belongs to (a complete, disjoint partition),
 *   - its light/dark default, and
 *   - the ordered VSCode workbench keys an import should consult, when there is
 *     an honest correspondence.
 *
 * ## Literal vs derived defaults
 *
 * Six tokens are not independent colours in `globals.css`. Four `--wf-status-*`
 * are `var()` aliases of `--warning` / `--success` / `--destructive` /
 * `--wf-action`; `--brand-wash` is a `color-mix()` of `--brand-action` into
 * `--background`; `--effort-ultra-muted` is `--effort-ultra` at 22% / 26% alpha.
 *
 * Freezing those into literals would silently cut the link — a theme that
 * recoloured `warning` would leave the "running" workflow badge on the stock
 * amber. So they are declared as derivations and computed from the *resolved*
 * palette every time. Retint `warning` and the running badge follows; set
 * `workflowStatusRunning` explicitly and the override wins. The derivations use
 * the same oklab space CSS `color-mix(in oklab, …)` does, so the computed value
 * matches what the stylesheet would have produced.
 */
import { converter, formatCss, interpolate, parse } from "culori"
import type { ResolvedThemeColors, ThemeColors } from "@/types/plugin/plugin"

const toOklch = converter("oklch")

export type ThemeTokenKey = keyof ThemeColors

/**
 * Editor clusters. A complete, disjoint partition of all 56 tokens — the
 * partition test in `theme-token-catalog.test.ts` fails if a token is missing
 * or lands in two groups, which is the forcing function that stops a new token
 * from shipping unreachable in the UI.
 */
export type ThemeTokenGroupKey =
  | "surfaceText"
  | "brand"
  | "status"
  | "sidebar"
  | "chart"
  | "workflowNode"
  | "workflowState"
  | "productAccent"

export const THEME_TOKEN_GROUP_KEYS: readonly ThemeTokenGroupKey[] = [
  "surfaceText",
  "brand",
  "status",
  "sidebar",
  "chart",
  "workflowNode",
  "workflowState",
  "productAccent",
]

/** Groups expanded on first render. The rest start collapsed. */
export const DEFAULT_GROUP_OPEN: Record<ThemeTokenGroupKey, boolean> = {
  surfaceText: true,
  brand: true,
  status: true,
  sidebar: false,
  chart: false,
  workflowNode: false,
  workflowState: false,
  productAccent: false,
}

export type TokenDefault =
  /** A flat colour, copied verbatim from `app/globals.css`. */
  | { kind: "literal"; light: string; dark: string }
  /** Mirrors another token in the same palette (`--wf-status-running: var(--warning)`). */
  | { kind: "alias"; from: ThemeTokenKey }
  /** Another token at reduced alpha (`--effort-ultra-muted`). */
  | { kind: "alpha"; from: ThemeTokenKey; light: number; dark: number }
  /** `percent`% of `from` mixed into `into`, in oklab (`--brand-wash`). */
  | { kind: "mix"; from: ThemeTokenKey; into: ThemeTokenKey; percent: number }

export interface ThemeTokenDef {
  key: ThemeTokenKey
  /** Full custom-property name. Declared, never inferred. */
  cssVar: string
  group: ThemeTokenGroupKey
  default: TokenDefault
  /**
   * True for the 27 tokens `ThemeColors` requires. Advanced tokens are optional
   * and saved sparsely, which is what keeps a derived default live across edits.
   */
  base: boolean
  /**
   * Ordered VSCode workbench colour keys to consult on import; first present
   * wins. Absent means the format has no honest counterpart — the importer
   * falls back to the cognia default rather than inventing one from
   * `tokenColors` (an explicit ADR-0007 non-goal).
   */
  vscode?: readonly string[]
}

// ----------------------------------------------------------------------------
// The catalog. Order is the UI order: the 27 base tokens first (unchanged from
// the previous `THEME_COLOR_KEYS`), then the 29 advanced ones.
// ----------------------------------------------------------------------------

function lit(light: string, dark: string): TokenDefault {
  return { kind: "literal", light, dark }
}

export const THEME_TOKEN_CATALOG: readonly ThemeTokenDef[] = [
  // ----- base: surface & text -----
  {
    key: "background",
    cssVar: "--background",
    group: "surfaceText",
    base: true,
    default: lit("oklch(1 0 0)", "oklch(0.145 0 0)"),
    vscode: ["editor.background", "tab.activeBackground"],
  },
  {
    key: "foreground",
    cssVar: "--foreground",
    group: "surfaceText",
    base: true,
    default: lit("oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    vscode: ["editor.foreground", "foreground"],
  },
  {
    key: "card",
    cssVar: "--card",
    group: "surfaceText",
    base: true,
    default: lit("oklch(1 0 0)", "oklch(0.205 0 0)"),
    // `editorGroup.dropBackground` is omitted on purpose — it's a transient
    // drag-overlay color themes usually define with embedded alpha, which
    // produces saturated tints once the alpha is stripped.
    vscode: ["panel.background", "editor.background"],
  },
  {
    key: "cardForeground",
    cssVar: "--card-foreground",
    group: "surfaceText",
    base: true,
    default: lit("oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    vscode: ["editorWidget.foreground", "foreground"],
  },
  {
    key: "popover",
    cssVar: "--popover",
    group: "surfaceText",
    base: true,
    default: lit("oklch(1 0 0)", "oklch(0.205 0 0)"),
    vscode: ["editorWidget.background", "dropdown.background", "quickInput.background"],
  },
  {
    key: "popoverForeground",
    cssVar: "--popover-foreground",
    group: "surfaceText",
    base: true,
    default: lit("oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    vscode: ["editorWidget.foreground", "dropdown.foreground", "foreground"],
  },
  {
    key: "muted",
    cssVar: "--muted",
    group: "surfaceText",
    base: true,
    default: lit("oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    vscode: ["editor.lineHighlightBackground", "input.background", "editorWidget.background"],
  },
  {
    key: "mutedForeground",
    cssVar: "--muted-foreground",
    group: "surfaceText",
    base: true,
    default: lit("oklch(0.545 0 0)", "oklch(0.708 0 0)"),
    vscode: ["descriptionForeground", "editorLineNumber.foreground", "tab.inactiveForeground"],
  },
  {
    key: "border",
    cssVar: "--border",
    group: "surfaceText",
    base: true,
    default: lit("oklch(0.922 0 0)", "oklch(1 0 0 / 10%)"),
    vscode: [
      "panel.border",
      "editorWidget.border",
      "editorGroup.border",
      "tab.border",
      "input.border",
    ],
  },
  {
    key: "input",
    cssVar: "--input",
    group: "surfaceText",
    base: true,
    default: lit("oklch(0.922 0 0)", "oklch(1 0 0 / 15%)"),
    vscode: ["input.background", "editorWidget.background"],
  },
  {
    key: "ring",
    cssVar: "--ring",
    group: "surfaceText",
    base: true,
    default: lit("oklch(0.708 0 0)", "oklch(0.556 0 0)"),
    vscode: ["focusBorder", "editorWidget.border"],
  },

  // ----- base + brand triple -----
  {
    key: "primary",
    cssVar: "--primary",
    group: "brand",
    base: true,
    default: lit("oklch(0.205 0 0)", "oklch(0.922 0 0)"),
    vscode: [
      "button.background",
      "button.hoverBackground",
      "activityBarBadge.background",
      "statusBarItem.prominentBackground",
    ],
  },
  {
    key: "primaryForeground",
    cssVar: "--primary-foreground",
    group: "brand",
    base: true,
    default: lit("oklch(0.985 0 0)", "oklch(0.205 0 0)"),
    vscode: ["button.foreground", "activityBarBadge.foreground"],
  },
  {
    key: "secondary",
    cssVar: "--secondary",
    group: "brand",
    base: true,
    default: lit("oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    vscode: [
      "panel.background",
      "sideBarSectionHeader.background",
      "editorGroupHeader.tabsBackground",
    ],
  },
  {
    key: "secondaryForeground",
    cssVar: "--secondary-foreground",
    group: "brand",
    base: true,
    default: lit("oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    vscode: ["panel.border", "tab.inactiveForeground", "foreground"],
  },
  {
    key: "accent",
    cssVar: "--accent",
    group: "brand",
    base: true,
    default: lit("oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    vscode: [
      "list.activeSelectionBackground",
      "list.focusBackground",
      "editor.selectionBackground",
      "editorLink.activeForeground",
    ],
  },
  {
    key: "accentForeground",
    cssVar: "--accent-foreground",
    group: "brand",
    base: true,
    default: lit("oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    vscode: ["list.activeSelectionForeground", "list.focusForeground", "tab.activeForeground"],
  },
  {
    key: "brandAction",
    cssVar: "--brand-action",
    group: "brand",
    base: false,
    default: lit("#35cedd", "#4fdcea"),
  },
  {
    key: "brandApproval",
    cssVar: "--brand-approval",
    group: "brand",
    base: false,
    default: lit("#d99a3d", "#e5ac57"),
  },
  {
    // `globals.css` declares this once, in `:root`, as a color-mix that follows
    // both `--brand-action` and `--background` automatically — which is exactly
    // what this derivation reproduces.
    key: "brandWash",
    cssVar: "--brand-wash",
    group: "brand",
    base: false,
    default: { kind: "mix", from: "brandAction", into: "background", percent: 7 },
  },

  // ----- status -----
  {
    key: "destructive",
    cssVar: "--destructive",
    group: "status",
    base: true,
    default: lit("oklch(0.577 0.245 27.325)", "oklch(0.704 0.191 22.216)"),
    vscode: ["errorForeground", "editorError.foreground", "inputValidation.errorBorder"],
  },
  {
    key: "destructiveForeground",
    cssVar: "--destructive-foreground",
    group: "status",
    base: true,
    default: lit("oklch(0.985 0 0)", "oklch(0.145 0 0)"),
    vscode: ["editor.background"],
  },
  {
    key: "success",
    cssVar: "--success",
    group: "status",
    base: false,
    default: lit("oklch(0.62 0.17 145)", "oklch(0.72 0.18 150)"),
    vscode: [
      "gitDecoration.addedResourceForeground",
      "editorGutter.addedBackground",
      "charts.green",
      "terminal.ansiGreen",
    ],
  },
  {
    key: "successForeground",
    cssVar: "--success-foreground",
    group: "status",
    base: false,
    default: lit("oklch(0.205 0 0)", "oklch(0.145 0 0)"),
  },
  {
    key: "warning",
    cssVar: "--warning",
    group: "status",
    base: false,
    default: lit("oklch(0.75 0.17 80)", "oklch(0.82 0.18 85)"),
    vscode: [
      "editorWarning.foreground",
      "list.warningForeground",
      "charts.yellow",
      "terminal.ansiYellow",
    ],
  },
  {
    key: "warningForeground",
    cssVar: "--warning-foreground",
    group: "status",
    base: false,
    default: lit("oklch(0.205 0 0)", "oklch(0.145 0 0)"),
  },
  {
    key: "info",
    cssVar: "--info",
    group: "status",
    base: false,
    default: lit("oklch(0.6 0.13 220)", "oklch(0.7 0.15 220)"),
    vscode: ["editorInfo.foreground", "charts.blue", "terminal.ansiBlue"],
  },
  {
    key: "infoForeground",
    cssVar: "--info-foreground",
    group: "status",
    base: false,
    default: lit("oklch(0.205 0 0)", "oklch(0.145 0 0)"),
  },

  // ----- sidebar -----
  {
    key: "sidebar",
    cssVar: "--sidebar",
    group: "sidebar",
    base: true,
    default: lit("oklch(0.985 0 0)", "oklch(0.205 0 0)"),
    vscode: ["sideBar.background", "activityBar.background"],
  },
  {
    key: "sidebarForeground",
    cssVar: "--sidebar-foreground",
    group: "sidebar",
    base: true,
    default: lit("oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    vscode: ["sideBar.foreground", "activityBar.foreground"],
  },
  {
    key: "sidebarPrimary",
    cssVar: "--sidebar-primary",
    group: "sidebar",
    base: true,
    default: lit("oklch(0.205 0 0)", "oklch(0.488 0.243 264.376)"),
    vscode: ["activityBarBadge.background", "list.activeSelectionBackground"],
  },
  {
    key: "sidebarPrimaryForeground",
    cssVar: "--sidebar-primary-foreground",
    group: "sidebar",
    base: true,
    default: lit("oklch(0.985 0 0)", "oklch(0.985 0 0)"),
    vscode: ["activityBarBadge.foreground", "list.activeSelectionForeground"],
  },
  {
    key: "sidebarAccent",
    cssVar: "--sidebar-accent",
    group: "sidebar",
    base: true,
    default: lit("oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    vscode: ["list.hoverBackground", "list.inactiveSelectionBackground"],
  },
  {
    key: "sidebarAccentForeground",
    cssVar: "--sidebar-accent-foreground",
    group: "sidebar",
    base: true,
    default: lit("oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    vscode: ["list.hoverForeground", "list.inactiveSelectionForeground", "foreground"],
  },
  {
    key: "sidebarBorder",
    cssVar: "--sidebar-border",
    group: "sidebar",
    base: true,
    default: lit("oklch(0.922 0 0)", "oklch(1 0 0 / 10%)"),
    vscode: ["sideBar.border", "activityBar.border"],
  },
  {
    key: "sidebarRing",
    cssVar: "--sidebar-ring",
    group: "sidebar",
    base: true,
    default: lit("oklch(0.708 0 0)", "oklch(0.556 0 0)"),
    vscode: ["focusBorder", "list.focusOutline"],
  },

  // ----- charts. Note the CSS names are hyphen-numbered. -----
  {
    key: "chart1",
    cssVar: "--chart-1",
    group: "chart",
    base: false,
    default: lit("oklch(0.646 0.222 41.116)", "oklch(0.488 0.243 264.376)"),
    vscode: ["charts.blue", "terminal.ansiBlue"],
  },
  {
    key: "chart2",
    cssVar: "--chart-2",
    group: "chart",
    base: false,
    default: lit("oklch(0.6 0.118 184.704)", "oklch(0.696 0.17 162.48)"),
    vscode: ["charts.green", "terminal.ansiGreen"],
  },
  {
    key: "chart3",
    cssVar: "--chart-3",
    group: "chart",
    base: false,
    default: lit("oklch(0.398 0.07 227.392)", "oklch(0.769 0.188 70.08)"),
    vscode: ["charts.orange", "terminal.ansiYellow"],
  },
  {
    key: "chart4",
    cssVar: "--chart-4",
    group: "chart",
    base: false,
    default: lit("oklch(0.828 0.189 84.429)", "oklch(0.627 0.265 303.9)"),
    vscode: ["charts.purple", "terminal.ansiMagenta"],
  },
  {
    key: "chart5",
    cssVar: "--chart-5",
    group: "chart",
    base: false,
    default: lit("oklch(0.769 0.188 70.08)", "oklch(0.645 0.246 16.439)"),
    vscode: ["charts.red", "terminal.ansiRed"],
  },

  // ----- workflow node categories. CSS prefix is `--wf-`, not `--workflow-`. -----
  {
    key: "workflowTrigger",
    cssVar: "--wf-trigger",
    group: "workflowNode",
    base: false,
    default: lit("oklch(0.62 0.17 145)", "oklch(0.72 0.18 150)"),
  },
  {
    key: "workflowAction",
    cssVar: "--wf-action",
    group: "workflowNode",
    base: false,
    default: lit("oklch(0.6 0.13 220)", "oklch(0.7 0.15 220)"),
  },
  {
    key: "workflowAi",
    cssVar: "--wf-ai",
    group: "workflowNode",
    base: false,
    default: lit("oklch(0.55 0.22 295)", "oklch(0.7 0.22 295)"),
  },
  {
    key: "workflowFlow",
    cssVar: "--wf-flow",
    group: "workflowNode",
    base: false,
    default: lit("oklch(0.7 0.17 65)", "oklch(0.78 0.17 70)"),
  },
  {
    key: "workflowData",
    cssVar: "--wf-data",
    group: "workflowNode",
    base: false,
    default: lit("oklch(0.6 0.22 12)", "oklch(0.7 0.22 12)"),
  },
  {
    key: "workflowIo",
    cssVar: "--wf-io",
    group: "workflowNode",
    base: false,
    default: lit("oklch(0.6 0.13 195)", "oklch(0.72 0.13 195)"),
  },
  {
    key: "workflowAnnotation",
    cssVar: "--wf-annotation",
    group: "workflowNode",
    base: false,
    default: lit("oklch(0.55 0.02 270)", "oklch(0.7 0.02 270)"),
  },

  // ----- workflow statuses. Four of the six alias a status colour. -----
  {
    key: "workflowStatusIdle",
    cssVar: "--wf-status-idle",
    group: "workflowState",
    base: false,
    default: lit("oklch(0.55 0.02 270)", "oklch(0.7 0.02 270)"),
  },
  {
    key: "workflowStatusRunning",
    cssVar: "--wf-status-running",
    group: "workflowState",
    base: false,
    default: { kind: "alias", from: "warning" },
  },
  {
    key: "workflowStatusSucceeded",
    cssVar: "--wf-status-succeeded",
    group: "workflowState",
    base: false,
    default: { kind: "alias", from: "success" },
  },
  {
    key: "workflowStatusFailed",
    cssVar: "--wf-status-failed",
    group: "workflowState",
    base: false,
    default: { kind: "alias", from: "destructive" },
  },
  {
    key: "workflowStatusSkipped",
    cssVar: "--wf-status-skipped",
    group: "workflowState",
    base: false,
    default: lit("oklch(0.6 0.02 270)", "oklch(0.55 0.02 270)"),
  },
  {
    key: "workflowStatusWaiting",
    cssVar: "--wf-status-waiting",
    group: "workflowState",
    base: false,
    default: { kind: "alias", from: "workflowAction" },
  },

  // ----- product accent -----
  {
    key: "effortUltra",
    cssVar: "--effort-ultra",
    group: "productAccent",
    base: false,
    default: lit("oklch(0.53 0.23 293)", "oklch(0.72 0.19 296)"),
  },
  {
    key: "effortUltraMuted",
    cssVar: "--effort-ultra-muted",
    group: "productAccent",
    base: false,
    default: { kind: "alpha", from: "effortUltra", light: 0.22, dark: 0.26 },
  },
]

// ----------------------------------------------------------------------------
// Derived views
// ----------------------------------------------------------------------------

export const THEME_TOKEN_BY_KEY: Readonly<Record<ThemeTokenKey, ThemeTokenDef>> =
  Object.fromEntries(THEME_TOKEN_CATALOG.map((def) => [def.key, def])) as Record<
    ThemeTokenKey,
    ThemeTokenDef
  >

/** Every token key, in UI order. The 27 required ones first. */
export const THEME_COLOR_KEYS: readonly ThemeTokenKey[] = THEME_TOKEN_CATALOG.map((d) => d.key)

/** The 27 keys `ThemeColors` requires — always materialised when a theme saves. */
export const BASE_THEME_COLOR_KEYS: readonly ThemeTokenKey[] = THEME_TOKEN_CATALOG.filter(
  (d) => d.base
).map((d) => d.key)

/**
 * The 29 optional keys. Saved sparsely: a theme records one only when the user
 * set it, which is what lets an untouched derived token keep tracking its
 * source across edits.
 */
export const ADVANCED_THEME_COLOR_KEYS: readonly ThemeTokenKey[] = THEME_TOKEN_CATALOG.filter(
  (d) => !d.base
).map((d) => d.key)

/** Every CSS custom property a theme owns — the applier's write and clear list. */
export const THEME_TOKEN_CSS_VARS: readonly string[] = THEME_TOKEN_CATALOG.map((d) => d.cssVar)

/** Tokens per editor group, in catalog order. */
export const THEME_TOKEN_GROUPS: ReadonlyArray<{
  key: ThemeTokenGroupKey
  tokens: readonly ThemeTokenKey[]
}> = THEME_TOKEN_GROUP_KEYS.map((group) => ({
  key: group,
  tokens: THEME_TOKEN_CATALOG.filter((d) => d.group === group).map((d) => d.key),
}))

/**
 * The CSS custom property a token writes to.
 *
 * Unknown keys fall back to camel→kebab so callers holding a raw string (a
 * plugin's `cssVariables` map, an imported JSON) still resolve sensibly.
 */
export function themeTokenCssVar(key: ThemeTokenKey | string): string {
  const def = THEME_TOKEN_BY_KEY[key as ThemeTokenKey]
  if (def) return def.cssVar
  // Anchor on the captured lowercase char so a leading uppercase never yields `---x`.
  return `--${key.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`
}

// ----------------------------------------------------------------------------
// Defaults
// ----------------------------------------------------------------------------

/** `percent`% of `from` mixed into `into`, in oklab — what CSS `color-mix(in oklab, …)` does. */
function mixOklab(from: string, into: string, percent: number): string {
  try {
    const a = parse(into)
    const b = parse(from)
    if (!a || !b) return from
    const mixed = interpolate([a, b], "oklab")(percent / 100)
    return formatCss(mixed) ?? from
  } catch {
    return from
  }
}

/** `source` at `alpha` opacity, preserving hue and chroma. */
function withAlpha(source: string, alpha: number): string {
  try {
    const parsed = parse(source)
    if (!parsed) return source
    const oklch = toOklch(parsed)
    if (!oklch) return source
    return formatCss({ ...oklch, alpha }) ?? source
  } catch {
    return source
  }
}

function resolveDerived(
  def: ThemeTokenDef,
  variant: "light" | "dark",
  resolved: Partial<Record<ThemeTokenKey, string>>
): string {
  const d = def.default
  switch (d.kind) {
    case "literal":
      return d[variant]
    case "alias":
      return resolved[d.from] ?? ""
    case "alpha":
      return withAlpha(resolved[d.from] ?? "", d[variant])
    case "mix":
      return mixOklab(resolved[d.from] ?? "", resolved[d.into] ?? "", d.percent)
  }
}

/**
 * Fill a partial palette out to all 56 tokens.
 *
 * This is the whole of "old 27-token themes keep working": nothing is migrated
 * on disk, the gaps are closed on read. Two passes, because the derived tokens
 * read the *resolved* values of their sources — so a theme that recoloured
 * `warning` gets a matching `workflowStatusRunning` without ever having stored
 * one, while a theme that set `workflowStatusRunning` explicitly keeps it.
 */
export function normalizeThemeColors(
  partial: Partial<ThemeColors> | undefined,
  variant: "light" | "dark"
): ResolvedThemeColors {
  const src = partial ?? {}
  const out: Partial<Record<ThemeTokenKey, string>> = {}

  // Pass 1 — explicit values and flat defaults.
  for (const def of THEME_TOKEN_CATALOG) {
    const given = src[def.key]
    if (typeof given === "string" && given.trim().length > 0) {
      out[def.key] = given
    } else if (def.default.kind === "literal") {
      out[def.key] = def.default[variant]
    }
  }

  // Pass 2 — derivations, over the values pass 1 settled on.
  for (const def of THEME_TOKEN_CATALOG) {
    if (out[def.key] !== undefined) continue
    const value = resolveDerived(def, variant, out)
    out[def.key] = value.length > 0 ? value : ""
  }

  return out as ResolvedThemeColors
}

/**
 * The default palette for a variant — what a brand-new theme starts from, and
 * what `globals.css` paints when no theme is active.
 */
export function defaultThemeColors(variant: "light" | "dark"): ResolvedThemeColors {
  return normalizeThemeColors({}, variant)
}

/**
 * Keep only the keys the catalog knows about. Guards the import path: a theme
 * JSON is user-supplied, and an unknown key would otherwise ride straight into
 * a `style.setProperty` call.
 */
export function pickKnownTokens(input: Record<string, unknown>): Partial<ThemeColors> {
  const out: Partial<ThemeColors> = {}
  for (const def of THEME_TOKEN_CATALOG) {
    const value = input[def.key]
    if (typeof value === "string" && value.trim().length > 0) {
      out[def.key] = value.trim()
    }
  }
  return out
}
