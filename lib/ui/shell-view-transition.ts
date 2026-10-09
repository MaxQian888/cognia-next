/**
 * Run one shell edge-panel gesture as a View Transition.
 *
 * A collapse/expand touches a whole row of elements at once — the panel that
 * is moving, the columns it squeezes, and the title-bar outlets above them.
 * Committing the final layout once and animating compositor snapshots of all
 * of them is strictly smoother than a live flex tween: nothing reflows on
 * every frame, and no element can run ahead of or behind its neighbour.
 *
 * This is the shared plumbing behind `animateDockResize`
 * (`components/artifacts/artifact-workspace-dock.tsx`) and the sidebar gesture
 * (`lib/desktop/sidebar-edge-transition.ts`): both assign temporary
 * `view-transition-name`s, root the page out of the capture, run the DOM
 * mutation inside the callback, and put every name back when the motion
 * settles — however it settles.
 */

import { isProIdePanePinnedWithin } from "@/lib/codeserver/pane-manager"

export interface ShellTransitionCapture {
  /** Element to freeze into a snapshot for the gesture's duration. */
  element: HTMLElement | null | undefined
  /** The `view-transition-name` it answers to in `app/globals.css`. */
  name: string
}

export interface ShellViewTransitionOptions {
  /**
   * The region checked for a pinned native Pro IDE child webview. A DOM
   * snapshot cannot capture or clip one, so a scope containing one takes the
   * instant path instead. Pass the widest element the capture covers, or
   * `null` when no native webview can be inside it.
   */
  scope?: Element | null
  captures: readonly ShellTransitionCapture[]
  /**
   * Mutate the DOM to the gesture's final state. Runs inside the transition's
   * update callback — synchronously on the bail-out path — and at most once.
   */
  apply: () => void
  /**
   * Runs exactly once when the gesture settles — on natural finish, on
   * `skipTransition`, and on every bail-out (right after `apply`). For
   * caller-owned cleanup; restoring `view-transition-name`s is internal.
   */
  onDone?: () => void
}

/**
 * The root attribute `app/globals.css` keys on to stand every shell edge
 * panel's own CSS size transition down while a View Transition runs.
 *
 * The edge panels arm a 280ms `width`/`height` transition in the very commit
 * the gesture's `apply` produces (`useEdgePanelTransition`). Under a View
 * Transition that is the wrong half to keep: the new state is captured on the
 * first frame after the update, so it captured the panel at the *start* of its
 * tween — and `::view-transition-new` is a live image, so the snapshots then
 * animated toward a geometry the page was still sliding away from. The result
 * was ghosted double content, a strip of bare background where the panel had
 * been (black under a dark theme), and the whole row — a docked Monaco, the
 * file tree, the chat — reflowing on every frame of the gesture. With the size
 * transitions held, the commit lands the final layout in one frame and only
 * the compositor snapshots move.
 */
export const SHELL_VIEW_TRANSITION_ATTRIBUTE = "data-shell-view-transition"

/**
 * Gestures in flight. A second gesture started mid-flight makes the browser
 * skip the first, whose cleanup then lands while the second is still running —
 * a plain set/remove would drop the hold out from under it.
 */
let edgeTransitionHolds = 0

function holdEdgeTransitions(root: HTMLElement): void {
  edgeTransitionHolds += 1
  root.setAttribute(SHELL_VIEW_TRANSITION_ATTRIBUTE, "")
}

function releaseEdgeTransitions(root: HTMLElement): void {
  edgeTransitionHolds = Math.max(0, edgeTransitionHolds - 1)
  if (edgeTransitionHolds === 0) root.removeAttribute(SHELL_VIEW_TRANSITION_ATTRIBUTE)
}

/**
 * Returns the cancellation — calling it skips the in-flight transition (and
 * still runs `onDone`). Bail-outs return a no-op after applying directly.
 */
export function runShellViewTransition({
  scope = null,
  captures,
  apply,
  onDone,
}: ShellViewTransitionOptions): () => void {
  const startViewTransition =
    typeof document !== "undefined" ? document.startViewTransition?.bind(document) : undefined

  const bail = () => {
    apply()
    onDone?.()
    return () => {}
  }

  // A hidden document has nothing to animate, and WebKit skips the transition
  // there by rejecting `ready` with InvalidStateError.
  if (
    !startViewTransition ||
    document.visibilityState === "hidden" ||
    (scope && isProIdePanePinnedWithin(scope))
  ) {
    return bail()
  }

  const root = document.documentElement
  const previousRootName = root.style.viewTransitionName
  const previousNames = captures.map((capture) => capture.element?.style.viewTransitionName ?? "")
  // The document root participates in every transition by default; opting it
  // out is what stops a whole-page crossfade under the panel snapshots.
  root.style.viewTransitionName = "none"
  captures.forEach((capture) => {
    if (capture.element) capture.element.style.viewTransitionName = capture.name
  })
  holdEdgeTransitions(root)
  const reset = () => {
    releaseEdgeTransitions(root)
    root.style.viewTransitionName = previousRootName
    captures.forEach((capture, index) => {
      if (capture.element) capture.element.style.viewTransitionName = previousNames[index]
    })
  }

  let applied = false
  const applyOnce = () => {
    if (applied) return
    applied = true
    apply()
  }

  let transition: ViewTransition
  try {
    transition = startViewTransition(applyOnce)
  } catch {
    reset()
    applyOnce()
    onDone?.()
    return () => {}
  }

  let active = true
  const finish = () => {
    if (!active) return
    active = false
    reset()
    onDone?.()
  }
  // `ready` rejects whenever the animation never starts: skipped by the
  // browser (the page went hidden mid-call) or by `skipTransition` below.
  // `finished` still settles in both cases and owns the cleanup.
  void transition.ready.catch(() => undefined)
  void transition.finished.catch(() => undefined).finally(() => finish())
  return () => {
    if (!active) return
    transition.skipTransition()
    finish()
  }
}
