// Appearance customization types: wallpapers, background scopes, VSCode-import
// records, and custom-CSS state. These piggy-back on `AppSettings` (Dexie
// `settings` singleton) — no separate table — so the whole appearance config
// rides along with the existing backup/restore pipeline.

export * from "./cursor"
export * from "./style-pack"
import { DEFAULT_CURSOR, type CursorSettings } from "./cursor"
// Value import; `style-pack.ts` only imports `DensityLevel` back as a type, so
// the cycle is erased at compile time and never exists at runtime.
import { DEFAULT_STYLE_PACK, type StylePackSettings } from "./style-pack"

/**
 * How the wallpaper raster is fitted into its surface.
 *
 * - `cover`   — fill the surface, cropping whatever overflows (default)
 * - `contain` — fit entirely inside, letterboxing whatever is left
 * - `fill`    — stretch both axes to the surface, ignoring aspect ratio
 * - `center`  — draw at natural size, no scaling
 * - `tile`    — draw at natural size and repeat
 *
 * `cover` / `contain` / `center` honour {@link BackgroundSettings.focalX} /
 * `focalY`; `fill` and `tile` leave no freedom to anchor, so they ignore it.
 */
export type WallpaperPosition = "cover" | "contain" | "fill" | "tile" | "center"

/** User-CSS injection scope: limited to the app shell (`#app`) or document-wide. */
export type CustomCssScope = "app" | "global"

export type BackgroundScope = "all" | "global" | "chat" | "canvas" | "sidebar"

export interface BackgroundSettings {
  enabled: boolean
  /** Points to {@link Wallpaper.id} in `AppSettings.wallpapers`. Null = no active wallpaper. */
  activeId: string | null
  scope: BackgroundScope
  /** 0..32 px. Applied as `filter: blur(Npx)` on the body::before pseudo. */
  blurPx: number
  /** 0..1. Applied as `opacity: N` on the body::before pseudo. */
  opacity: number
  position: WallpaperPosition
  /**
   * Horizontal anchor, 0..100 (%). Decides which part of an over-wide image
   * survives a `cover` crop — the subject of a photo is rarely dead centre.
   * Optional so settings rows written before this field keep loading; the
   * applier and the UI both fall back to 50.
   */
  focalX?: number
  /** Vertical anchor, 0..100 (%). See {@link BackgroundSettings.focalX}. */
  focalY?: number
}

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  enabled: false,
  activeId: null,
  scope: "all",
  blurPx: 0,
  opacity: 1,
  position: "cover",
  focalX: 50,
  focalY: 50,
}

/** Discriminated union — exactly one of these shapes per wallpaper. */
export type WallpaperSource =
  | {
      kind: "image"
      storage: "disk"
      /** Relative path under `<appData>/cognia/wallpapers/`. */
      relPath: string
      mime: string
      width: number
      height: number
    }
  | {
      kind: "image"
      storage: "indexeddb"
      /** Key into the IndexedDB Blob store. */
      blobKey: string
      mime: string
      width: number
      height: number
    }
  | {
      kind: "image"
      storage: "data-url"
      /** Inline data URL — used for built-in image presets shipped with the app. */
      dataUrl: string
      mime: string
      width: number
      height: number
    }
  | {
      kind: "gradient"
      /** Raw CSS gradient string, e.g. "linear-gradient(135deg, #ff7e5f, #feb47b)". */
      css: string
    }
  | {
      kind: "color"
      /** CSS color value, e.g. "#1e293b" or "oklch(0.5 0.1 30)". */
      value: string
    }

export interface Wallpaper {
  id: string
  name: string
  /** Top-level kind — duplicates `source.kind` for fast filtering in the gallery. */
  kind: "image" | "gradient" | "color"
  source: WallpaperSource
  /** Cannot be deleted; rendered first in the gallery. */
  builtin: boolean
  createdAt: number
}

/**
 * One row per VSCode theme imported. The actual color tokens live in
 * `AppSettings.customThemes`; this record just remembers where a custom theme
 * came from so the UI can show provenance and offer "remove" / "re-import".
 */
export interface ImportedThemeRecord {
  /** Foreign key into `AppSettings.customThemes[].id`. */
  customThemeId: string
  /**
   * Deterministic identity for the source: `json:<fileName>:<themeName>` or
   * `vsix:<vsixName>:<themePath>`. Used to dedupe re-imports of the same
   * .vsix or .json file so the history list doesn't grow N copies of the
   * same theme. Optional for back-compat with rows written before this
   * field existed; the import flow always populates it now.
   */
  sourceKey?: string
  /** Human-readable name from the VSCode theme `label`. */
  sourceName: string
  /** Whether the imported theme targets light or dark UI. */
  sourceVariant: "light" | "dark"
  importedAt: number
  origin: { kind: "json"; fileName: string } | { kind: "vsix"; vsixName: string; themePath: string }
}

/**
 * Compute a deterministic identity for an imported theme. Re-importing the
 * same .json file or selecting the same theme path inside the same .vsix
 * yields the same key, so the import flow can update the existing record
 * in place instead of producing duplicates.
 */
export function importedThemeSourceKey(
  origin: ImportedThemeRecord["origin"],
  sourceName: string
): string {
  if (origin.kind === "json") return `json:${origin.fileName}:${sourceName}`
  return `vsix:${origin.vsixName}:${origin.themePath}`
}

/**
 * Bundle of every appearance-related slice. `AppSettings` spreads these in
 * directly so a single Dexie write persists the whole config.
 */
export interface AppearanceSettingsSlice {
  background?: BackgroundSettings
  wallpapers?: Wallpaper[]
  /** User-supplied global CSS, applied via a `<style id="cognia-user-css">` tag. */
  customCss?: string
  customCssEnabled?: boolean
  importedVscodeThemes?: ImportedThemeRecord[]
  // v47 additions (appearance optimization plan)
  density?: DensitySettings
  radius?: RadiusSettings
  motion?: MotionSettings
  /** Agent invocation-flow display mode (simplified / standard / detailed). */
  agentFlowMode?: AgentFlowSettings
  /** Unified chat-message presentation preferences. */
  messageDisplay?: MessageDisplayPreferences
  /** Usage / consumption statistics display mode (simplified / standard / detailed). */
  usageDisplayMode?: UsageDisplaySettings
  typographyExt?: TypographyExtSettings
  a11y?: A11ySettings
  autoMode?: AutoModeSettings
  monacoLink?: MonacoLinkSettings
  /** Active theme-pack id (from plugin manifest.themePacks). null when nothing applied. */
  activeThemePackId?: string | null
  /** Whether `customCss` is wrapped in `@scope (#app) { ... }` (default) or applied globally. */
  customCssScope?: CustomCssScope
  /** Per-component surface customization (tonality / elevation / radius). */
  componentStyles?: ComponentStyles
  /** Mouse-pointer art + pointer effect layer. See `./cursor.ts`. */
  cursor?: CursorSettings
  /**
   * The "shape" half of appearance — radius, pill shape, elevation ceiling,
   * border tone, density, micro-label treatment (ADR-0148). Orthogonal to the
   * colour half: any pack composes with any theme. See `./style-pack.ts`.
   */
  stylePack?: StylePackSettings
}

// ----------------------------------------------------------------------------
// Per-component surface customization
//
// Lets the user tune individual shadcn surface components (Card, Dialog,
// Popover, Sidebar, …) on three axes:
//   - tonality   — how opaque the surface is over an active wallpaper. Reuses
//                  the `--surface-tonality-*` / `--surface-blur-*` token tiers
//                  the wallpaper-aware layer in globals.css already defines.
//                  Only has a visible effect while a wallpaper is enabled.
//   - elevation  — drop-shadow depth. Mirrors the `[data-elevation]` scale.
//                  Applies regardless of wallpaper.
//   - radiusScale — multiplier on the base `--radius`. Applies regardless of
//                  wallpaper.
//
// The `ComponentStyleApplier` projects these into a single injected
// `<style id="cognia-component-styles">`, keyed off each component's
// `data-slot` attribute, so re-installing a primitive from the shadcn
// registry never breaks the integration.
// ----------------------------------------------------------------------------

/** `"default"` means "no override — inherit the built-in behaviour". */
export type ComponentTonality = "default" | "solid" | "translucent" | "glass" | "frosted"

/** `"default"` means "no override". `"0"`..`"3"` mirror the `[data-elevation]` scale. */
export type ComponentElevation = "default" | "0" | "1" | "2" | "3"

/** Stable keys for the curated set of customizable surface components. */
export type ComponentStyleKey =
  | "card"
  | "alert"
  | "tabs"
  | "menubar"
  | "sidebar"
  | "table"
  | "popover"
  | "dropdownMenu"
  | "contextMenu"
  | "select"
  | "combobox"
  | "hoverCard"
  | "command"
  | "navigationMenu"
  | "tooltip"
  | "dialog"
  | "alertDialog"
  | "sheet"
  | "drawer"
  // ── ai-elements chat surfaces ─────────────────────────────────────────────
  | "aiMessage"
  | "aiTool"
  | "aiArtifact"
  | "aiCodeBlock"
  | "aiContext"
  | "aiTask"
  | "aiErrorTrace"
  | "aiConversation"
  | "aiTerminal"

export interface ComponentStyleOverride {
  tonality?: ComponentTonality
  elevation?: ComponentElevation
  /** Multiplier on `--radius`, clamped to 0.5..2. `undefined`/`1` = inherit. */
  radiusScale?: number
}

export type ComponentStyles = Partial<Record<ComponentStyleKey, ComponentStyleOverride>>

// ----------------------------------------------------------------------------
// v47 — Density / Radius / Motion / Typography / A11y / AutoMode / MonacoLink
// ----------------------------------------------------------------------------

export type DensityLevel = "compact" | "comfortable" | "spacious"

export interface DensitySettings {
  /** Applies to every `[data-surface]` unless an override below is set. */
  global: DensityLevel
  chat?: DensityLevel
  table?: DensityLevel
  sidebar?: DensityLevel
}

export const DEFAULT_DENSITY: DensitySettings = { global: "comfortable" }

export interface RadiusSettings {
  /** Base radius in rem, mapped to `--radius` at runtime. Clamped to 0..1.5. */
  base: number
}

export const DEFAULT_RADIUS: RadiusSettings = { base: 0.625 }

export type MotionSpeed = 0.5 | 1 | 1.5

export interface MotionSettings {
  /** Multiplier on `--motion-duration-scale`. 1 = unchanged. */
  speed: MotionSpeed
  /** When true, all transitions/animations collapse to ~0.01ms. */
  reduce: boolean
}

export const DEFAULT_MOTION: MotionSettings = { speed: 1, reduce: false }

export interface TypographyExtSettings {
  /** Family resolved against `fontRegistry`; falls back to `--font-geist-sans`. */
  fontFamily?: string
  monoFamily?: string
  serifFamily?: string
  /** 0.875..1.25 — multiplier on `line-height`. */
  lineHeightScale: number
  /** -0.02..0.02 em — added to `letter-spacing`. */
  letterSpacingEm: number
}

export const DEFAULT_TYPOGRAPHY_EXT: TypographyExtSettings = {
  lineHeightScale: 1,
  letterSpacingEm: 0,
}

export type WcagTarget = "off" | "AA" | "AAA"
export type WcagEnforcement = "warn" | "warn+fix"
export type HighContrastMode = "off" | "light" | "dark"
export type ColorblindMode = "off" | "deuter" | "protan" | "tritan"

export interface A11ySettings {
  wcagTarget: WcagTarget
  enforcement: WcagEnforcement
  highContrast: HighContrastMode
  colorblindMode: ColorblindMode
}

export const DEFAULT_A11Y: A11ySettings = {
  wcagTarget: "AA",
  enforcement: "warn+fix",
  highContrast: "off",
  colorblindMode: "off",
}

export type AutoModeTrigger = "system" | "schedule" | "sunset"

export interface AutoModeLocation {
  latitude: number
  longitude: number
  source: "manual" | "os"
}

export interface AutoModeSettings {
  enabled: boolean
  trigger: AutoModeTrigger
  /** Active custom-theme id (or color preset key) chosen for light phase. */
  lightThemeId?: string
  darkThemeId?: string
  /** Schedule mode thresholds in 24h `HH:mm` form. */
  schedule?: { lightAt: string; darkAt: string }
  location?: AutoModeLocation
  /** Skip auto-switches for this many ms after a manual change. Default 30 min. */
  snoozeMs?: number
  /** Epoch-ms of the most recent manual mode change, set by the runner. */
  lastManualAt?: number
}

export const DEFAULT_AUTOMODE: AutoModeSettings = {
  enabled: false,
  trigger: "system",
  snoozeMs: 30 * 60 * 1000,
}

export interface MonacoLinkSettings {
  /** When true, app-theme drives Monaco/Canvas; false keeps Canvas standalone. */
  enabled: boolean
  /** Override id pinning Monaco to a specific theme regardless of app theme. */
  lockedThemeId?: string
}

export const DEFAULT_MONACO_LINK: MonacoLinkSettings = { enabled: true }

// ----------------------------------------------------------------------------
// Agent invocation-flow display mode
//
// Controls how the chat renders an assistant turn's tool calls, reasoning, and
// sub-agent steps. Distinct from `density` (which only tunes spacing): this
// changes the *information density / verbosity* of the agent-flow surfaces.
//   - simplified — one-line tool summaries (icon + name + target + status),
//                  expandable on click; reasoning + sub-agents stay collapsed.
//   - standard   — the current card-based view (cards open while running,
//                  collapse on completion).
//   - detailed   — every card expanded with full input/output + extra metadata
//                  (tokens, duration); reasoning + sub-agent trees expanded.
// ----------------------------------------------------------------------------

export type AgentFlowMode = "simplified" | "standard" | "detailed"

export interface AgentFlowSettings {
  mode: AgentFlowMode
}

export const DEFAULT_AGENT_FLOW: AgentFlowSettings = { mode: "standard" }

/** Ordered list for cycling/segmented controls. */
export const AGENT_FLOW_MODES: readonly AgentFlowMode[] = ["simplified", "standard", "detailed"]

/** Narrow an arbitrary string to a valid {@link AgentFlowMode}. */
export function isAgentFlowMode(value: unknown): value is AgentFlowMode {
  return value === "simplified" || value === "standard" || value === "detailed"
}

export type MessageDisplayPreset = "focused" | "balanced" | "inspector"
export type MessageDisplayLayout = "hybrid" | "bubbles" | "cards"
export type MessageMetadataPlacement = "hidden" | "header" | "details"
export type MessageActionVisibility = "hover" | "core" | "all"
export type MessagePartVisibility = "hidden" | "collapsed" | "auto" | "expanded"
export type MessageRichControls = "hidden" | "hover" | "always"
export type MessageMotion = "off" | "restrained" | "expressive"

export interface MessageDisplayMetadataOptions {
  identity: MessageMetadataPlacement
  timestamp: MessageMetadataPlacement
  model: MessageMetadataPlacement
  provider: MessageMetadataPlacement
  duration: MessageMetadataPlacement
  usage: MessageMetadataPlacement
  cost: MessageMetadataPlacement
  finishState: MessageMetadataPlacement
}

/** Body-copy font family for message prose (ADR-0127). `serif` reads `--font-serif`. */
export type MessageBodyFont = "sans" | "serif"
export type MessageMathFontScale = 0.8 | 1 | 1.2
export type MessageMathAlign = "center" | "left"

/**
 * Markdown / code / math rendering knobs (ADR-0127). These used to be renderer
 * props with hard defaults and no setting; every field is optional at the
 * preference layer and fully resolved by `resolveMessageDisplayOptions`.
 * Both the streaming (Streamdown) and finalized (react-markdown) branches
 * consume the same resolved object.
 */
export interface MessageMarkdownOptions {
  /** Render `$…$` / `$$…$$` math with KaTeX; off ⇒ shown as plain code. */
  math: boolean
  /** Render ```mermaid fences as diagrams; off ⇒ shown as a code block. */
  mermaid: boolean
  /** Render ```diff fences with the diff viewer; off ⇒ plain code block. */
  diff: boolean
  /** Default for the code-block line-number gutter (per-block toolbar can still toggle). */
  codeLineNumbers: boolean
  /** Default for code-block soft wrapping (per-block toolbar can still toggle). */
  codeWrap: boolean
  mathFontScale: MessageMathFontScale
  mathAlign: MessageMathAlign
  /** Show the copy affordance on inline math. */
  mathCopy: boolean
}

export interface MessageDisplayOverrides {
  layout?: MessageDisplayLayout
  metadata?: Partial<MessageDisplayMetadataOptions>
  actions?: MessageActionVisibility
  agentFlowMode?: AgentFlowMode
  reasoning?: MessagePartVisibility
  tools?: MessagePartVisibility
  sources?: MessagePartVisibility
  richControls?: MessageRichControls
  motion?: MessageMotion
  markdown?: Partial<MessageMarkdownOptions>
  bodyFont?: MessageBodyFont
}

export const MESSAGE_MATH_FONT_SCALES: readonly MessageMathFontScale[] = [0.8, 1, 1.2]

export function isMessageBodyFont(value: unknown): value is MessageBodyFont {
  return value === "sans" || value === "serif"
}
export function isMessageMathFontScale(value: unknown): value is MessageMathFontScale {
  return value === 0.8 || value === 1 || value === 1.2
}
export function isMessageMathAlign(value: unknown): value is MessageMathAlign {
  return value === "center" || value === "left"
}

export interface MessageDisplayPreferences {
  preset: MessageDisplayPreset
  overrides?: MessageDisplayOverrides
}

// ----------------------------------------------------------------------------
// Usage / consumption statistics display mode
//
// Controls the information density of the usage & consumption surfaces (the
// Subscription → Usage dashboard, the composer context read-out, the agent-team
// runtime tile, and the mobile today-stats card). Progressive density, mirroring
// {@link AgentFlowMode}:
//   - simplified — headline stat tiles + current-window gauges only; charts and
//                  tables collapse to a summary.
//   - standard   — the full dashboard (charts + model/session tables).
//   - detailed   — everything expanded, with extra columns (cache-write tokens,
//                  per-session detail) and the raw snapshot table open.
// ----------------------------------------------------------------------------

export type UsageDisplayMode = "simplified" | "standard" | "detailed"

export interface UsageDisplaySettings {
  mode: UsageDisplayMode
}

export const DEFAULT_USAGE_DISPLAY: UsageDisplaySettings = { mode: "standard" }

/** Ordered list for cycling/segmented controls. */
export const USAGE_DISPLAY_MODES: readonly UsageDisplayMode[] = [
  "simplified",
  "standard",
  "detailed",
]

/** Narrow an arbitrary string to a valid {@link UsageDisplayMode}. */
export function isUsageDisplayMode(value: unknown): value is UsageDisplayMode {
  return value === "simplified" || value === "standard" || value === "detailed"
}

/**
 * The single default source for the appearance-owned settings keys.
 *
 * `lib/db/settings.ts` spreads this object into canonical `DEFAULTS` (minus
 * `agentFlowMode`, the legacy read-only fallback that must stay `undefined` so
 * it never overrides a preset — ADR-0114 / ADR-0127), which is what makes
 * every key here visible to per-section reset, the changed-settings review,
 * and profile transfer. `messageDisplay: { preset: "balanced" }` resolves to
 * `DEFAULT_MESSAGE_DISPLAY_OPTIONS` in `lib/chat/message-display.ts`; the
 * resolver's test pins that equivalence.
 */
export const DEFAULT_APPEARANCE_SLICE: Required<AppearanceSettingsSlice> = {
  background: DEFAULT_BACKGROUND_SETTINGS,
  wallpapers: [],
  customCss: "",
  customCssEnabled: false,
  importedVscodeThemes: [],
  density: DEFAULT_DENSITY,
  radius: DEFAULT_RADIUS,
  motion: DEFAULT_MOTION,
  agentFlowMode: DEFAULT_AGENT_FLOW,
  messageDisplay: { preset: "balanced" },
  usageDisplayMode: DEFAULT_USAGE_DISPLAY,
  typographyExt: DEFAULT_TYPOGRAPHY_EXT,
  a11y: DEFAULT_A11Y,
  autoMode: DEFAULT_AUTOMODE,
  monacoLink: DEFAULT_MONACO_LINK,
  activeThemePackId: null,
  customCssScope: "app",
  componentStyles: {},
  cursor: DEFAULT_CURSOR,
  stylePack: DEFAULT_STYLE_PACK,
}
