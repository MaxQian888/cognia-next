/**
 * Sticky scroll for the integrated terminal — pure line maths.
 *
 * VS Code keeps the currently-scrolled-past command's prompt line pinned at
 * the top of the viewport while you read its (possibly long) output. We reuse
 * the per-command start markers `terminal-instance.tsx` already registers: the
 * command to pin is the one whose start line is at or above the viewport top
 * but nearest to it — i.e. the command whose output the viewport is currently
 * inside.
 *
 * This module owns the pure selection so it can be unit-tested without an
 * xterm instance; the overlay (`terminal-sticky-scroll.tsx`) renders the text
 * of the resolved line and the component wires `term.onScroll`.
 */

/**
 * The command start line to pin for a given viewport top, or `null` when the
 * viewport is above the first command (nothing to pin yet). `commandLines`
 * need not be sorted. When the viewport top sits exactly on a command's start
 * line that command is pinned (its header is the top visible row).
 */
export function stickyCommandFor(
  commandLines: readonly number[],
  viewportTop: number
): number | null {
  if (!Number.isFinite(viewportTop)) return null
  let best: number | null = null
  for (const line of commandLines) {
    if (line <= viewportTop && (best === null || line > best)) best = line
  }
  return best
}

/**
 * Whether the sticky header should be shown at all: only when a command is
 * resolved AND its start line is strictly above the viewport top (so the real
 * prompt row has scrolled off the top). When the prompt row is still visible
 * (`pinned === viewportTop`) there's nothing to duplicate, so we hide it —
 * matching VS Code, which only shows sticky scroll once the command header
 * leaves the viewport.
 */
export function shouldShowSticky(pinned: number | null, viewportTop: number): boolean {
  return pinned !== null && pinned < viewportTop
}
