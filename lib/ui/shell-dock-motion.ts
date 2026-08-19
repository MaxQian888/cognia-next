/**
 * The one clock every shell *edge panel* opens and collapses on.
 *
 * The shell has four surfaces that expand from — and collapse back into — a
 * window edge: the conversation sidebar (`components/desktop/channel-list.tsx`),
 * the artifact/workbench dock (`components/artifacts/artifact-workspace-dock.tsx`)
 * and the integrated terminal in either of its two slots
 * (`components/terminal/terminal-dock-region.tsx`). They used to move on three
 * different clocks — 200ms/`ease-in-out`, 280ms/`MOBILE_EASE` and
 * 200ms/`MOBILE_EASE` — which is why opening the terminal and collapsing the
 * sidebar read as two unrelated gestures even though they are the same one.
 *
 * The values are not new: they are `MOBILE_DURATION.normal` and `MOBILE_EASE`,
 * the shared tokens the artifact dock already used. What is new is that all of
 * them now name the same constant, so the next panel that grows an edge cannot
 * quietly pick a fourth pace.
 */

import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"

/** Duration of an edge panel's open/collapse, in milliseconds. */
export const SHELL_DOCK_DURATION_MS = MOBILE_DURATION.normal * 1000

/** Curve of an edge panel's open/collapse, as a CSS timing function. */
export const SHELL_DOCK_EASE = `cubic-bezier(${MOBILE_EASE.join(",")})`

/**
 * Grace period past the animation before teardown (dropping the transition
 * class, unmounting a collapsed panel's body). A slower motion preference
 * stretches the CSS animation; the slack keeps a cleanup timer from cutting the
 * tail off a transition that is still running.
 */
export const SHELL_DOCK_CLEANUP_SLACK_MS = 40

/**
 * The Tailwind twin of the two constants above.
 *
 * Arbitrary values cannot interpolate a TypeScript constant and still be
 * compiled into CSS, so the numbers appear once more as a complete literal —
 * kept whole so Tailwind's scanner finds it here. `shell-dock-motion.test.ts`
 * pins the literal against `SHELL_DOCK_DURATION_MS` / `SHELL_DOCK_EASE`, which
 * is what stops the pair from drifting apart again.
 */
export const SHELL_DOCK_TIMING_CLASS =
  "duration-[calc(280ms*var(--motion-duration-scale,1))] ease-[cubic-bezier(0.32,0.72,0,1)]"

/**
 * The motion-speed multiplier in force at `element` — the same
 * `--motion-duration-scale` var the CSS above reads, so a JS cleanup timer and
 * the transition it is waiting on agree even when the user has slowed motion
 * down. Falls back to `1` off the DOM and for any value that does not parse.
 */
export function shellDockDurationScale(element: Element | null | undefined): number {
  if (!element || typeof getComputedStyle !== "function") return 1
  const raw = Number(getComputedStyle(element).getPropertyValue("--motion-duration-scale"))
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

/**
 * How long to wait before treating an edge panel's open/collapse as finished:
 * the scaled animation plus {@link SHELL_DOCK_CLEANUP_SLACK_MS}.
 */
export function shellDockAnimationMs(element: Element | null | undefined): number {
  return SHELL_DOCK_DURATION_MS * shellDockDurationScale(element) + SHELL_DOCK_CLEANUP_SLACK_MS
}
