export type ComposerSkinId = (typeof COMPOSER_SKIN_IDS)[number]

/**
 * Where the status toolbar sits, and how much of its roster is spelled out.
 *
 *  - `detached`  — below the box (today's wide desktop layout)
 *  - `embedded`  — inside the box, tail packed into "⋯"
 *  - `rail`      — inside the box as a quiet monospace status line
 *  - `expanded`  — inline, every chip labelled, plus an ambient cost/context rail
 *  - `folded`    — only the model glyph inline; everything else behind "⋯"
 */
export type ComposerToolbarLayout = "detached" | "embedded" | "rail" | "expanded" | "folded"

/** Shape of the send/stop control. */
export type ComposerSendShape = "circle" | "rounded"

/** User overrides layered on top of the chosen preset. All optional. */
export interface ComposerSkinOverrides {
  radiusPx?: number
  padXPx?: number
  padYPx?: number
  mono?: boolean
  sendShape?: ComposerSendShape
  toolbarLayout?: ComposerToolbarLayout
}

export const COMPOSER_SKIN_IDS = ["classic", "airy", "dense", "full", "focus", "sharp"] as const

export const DEFAULT_COMPOSER_SKIN: ComposerSkinId = "classic"

export interface ComposerSkinTokens {
  /** Outer box corner radius, px. */
  radiusPx: number
  /** Horizontal / vertical padding of the box, px. */
  padXPx: number
  padYPx: number
  /** Gap between the box's clusters, px. */
  gapPx: number
  /** Edge length of the send button, px. */
  sendSizePx: number
  sendShape: ComposerSendShape
  /** Render the textarea in the monospace family. */
  mono: boolean
  toolbarLayout: ComposerToolbarLayout
}

export const COMPOSER_SKINS: Record<ComposerSkinId, ComposerSkinTokens> = {
  classic: {
    radiusPx: 16, // rounded-2xl
    padXPx: 8, // px-2
    padYPx: 8, // py-2
    gapPx: 8, // gap-2
    sendSizePx: 36, // size-9
    sendShape: "circle",
    mono: false,
    toolbarLayout: "detached",
  },
  airy: {
    radiusPx: 24,
    padXPx: 16,
    padYPx: 14,
    gapPx: 8,
    sendSizePx: 32,
    sendShape: "circle",
    mono: false,
    toolbarLayout: "embedded",
  },
  dense: {
    radiusPx: 10,
    padXPx: 8,
    padYPx: 7,
    gapPx: 8,
    sendSizePx: 26,
    sendShape: "rounded",
    mono: true,
    toolbarLayout: "rail",
  },
  full: {
    radiusPx: 14,
    padXPx: 12,
    padYPx: 11,
    gapPx: 6,
    sendSizePx: 30,
    sendShape: "rounded",
    mono: false,
    toolbarLayout: "expanded",
  },
  focus: {
    radiusPx: 20,
    padXPx: 15,
    padYPx: 13,
    gapPx: 7,
    sendSizePx: 30,
    sendShape: "circle",
    mono: false,
    toolbarLayout: "folded",
  },
  // The Sharp style pack's composer (ADR-0148). `classic` is preserved by
  // construction — it renders literal Tailwind and ignores overrides — so a
  // squared-off app would otherwise keep a `rounded-2xl` box with a circular
  // send button in the one place people look most. This is the pack's default,
  // not a forced choice: picking any other skin still wins.
  sharp: {
    radiusPx: 0,
    padXPx: 8,
    padYPx: 8,
    gapPx: 8,
    sendSizePx: 32,
    sendShape: "rounded",
    mono: true,
    toolbarLayout: "rail",
  },
}

export function toolbarSitsInBox(layout: ComposerToolbarLayout): boolean {
  return layout === "embedded" || layout === "rail" || layout === "folded"
}

export interface ComposerSkinSettings {
  skin?: ComposerSkinId
  skinOverrides?: ComposerSkinOverrides
  /** Legacy stacked-layout toggle. Honoured only under `classic` — see below. */
  compactLayout?: boolean
}

export interface ResolvedComposerSkin extends ComposerSkinTokens {
  id: ComposerSkinId
  /** Stacked layout at every width. */
  compactLayout: boolean
  /** True when the box should render its original literal classes. */
  isClassic: boolean
}

export const MOBILE_MIN_TOUCH_PX = 44

const MOBILE_MIN_PAD_PX = 10

const RADIUS_RANGE = [0, 32] as const

const PAD_RANGE = [2, 24] as const

function clamp(value: number, [min, max]: readonly [number, number]): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function isSkinId(value: unknown): value is ComposerSkinId {
  return typeof value === "string" && (COMPOSER_SKIN_IDS as readonly string[]).includes(value)
}

export function resolveComposerSkin(
  settings: ComposerSkinSettings | undefined,
  opts: { isMobile: boolean; packSkin?: ComposerSkinId }
): ResolvedComposerSkin {
  // The active style pack supplies the default; an explicit user choice still
  // wins (ADR-0148). `packSkin` is optional so every existing caller keeps
  // resolving to `classic` exactly as before.
  const fallback = isSkinId(opts.packSkin) ? opts.packSkin : DEFAULT_COMPOSER_SKIN
  const id = isSkinId(settings?.skin) ? settings.skin : fallback
  const preset = COMPOSER_SKINS[id]
  const isClassic = id === "classic"

  if (isClassic) {
    if (opts.isMobile) {
      // A phone gets classic's one-surface arrangement: the input on its own
      // full-width row, and the attach / voice cluster, the status toolbar and
      // send sharing ONE row inside the box. The detached desktop arrangement
      // left a 36px single-line input in a box of its own with a second, loose
      // toolbar row under it — two surfaces competing for a narrow screen. The
      // geometry is still classic's literals (the box's compact classes), and
      // the legacy toggle keeps its meaning on desktop.
      //
      // `embedded`, and the row itself decides how much it can hold: on a
      // phone (~160px beside the attach cluster and send) the fold ladder runs
      // out and the row switches to the `folded` arrangement; a tablet keeps
      // the fuller row. See `useFittedToolbar` in the composer toolbar.
      return { ...preset, id, isClassic: true, toolbarLayout: "embedded", compactLayout: true }
    }
    return {
      ...preset,
      id,
      isClassic: true,
      // The legacy stacked-layout toggle keeps working exactly as it did on
      // desktop.
      compactLayout: settings?.compactLayout === true,
    }
  }

  const o = settings?.skinOverrides ?? {}
  const radiusPx = clamp(o.radiusPx ?? preset.radiusPx, RADIUS_RANGE)
  let padXPx = clamp(o.padXPx ?? preset.padXPx, PAD_RANGE)
  let padYPx = clamp(o.padYPx ?? preset.padYPx, PAD_RANGE)
  let sendSizePx = preset.sendSizePx
  let toolbarLayout = o.toolbarLayout ?? preset.toolbarLayout

  if (opts.isMobile) {
    // Floors, not overrides: a skin that already exceeds them is left alone.
    sendSizePx = Math.max(sendSizePx, MOBILE_MIN_TOUCH_PX)
    padXPx = Math.max(padXPx, MOBILE_MIN_PAD_PX)
    padYPx = Math.max(padYPx, MOBILE_MIN_PAD_PX)
    // `expanded` lays every chip out inline with its label; a phone has no room
    // for that roster, so it degrades to the packing layout rather than
    // overflowing. Nothing is lost — the tail is reachable under "⋯".
    if (toolbarLayout === "expanded") toolbarLayout = "embedded"
    if (toolbarLayout === "detached") toolbarLayout = "embedded"
  }

  return {
    id,
    isClassic: false,
    radiusPx,
    padXPx,
    padYPx,
    gapPx: preset.gapPx,
    sendSizePx,
    sendShape: o.sendShape ?? preset.sendShape,
    mono: o.mono ?? preset.mono,
    toolbarLayout,
    // A toolbar INSIDE the box needs the box stacked: otherwise it shares one
    // flex line with the textarea and the chips paint over the input. The
    // legacy flag has no say here (see the dormancy note above) — this is
    // derived from where the skin put the row.
    compactLayout: toolbarSitsInBox(toolbarLayout),
  }
}

export function composerSkinVars(skin: ResolvedComposerSkin): Record<string, string> | undefined {
  if (skin.isClassic) return undefined
  return {
    "--composer-radius": `${skin.radiusPx}px`,
    "--composer-pad-x": `${skin.padXPx}px`,
    "--composer-pad-y": `${skin.padYPx}px`,
    "--composer-gap": `${skin.gapPx}px`,
    "--composer-send-size": `${skin.sendSizePx}px`,
    // Inner controls echo the outer curve rather than picking their own, so a
    // square-ish skin does not end up with pill chips inside a boxy shell.
    "--composer-inner-radius":
      skin.sendShape === "circle" ? "9999px" : `${Math.round(skin.radiusPx * 0.6)}px`,
  }
}

export const COMPACT_TOOLBAR_PX = 420

export function resolveToolbarLayout(
  proposed: ComposerToolbarLayout,
  toolbarWidth: number
): ComposerToolbarLayout {
  if (toolbarWidth <= 0 || toolbarWidth >= COMPACT_TOOLBAR_PX) return proposed
  // `detached` keeps its OWN narrow packing — the single-row fold ladder in
  // `bottom-toolbar.tsx`, which folds into "⋯" and never wraps to a second
  // row. Rewriting it to `embedded` here would move the row from below the box
  // to inside it the moment a pane narrowed, which is not what narrowing has
  // ever meant for the classic composer.
  if (proposed === "detached") return "detached"
  // `folded` is already the tightest arrangement — narrowing cannot improve it.
  if (proposed === "folded") return "folded"
  return "embedded"
}

export type ToolbarFoldTier = 0 | 1 | 2 | 3 | 4

export const TOOLBAR_FOLD_PX = {
  /** ≥ this width the full labelled roster fits without shaving. */
  labelled: 720,
  /** ≥ this width labels stay; ambient + plugin affordances fold. */
  packed: 520,
  /** ≥ this width per-turn chips go icon-only; mode + runtime name fold. */
  glyphs: 380,
  /** ≥ this width cost folds; below it the context ring stands alone. */
  tight: 300,
} as const

export function resolveToolbarFoldTier(toolbarWidth: number): ToolbarFoldTier {
  // `0` means "not measured yet" — render the widest form rather than
  // flashing a packed row on first paint (same rule as the layout resolver).
  if (toolbarWidth <= 0 || toolbarWidth >= TOOLBAR_FOLD_PX.labelled) return 0
  if (toolbarWidth >= TOOLBAR_FOLD_PX.packed) return 1
  if (toolbarWidth >= TOOLBAR_FOLD_PX.glyphs) return 2
  if (toolbarWidth >= TOOLBAR_FOLD_PX.tight) return 3
  return 4
}

export const COMPOSER_TOOLBAR_CHIP =
  "touch-hit h-7 min-w-0 shrink rounded-md border-transparent bg-transparent px-2 has-[>svg]:px-2 text-[11px] font-normal text-muted-foreground shadow-none hover:border-transparent hover:bg-muted/60 hover:text-foreground dark:border-transparent dark:bg-transparent dark:hover:bg-muted/60"

export const COMPOSER_TOOLBAR_GLYPH = "w-7 justify-center px-0 has-[>svg]:px-0"
