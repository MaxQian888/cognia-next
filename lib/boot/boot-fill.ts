/**
 * Boot progress fill — the one rule that keeps the boot bars moving forward.
 *
 * Both boot screens (`components/boot/boot-screen.tsx` on desktop/web,
 * `components/mobile/splash/mobile-boot-screen.tsx` on the phone) draw their
 * progress as a full-width fill translated left by the remaining share, moved
 * by CSS transitions so it stays fluid while the main thread is busy booting.
 * The screen is re-mounted by every owner that holds the app back (see
 * `lib/boot/boot-progress.ts`), so the fill is a new element at every
 * hand-over and has to be told where the bar stood.
 *
 * The bar used to jump back and forth because each mount reasoned about that
 * position on its own: a mount inherited the previous owner's *target* rather
 * than where the bar visibly was mid-transition, and a route load inherited
 * the finished cold boot's ~96% before discovering it was a new wait and
 * animating back to zero. This module owns the position instead:
 *
 *   - `rememberBootFill` records where the bar visibly stands, per sequence,
 *     and only ever raises it within one;
 *   - `initialBootFill` hands that to the next mount of the same sequence and
 *     zero to the first mount of a new one;
 *   - `planBootFill` turns a step's boundary and lean-in target into the two
 *     beats the screens animate, clamped so neither is behind the bar.
 *
 * Framework-free; the React glue is `hooks/boot/use-boot-fill.ts`.
 */

interface BootFillMemory {
  /** `BootProgressSnapshot.sequence` the position belongs to. */
  sequence: number
  /** Where the bar visibly stood, in [0, 1]. */
  fraction: number
}

let memory: BootFillMemory = { sequence: 0, fraction: 0 }

export function clampFillFraction(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Where a mount for `sequence` should place the bar before its first move. */
export function initialBootFill(sequence: number): number {
  return memory.sequence === sequence ? memory.fraction : 0
}

/**
 * Record where the bar stands for `sequence`. Within a sequence the record
 * only rises, so a late or imprecise reading can never pull the next mount
 * behind a position the user has already seen.
 */
export function rememberBootFill(sequence: number, fraction: number): void {
  const next = clampFillFraction(fraction)
  if (memory.sequence === sequence && next <= memory.fraction) return
  memory = { sequence, fraction: next }
}

export interface BootFillPlan {
  /** Completion snap: the active step's start boundary. */
  snap: number
  /** Lean-in target the long creep decelerates toward. */
  creep: number
}

/**
 * The two beats for one step, never behind `current` (where the bar visibly
 * is now). A boundary behind the bar — the visible list widened mid-wait, or
 * the previous creep overshot a re-weighted slot — holds the bar still instead
 * of dragging it back.
 */
export function planBootFill(current: number, boundary: number, target: number): BootFillPlan {
  const snap = Math.max(clampFillFraction(current), clampFillFraction(boundary))
  return { snap, creep: Math.max(snap, clampFillFraction(target)) }
}

const MATRIX = /^matrix(3d)?\(([^)]+)\)$/

/**
 * Where a fill element visibly stands right now, mid-transition included. The
 * computed `transform` is the animated value; it resolves to a matrix whose
 * x-translation is `(fraction - 1) * width`. Falls back to the declared custom
 * property where no layout exists (a detached node, jsdom).
 */
export function readFillFraction(element: HTMLElement, property: string): number {
  const match = MATRIX.exec(getComputedStyle(element).transform)
  const width = element.offsetWidth
  if (match && width > 0) {
    const values = match[2].split(",").map((value) => Number(value.trim()))
    const translateX = match[1] ? values[12] : values[4]
    if (translateX !== undefined && Number.isFinite(translateX)) {
      return clampFillFraction(1 + translateX / width)
    }
  }
  return clampFillFraction(Number(element.style.getPropertyValue(property)))
}

export function __resetBootFillForTesting(): void {
  memory = { sequence: 0, fraction: 0 }
}
