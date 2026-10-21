// Mouse-cursor customization types.
//
// Like every other appearance slice these ride along on the `AppSettings`
// singleton (see `AppearanceSettingsSlice`) — no separate Dexie table — so the
// cursor config is captured by backup/restore and by the appearance
// export/import document for free.
//
// Two independent axes, deliberately kept separate in the model because users
// mix them freely:
//
//   1. The *pointer art* — which bitmap the OS/webview paints for each CSS
//      cursor role. Driven by a `CursorPack` (a silhouette shape + a palette).
//   2. The *pointer effect* — the particle/trail layer drawn on a canvas
//      overlay that follows the pointer. Purely decorative, never hit-testable.
//
// The art is applied through a single injected stylesheet; the effect through a
// single full-viewport `<canvas>`. Neither is allowed to change layout, and
// both no-op on coarse-pointer (touch) devices where there is no cursor to
// decorate.

/**
 * CSS cursor roles a pack may override.
 *
 * A pack declares a *subset*: any role it leaves undeclared keeps the native
 * OS cursor rather than being synthesized. That is a designed behavior, not a
 * gap — a pack that has no meaningful "resize" idiom looks far better handing
 * that role back to the platform than wearing a stretched arrow.
 *
 * `default` is special: it is required of every pack (the applier validates
 * this) because it is the role the whole app falls back to.
 */
export const CURSOR_ROLES = [
  "default",
  "pointer",
  "text",
  "grab",
  "grabbing",
  "notAllowed",
  "progress",
  "crosshair",
] as const

export type CursorRole = (typeof CURSOR_ROLES)[number]

/** The CSS `cursor` keyword each role overrides, used to build the selectors. */
export const CURSOR_ROLE_CSS_KEYWORD: Record<CursorRole, string> = {
  default: "default",
  pointer: "pointer",
  text: "text",
  grab: "grab",
  grabbing: "grabbing",
  notAllowed: "not-allowed",
  progress: "progress",
  crosshair: "crosshair",
}

/**
 * Silhouette families. The shape owns the geometry of the `default` arrow (and
 * the "interactive" accent mark); every other role is composed generically from
 * the shape + palette by `lib/appearance/cursor/cursor-art.ts`, which is why a
 * new pack costs one path string rather than eight hand-drawn cursors.
 */
export const CURSOR_SHAPES = [
  "arrow",
  "graphite",
  "pixel",
  "neon",
  "ink",
  "petal",
  "wand",
  "paw",
  "reticle",
  "blade",
] as const

export type CursorShapeId = (typeof CURSOR_SHAPES)[number]

/**
 * The four colors a pack paints with. Kept tiny on purpose: a cursor is a
 * ~24px glyph that has to stay legible over any wallpaper, so the art uses a
 * body fill, a contrasting outline, one accent for interactive affordances,
 * and an optional glow.
 */
export interface CursorPalette {
  /** Body fill of the silhouette. */
  fill: string
  /** Outline — this is what keeps the cursor visible on same-colored surfaces. */
  stroke: string
  /** Interactive accent: the pointer-role ring, the text caps, the wand star. */
  accent: string
  /** Optional outer glow (a blurred halo). Omit for flat packs. */
  glow?: string
}

/** Grouping used by the picker so the anime packs read as a set. */
export type CursorPackFamily = "system" | "classic" | "playful" | "anime"

export interface CursorPack {
  id: string
  /**
   * Display name. Built-in packs are NOT translated — they are proper names
   * (like the built-in themes "Nord" / "Gruvbox"), so they read the same in
   * every locale. The family label above them is translated.
   */
  name: string
  family: CursorPackFamily
  shape: CursorShapeId
  /** Palette used when `colorMode` is `"pack"`. */
  palette: CursorPalette
  /**
   * Roles this pack paints. Ordering is irrelevant; `"default"` must be
   * present. Roles omitted here keep the native cursor.
   */
  roles: readonly CursorRole[]
}

/**
 * Where the cursor art takes its colors from.
 *  - `pack`   — the pack's own palette (the designed look).
 *  - `accent` — re-tint the pack with the live theme accent, so the cursor
 *               follows the active theme/preset. Outline and glow are derived.
 *  - `custom` — re-tint with `customColor`.
 */
export type CursorColorMode = "pack" | "accent" | "custom"

/** Smallest / largest cursor scale multiplier the settings UI offers. */
export const CURSOR_SIZE_MIN = 0.75
export const CURSOR_SIZE_MAX = 2.5

/**
 * Particle/trail effects drawn on the overlay canvas.
 *
 * The catalogue mirrors what the established web cursor-effect libraries have
 * converged on (trail, ribbon, glow, ripple, sparkle, bubbles, snow, flame)
 * plus the two anime staples (falling sakura petals, a star-dust magic trail).
 */
export const CURSOR_EFFECT_KINDS = [
  "none",
  "trail",
  "ribbon",
  "glow",
  "ripple",
  "sparkle",
  "bubbles",
  "snow",
  "flame",
  "petals",
  "stardust",
] as const

export type CursorEffectKind = (typeof CURSOR_EFFECT_KINDS)[number]

/** Where a particle effect takes its color from — same idea as the art. */
export type CursorEffectColorMode = "accent" | "pack" | "custom" | "rainbow"

export interface CursorEffectSettings {
  kind: CursorEffectKind
  /** 0..1 — scales spawn rate and the live-particle cap. */
  intensity: number
  /** 0.5..2 — multiplier on each particle's base radius. */
  scale: number
  colorMode: CursorEffectColorMode
  /** Used when `colorMode` is `"custom"`. */
  customColor?: string
  /** Emit a one-shot burst on pointer-down in addition to the motion trail. */
  clickBurst: boolean
}

export const DEFAULT_CURSOR_EFFECT: CursorEffectSettings = {
  kind: "none",
  intensity: 0.5,
  scale: 1,
  colorMode: "accent",
  clickBurst: true,
}

export interface CursorSettings {
  /**
   * Master switch for the *art*. When false the OS cursor is used verbatim —
   * the stylesheet is removed entirely rather than being written with
   * `cursor: auto`, so nothing of ours can interfere with a native cursor
   * theme. The effect layer has its own switch (`effect.kind === "none"`).
   */
  enabled: boolean
  /** {@link CursorPack.id}. `SYSTEM_CURSOR_PACK_ID` means "don't override". */
  packId: string
  /** Multiplier on the 24px base art size. Clamped to CURSOR_SIZE_MIN..MAX. */
  size: number
  colorMode: CursorColorMode
  /** Used when `colorMode` is `"custom"`. */
  customColor?: string
  effect: CursorEffectSettings
}

/** Sentinel pack id meaning "keep the operating system's own cursor". */
export const SYSTEM_CURSOR_PACK_ID = "system"

export const DEFAULT_CURSOR: CursorSettings = {
  enabled: false,
  packId: SYSTEM_CURSOR_PACK_ID,
  size: 1,
  colorMode: "pack",
  effect: DEFAULT_CURSOR_EFFECT,
}

/** Narrow an arbitrary value to a known {@link CursorEffectKind}. */
export function isCursorEffectKind(value: unknown): value is CursorEffectKind {
  return (CURSOR_EFFECT_KINDS as readonly unknown[]).includes(value)
}

/** Narrow an arbitrary value to a known {@link CursorRole}. */
export function isCursorRole(value: unknown): value is CursorRole {
  return (CURSOR_ROLES as readonly unknown[]).includes(value)
}
