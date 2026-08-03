/**
 * Pure, render-free view helpers for {@link EffortSelector} — the composer's
 * thinking-level control. Extracted so the responsive layout decision, the
 * track geometry (marker position, pointer → tier), and the keyboard map are
 * unit-testable without mounting a popover; the component only draws.
 *
 * Deliberately mirrors `cli/src/tui/components/effort-slider-view.ts`, which
 * does the same job in terminal cells. The two share the tier ladder itself
 * (`@/lib/ai/thinking-level`) but not the geometry: one measures in px against
 * a DOMRect, the other in columns.
 */

import { EFFORT_SLIDER_LEVELS } from "@/lib/ai/thinking-level"

/** Which presentation the user picked; persisted as `composerBehavior.effortSelectorMode`. */
export type EffortSelectorMode = "slider" | "list"

/** The default when the user has never chosen — the richer of the two. */
export const DEFAULT_EFFORT_SELECTOR_MODE: EffortSelectorMode = "slider"

/** Index of the last tier on the track. */
export const LAST_TIER_INDEX = EFFORT_SLIDER_LEVELS.length - 1

/**
 * Layout band for a measured container width.
 *
 * `"wide"` labels every tick under the track (slider) / shows a description per
 * row (list); `"compact"` drops to the active tier alone, so a narrow container
 * never wraps six labels into noise.
 */
export type EffortSelectorLayout = "wide" | "compact"

/**
 * Width below which the per-tier labels stop fitting. Six labels plus gaps want
 * roughly 300px in English (the widest locale here — zh-CN tier names are much
 * shorter), measured on the control's own container rather than the viewport so
 * it also adapts inside a narrow workflow sidebar.
 */
export const EFFORT_WIDE_MIN_PX = 300

/**
 * Pick the layout band. `0` means "not yet measured" (the `useElementWidth`
 * contract) and takes the wide branch, matching the 360px model-picker popover
 * this control lives in — so the common case never flashes through compact.
 */
export function effortSelectorLayout(width: number): EffortSelectorLayout {
  if (!Number.isFinite(width) || width <= 0) return "wide"
  return width >= EFFORT_WIDE_MIN_PX ? "wide" : "compact"
}

/**
 * Marker position as a percentage of the track, for `left:` / `width:`. An
 * index below zero (`"off"`) has no marker; callers skip rendering it, and the
 * `0` returned here is only a defensive value. A single-tier ladder centres.
 */
export function effortMarkerPercent(index: number, last: number = LAST_TIER_INDEX): number {
  if (last <= 0) return 50
  if (index < 0) return 0
  return (Math.min(index, last) / last) * 100
}

/**
 * Half the marker's width (`w-4` ⇒ `1rem`), as a CSS length. The track reserves
 * this much at each end so the marker at tier 0 / the last tier sits fully
 * inside the rounded track instead of overhanging its cap.
 */
export const EFFORT_MARKER_INSET = "0.5rem"

/**
 * Left offset for a tick or the marker, as a CSS `calc()` that maps the tier
 * ladder onto the track's inset span. Pair with a `-translate-x-1/2` so the
 * value addresses the element's CENTRE; the same expression doubles as the
 * filled portion's width, which is exactly "up to the marker's centre".
 *
 * The pointer→tier direction deliberately ignores the inset: the reading is
 * snapped to the nearest of six tiers, and half a marker is a small fraction of
 * one tier's span, so correcting for it would change no outcome.
 */
export function effortTrackOffset(index: number, last: number = LAST_TIER_INDEX): string {
  const ratio = effortMarkerPercent(index, last) / 100
  return `calc(${EFFORT_MARKER_INSET} + ${ratio} * (100% - ${EFFORT_MARKER_INSET} * 2))`
}

/**
 * Map a pointer's clientX against the track's bounding rect to a `0..1` ratio,
 * clamped so a drag that leaves the element still resolves to an end tier
 * rather than an out-of-range one. A zero-width rect (jsdom, or a track that
 * hasn't laid out yet) collapses to `0`.
 */
export function effortRatioFromPointer(clientX: number, rect: { left: number; width: number }) {
  if (!Number.isFinite(clientX)) return 0
  if (!Number.isFinite(rect.width) || rect.width <= 0) return 0
  return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
}

/** Nearest tier index for a `0..1` position along the track. */
export function effortIndexFromRatio(ratio: number, last: number = LAST_TIER_INDEX): number {
  if (last <= 0) return 0
  const clamped = Math.min(Math.max(ratio, 0), 1)
  return Math.round(clamped * last)
}

/**
 * What a keypress on the track means. `null` = not ours, let the event through
 * (so Tab, Escape, and popover dismissal still work).
 */
export type EffortKeyAction = { kind: "tier"; index: number } | { kind: "off" } | null

/** Keys that move along the track. Up/Down included: this is a `role="slider"`,
 * and both axes are conventional there. */
const MOVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"])

/**
 * Keyboard map for the slider: ←/↓ and →/↑ step one tier, Home/End jump to the
 * ends, `1`-`9` jump to a tier (1-based, matching the CLI's number-key hint),
 * and `0` returns to "use model default".
 *
 * From `"off"` (`index < 0`) any movement key ENGAGES the track rather than
 * stepping relative to a marker that isn't drawn — `End` at the smart end,
 * everything else at the fast end.
 */
export function effortKeyAction(
  key: string,
  index: number,
  last: number = LAST_TIER_INDEX
): EffortKeyAction {
  if (key === "0") return { kind: "off" }
  if (/^[1-9]$/.test(key)) {
    const target = Number(key) - 1
    return target <= last ? { kind: "tier", index: target } : null
  }
  if (!MOVE_KEYS.has(key)) return null
  if (key === "End") return { kind: "tier", index: last }
  if (key === "Home") return { kind: "tier", index: 0 }
  if (index < 0) return { kind: "tier", index: 0 }
  const delta = key === "ArrowRight" || key === "ArrowUp" ? 1 : -1
  return { kind: "tier", index: Math.min(Math.max(index + delta, 0), last) }
}
