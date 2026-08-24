/**
 * Composer skins — the table that decides how the input box is arranged.
 *
 * A skin is data, not a component. It resolves to a handful of CSS custom
 * properties plus three layout enums, which `ComposerBox` consumes; there is no
 * per-skin fork of the render tree. Adding a sixth skin is one row in
 * {@link COMPOSER_SKINS} plus two i18n keys.
 *
 * ## The invariant: reachability, not visibility
 *
 * A skin decides WHERE each control sits — inline, on a rail, or folded behind
 * the toolbar's "⋯" disclosure. It never removes one. `focus` is allowed to
 * fold more than the others; it is not allowed to drop a control on the floor.
 * `bottom-toolbar.tsx` already owns that disclosure, so "folded" is an existing
 * mechanism a skin selects, not one it authors.
 *
 * ## `classic` is preserved by construction
 *
 * `classic` is today's composer. It deliberately carries NO token values: the
 * box branches on the id and renders its original literal Tailwind classes, so
 * "unchanged" does not depend on anyone getting a rem→px conversion right. See
 * `composer-box.tsx` and the parity test beside it.
 */

/** Stable ids. `classic` is the default and must stay first. */
export const COMPOSER_SKIN_IDS = ["classic", "airy", "dense", "full", "focus"] as const

export type ComposerSkinId = (typeof COMPOSER_SKIN_IDS)[number]

export const DEFAULT_COMPOSER_SKIN: ComposerSkinId = "classic"

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

/**
 * `classic` carries the real values today's Tailwind classes compile to, for
 * reference and for the settings preview ONLY. The box never reads them — it
 * renders the original literals. Keeping them here (rather than leaving the row
 * empty) means the settings preview can draw `classic` truthfully without the
 * box having to opt into the variable path.
 */
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
}

/** User overrides layered on top of the chosen preset. All optional. */
export interface ComposerSkinOverrides {
  radiusPx?: number
  padXPx?: number
  padYPx?: number
  mono?: boolean
  sendShape?: ComposerSendShape
  toolbarLayout?: ComposerToolbarLayout
}

/** The `composerBehavior` fields this resolver reads. */
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

/**
 * Touch floors. A skin may not put a primary control below the platform
 * minimum, however dense it wants to be — so `dense` on a phone keeps its
 * corners and its typography but not its 26px send button.
 */
export const MOBILE_MIN_TOUCH_PX = 44
/** Corners below this read as a hairline seam at phone density. */
const MOBILE_MIN_RADIUS_PX = 12
const MOBILE_MIN_PAD_PX = 10

/** Clamp so a hand-edited settings row cannot produce an unusable box. */
const RADIUS_RANGE = [0, 32] as const
const PAD_RANGE = [2, 24] as const

function clamp(value: number, [min, max]: readonly [number, number]): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function isSkinId(value: unknown): value is ComposerSkinId {
  return typeof value === "string" && (COMPOSER_SKIN_IDS as readonly string[]).includes(value)
}

/**
 * Preset ← user overrides ← mobile floors, in that order.
 *
 * Two rules worth stating because they are easy to get backwards:
 *
 *  1. **`classic` ignores overrides.** Its whole contract is "today's box,
 *     untouched"; honouring a radius knob would break that silently. Pick
 *     another skin to adjust anything.
 *  2. **`compactLayout` is honoured only under `classic`.** Under any other
 *     skin the skin owns the layout and the legacy flag is inert — labelled as
 *     such in settings, and pinned by the test beside this file.
 */
export function resolveComposerSkin(
  settings: ComposerSkinSettings | undefined,
  opts: { isMobile: boolean }
): ResolvedComposerSkin {
  const id = isSkinId(settings?.skin) ? settings.skin : DEFAULT_COMPOSER_SKIN
  const preset = COMPOSER_SKINS[id]
  const isClassic = id === "classic"

  if (isClassic) {
    return {
      ...preset,
      id,
      isClassic: true,
      // The legacy stacked-layout toggle keeps working exactly as it did — and
      // it is NOT the same thing as running on a phone. Mobile stacking is
      // driven separately by the box's `isMobile` prop (the child clusters opt
      // out of the container-query row layout); folding the platform in here
      // would hand a phone the desktop compact skin's geometry as well.
      compactLayout: settings?.compactLayout === true,
    }
  }

  const o = settings?.skinOverrides ?? {}
  let radiusPx = clamp(o.radiusPx ?? preset.radiusPx, RADIUS_RANGE)
  let padXPx = clamp(o.padXPx ?? preset.padXPx, PAD_RANGE)
  let padYPx = clamp(o.padYPx ?? preset.padYPx, PAD_RANGE)
  let sendSizePx = preset.sendSizePx
  let toolbarLayout = o.toolbarLayout ?? preset.toolbarLayout

  if (opts.isMobile) {
    // Floors, not overrides: a skin that already exceeds them is left alone.
    sendSizePx = Math.max(sendSizePx, MOBILE_MIN_TOUCH_PX)
    radiusPx = Math.max(radiusPx, MOBILE_MIN_RADIUS_PX)
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
    // The skin owns its geometry, so the legacy stacked-layout flag has nothing
    // to say here (see the dormancy note above). Mobile stacking still happens
    // — it rides the box's `isMobile` prop, same as it did before skins.
    compactLayout: false,
  }
}

/**
 * The CSS custom properties the box sets for a non-classic skin. Returned as a
 * plain object so it can go straight into a `style` prop — inline properties
 * beat every stylesheet rule, including the ~3400 unlayered lines in
 * `globals.css` that outrank Tailwind utilities.
 *
 * Returns `undefined` for `classic` so that path emits no properties at all.
 */
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

/**
 * Skin proposes, width disposes.
 *
 * A skin picks a toolbar layout for a comfortable pane. A genuinely narrow one
 * cannot hold `expanded`'s labelled roster (or `detached`'s single wide row)
 * whatever the user chose, so below the threshold it degrades to the packing
 * layout. This is the same rule the toolbar already applied to width alone; the
 * skin just gets a say first.
 *
 * `width === 0` means "not measured yet" — keep the proposal rather than
 * flashing a compact layout on first paint.
 */
export const COMPACT_TOOLBAR_PX = 420

export function resolveToolbarLayout(
  proposed: ComposerToolbarLayout,
  toolbarWidth: number
): ComposerToolbarLayout {
  if (toolbarWidth <= 0 || toolbarWidth >= COMPACT_TOOLBAR_PX) return proposed
  // `detached` keeps its OWN narrow packing — the two-row compact branch that
  // predates skins. Rewriting it to `embedded` here would move the row from
  // below the box to inside it the moment a pane narrowed, which is not what
  // narrowing has ever meant for the classic composer.
  if (proposed === "detached") return "detached"
  // `folded` is already the tightest arrangement — narrowing cannot improve it.
  if (proposed === "folded") return "folded"
  return "embedded"
}
