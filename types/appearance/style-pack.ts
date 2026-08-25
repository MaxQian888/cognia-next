// Style packs (ADR-0148) — the "shape" half of the appearance system.
//
// The colour half already exists and is mature: 8 accent presets
// (`lib/themes/preset-meta.ts`), 9 hand-authored themes, VSCode import, OKLCH
// variant derivation. What was missing is any notion of a *look*: radius,
// pill shape, elevation, density, and micro-label treatment were each an
// independent knob spread across the Appearance settings, so "make it look
// hard-edged" meant hand-tuning a dozen sliders and still failing on the 491
// `rounded-full` pills and the 252 `shadow-*` sites that no knob reaches.
//
// A pack sets all of them at once. Packs and colour themes are fully
// orthogonal: Sharp × Catppuccin and Sharp × an imported VSCode theme are both
// valid combinations, because a pack never touches a colour token.
//
// The `{ packId, overrides }` shape deliberately mirrors
// `MessageDisplayPreferences` in `./index.ts` — same resolver pattern, so the
// settings UI, the changed-settings review, and per-section reset all behave
// the way users already expect from message display.

import type { ComposerSkinId } from "@/lib/chat/composer-skin"
import type { DensityLevel } from "./index"

/** Stable ids. `soft` is the default and must stay first. */
export const STYLE_PACK_IDS = ["soft", "studio", "sharp"] as const

export type StylePackId = (typeof STYLE_PACK_IDS)[number]

export const DEFAULT_STYLE_PACK_ID: StylePackId = "soft"

/**
 * How secondary labels (timestamps, counts, status words) are typeset.
 * `mono-upper` is what makes a squared-off UI read as an engineering tool
 * rather than a SaaS app with the corners filed off.
 */
export type MicroLabelStyle = "default" | "mono-upper"

/**
 * How a surface's 1px border carries weight once shadows are gone.
 *
 *  - `default`  — `--border` as-is (today's behaviour)
 *  - `hairline` — softened, the marketing site's treatment; pairs with a
 *                 shallow elevation ceiling so panels separate by tone
 *  - `strong`   — pushed toward the foreground, so a shadowless layout still
 *                 has legible hierarchy
 */
export type BorderTone = "default" | "hairline" | "strong"

export interface StylePackTokens {
  /** Base `--radius` in rem. The named control/panel/stage scale derives from it. */
  radiusBaseRem: number
  /** `--pill-radius` in px. 9999 = capsule, 0 = square, 8 = "no oversized pills". */
  pillRadiusPx: number
  /** Ceiling on the `[data-elevation]` scale. 0 suppresses `shadow-*` utilities too. */
  elevationMax: 0 | 1 | 2 | 3
  borderTone: BorderTone
  density: DensityLevel
  microLabel: MicroLabelStyle
  /** Added to `--letter-spacing-em`. Negative tightens. */
  letterSpacingEm: number
  /** The composer skin this pack defaults to. Users can still override it. */
  composerSkin: ComposerSkinId
}

/**
 * The three packs.
 *
 * `soft` holds the values today's stylesheet already declares. It exists so the
 * settings UI can describe the default truthfully — the applier never writes
 * these, it short-circuits (see `style-pack-applier.tsx`), which is what makes
 * "the default look is unchanged" a structural guarantee rather than a promise
 * that a rem→px conversion was done right. Same trick as the `classic`
 * composer skin and `RadiusApplier`'s default branch.
 *
 * `studio` is the language `web/app/globals.css` already pins for the
 * marketing site: the same 8/12/14 control/panel/stage scale (which the default
 * base happens to produce exactly), hairline rules, a shallow elevation
 * ceiling, and its stated "No oversized pills" — badges drop to the control
 * radius instead of a capsule.
 *
 * `sharp` is the hard-edged end: nothing is round that is not semantically a
 * circle, no shadows at all, tighter density, monospace caps for micro-labels.
 */
export const STYLE_PACKS: Record<StylePackId, StylePackTokens> = {
  soft: {
    radiusBaseRem: 0.625,
    pillRadiusPx: 9999,
    elevationMax: 3,
    borderTone: "default",
    density: "comfortable",
    microLabel: "default",
    letterSpacingEm: 0,
    composerSkin: "classic",
  },
  studio: {
    radiusBaseRem: 0.625,
    pillRadiusPx: 8,
    elevationMax: 1,
    borderTone: "hairline",
    density: "comfortable",
    microLabel: "default",
    letterSpacingEm: 0,
    composerSkin: "classic",
  },
  sharp: {
    radiusBaseRem: 0,
    pillRadiusPx: 0,
    elevationMax: 0,
    borderTone: "strong",
    density: "compact",
    microLabel: "mono-upper",
    letterSpacingEm: -0.005,
    composerSkin: "dense",
  },
}

export type StylePackOverrides = Partial<StylePackTokens>

export interface StylePackSettings {
  packId: StylePackId
  /**
   * Sparse deltas on top of the pack. Storing deltas rather than resolved
   * values is what lets the UI answer "am I on Sharp?", offer "reset to pack",
   * and carry a user's tweaks across a pack switch.
   */
  overrides?: StylePackOverrides
}

export const DEFAULT_STYLE_PACK: StylePackSettings = { packId: DEFAULT_STYLE_PACK_ID }

/** Narrow an arbitrary value to a known pack id. */
export function isStylePackId(value: unknown): value is StylePackId {
  return STYLE_PACK_IDS.includes(value as StylePackId)
}

export interface ResolvedStylePack extends StylePackTokens {
  packId: StylePackId
  /**
   * True when the resolved tokens are byte-identical to `soft` — i.e. the
   * applier must write nothing. Also true for an explicit `soft` selection
   * whose overrides happen to cancel out.
   */
  isDefault: boolean
}

/**
 * Resolve `{ packId, overrides }` into concrete tokens.
 *
 * Unknown ids fall back to `soft` rather than throwing: a settings row written
 * by a newer build (or hand-edited) must not brick the shell.
 */
export function resolveStylePack(settings: StylePackSettings | undefined): ResolvedStylePack {
  const packId = isStylePackId(settings?.packId) ? settings.packId : DEFAULT_STYLE_PACK_ID
  const base = STYLE_PACKS[packId]
  const overrides = settings?.overrides ?? {}
  const tokens: StylePackTokens = {
    radiusBaseRem: clampRadiusRem(overrides.radiusBaseRem ?? base.radiusBaseRem),
    pillRadiusPx: clampPillPx(overrides.pillRadiusPx ?? base.pillRadiusPx),
    elevationMax: overrides.elevationMax ?? base.elevationMax,
    borderTone: overrides.borderTone ?? base.borderTone,
    density: overrides.density ?? base.density,
    microLabel: overrides.microLabel ?? base.microLabel,
    letterSpacingEm: clampLetterSpacing(overrides.letterSpacingEm ?? base.letterSpacingEm),
    composerSkin: overrides.composerSkin ?? base.composerSkin,
  }
  return { packId, ...tokens, isDefault: tokensEqual(tokens, STYLE_PACKS.soft) }
}

/** Matches `RadiusApplier`'s clamp so the two knobs cannot disagree. */
function clampRadiusRem(value: number): number {
  if (!Number.isFinite(value)) return STYLE_PACKS.soft.radiusBaseRem
  return value < 0 ? 0 : value > 1.5 ? 1.5 : value
}

function clampPillPx(value: number): number {
  if (!Number.isFinite(value)) return STYLE_PACKS.soft.pillRadiusPx
  return value < 0 ? 0 : value > 9999 ? 9999 : value
}

function clampLetterSpacing(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < -0.02 ? -0.02 : value > 0.02 ? 0.02 : value
}

function tokensEqual(a: StylePackTokens, b: StylePackTokens): boolean {
  return (
    a.radiusBaseRem === b.radiusBaseRem &&
    a.pillRadiusPx === b.pillRadiusPx &&
    a.elevationMax === b.elevationMax &&
    a.borderTone === b.borderTone &&
    a.density === b.density &&
    a.microLabel === b.microLabel &&
    a.letterSpacingEm === b.letterSpacingEm &&
    a.composerSkin === b.composerSkin
  )
}
