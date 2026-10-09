/**
 * Run a terminal-dock open, close, move or maximize as one View Transition.
 *
 * The dock region animates the space it takes (`terminal-dock-region.tsx`):
 * its height in the bottom slot, its width in the right one. Played live, that
 * tween resizes the routed page beside it on every frame — the chat, the
 * artifact dock, a docked Monaco and its file tree all re-laid out sixteen times
 * for one gesture, which is the stutter a bottom⇄right move showed. Moving
 * between the slots is the worst case: one region collapses while the other
 * opens, so both axes of the page reflow at once.
 *
 * Under a View Transition the store write commits the final layout in a single
 * frame and only compositor snapshots move — the same trade the conversation
 * sidebar (`lib/desktop/sidebar-edge-transition.ts`) and the artifact dock
 * (`components/artifacts/artifact-workspace-dock.tsx`) make. The regions' own
 * size transition stands down for the gesture through
 * `SHELL_VIEW_TRANSITION_ATTRIBUTE` (`app/globals.css`), so the two motions can
 * no longer fight. Engines without View Transitions (and jsdom) take the
 * instant path: `apply` runs synchronously and the regions keep their CSS
 * tween exactly as before.
 *
 * A gesture only applies the store write when its update callback runs — one
 * frame later under a transition. Every caller's state change is therefore
 * computed inside `apply` against the store as it is *then*, never captured up
 * front, so two toggles in quick succession still land open → closed.
 */

import { runShellViewTransition } from "@/lib/ui/shell-view-transition"

/** The routed page above the bottom slot — what the dock squeezes. */
const CONTENT_SELECTOR = "[data-find-scope]"
const REGION_SELECTOR = '[data-testid="terminal-dock-region"]'

export function runTerminalDockGesture(apply: () => void): void {
  if (typeof document === "undefined") {
    apply()
    return
  }
  const bottom = document.querySelector<HTMLElement>(`${REGION_SELECTOR}[data-position="bottom"]`)
  const right = document.querySelector<HTMLElement>(`${REGION_SELECTOR}[data-position="right"]`)
  const content = document.querySelector<HTMLElement>(CONTENT_SELECTOR)
  // Not the desktop shell (the compact shell, a bypass route): nothing to
  // capture, and nothing reflows beside a dock that is not drawn.
  if (!bottom || !right || !content) {
    apply()
    return
  }
  runShellViewTransition({
    // The routed page is where a pinned Pro IDE webview can sit; a DOM snapshot
    // cannot capture one, so its presence takes the instant path.
    scope: content,
    captures: [
      { element: content, name: "cognia-terminal-content" },
      { element: bottom, name: "cognia-terminal-bottom" },
      { element: right, name: "cognia-terminal-right" },
      // The artifact dock's header sits in the end outlet, sized to the dock
      // column — which a right-slot terminal narrows. Captured so it moves on
      // the same clock instead of snapping when the transition ends.
      {
        element: document.querySelector<HTMLElement>('[data-title-bar-outlet="center"]'),
        name: "cognia-terminal-outlet-center",
      },
      {
        element: document.querySelector<HTMLElement>('[data-title-bar-outlet="end"]'),
        name: "cognia-terminal-outlet-end",
      },
    ],
    apply,
  })
}
