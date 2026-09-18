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

  if (!startViewTransition || (scope && isProIdePanePinnedWithin(scope))) return bail()

  const root = document.documentElement
  const previousRootName = root.style.viewTransitionName
  const previousNames = captures.map((capture) => capture.element?.style.viewTransitionName ?? "")
  // The document root participates in every transition by default; opting it
  // out is what stops a whole-page crossfade under the panel snapshots.
  root.style.viewTransitionName = "none"
  captures.forEach((capture) => {
    if (capture.element) capture.element.style.viewTransitionName = capture.name
  })
  const reset = () => {
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
  void transition.finished.catch(() => undefined).finally(() => finish())
  return () => {
    if (!active) return
    transition.skipTransition()
    finish()
  }
}
