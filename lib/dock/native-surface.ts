/**
 * Keeping a native webview aligned with the dock tab that owns it.
 *
 * The embedded browser and the Pro IDE pane are not DOM. They are native
 * webviews the Rust side positions over the window from a rectangle we push at
 * them, so a dock tab holding one is really a *reservation*: an empty box whose
 * job is to be measured. That makes them behave unlike every other panel in
 * three ways the dock has to handle explicitly.
 *
 * 1. **They do not clip and they do not animate.** A CSS transition moves the
 *    DOM box over 200ms while the webview jumps to its final position on the
 *    first frame, so the two visibly separate. Any animation around a group
 *    holding one has to be skipped — the same bail `artifact-workspace-dock`
 *    already performs via `isProIdePanePinnedWithin`.
 * 2. **A background tab is not a hidden tab.** dockview keeps a `renderer:
 *    "always"` panel mounted but moves it off-screen; the webview would happily
 *    keep painting on top of whatever is now in front. It has to be told it is
 *    not visible.
 * 3. **They are process-wide singletons.** Ownership is a lease, so the dock
 *    releases it on unmount rather than assuming the next owner will take it.
 *
 * This module is the pure decision layer — what rect, visible or not, animate
 * or not. Actually pushing it is the panel's own hook, which already knows
 * whether it is the browser or code-server.
 */

import type { DockPanelInstance } from "@/types/dock/instance"
import type { ResolvedDockPanel } from "@/types/dock/panel"

/** A rectangle in CSS pixels relative to the window. */
export interface DockSurfaceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DockNativeSurfaceState {
  /** Where the reservation box currently sits. `null` before first measure. */
  rect: DockSurfaceRect | null
  /** Whether the webview should paint. */
  visible: boolean
}

/**
 * A rect small enough that the webview would be painting a sliver rather than
 * content. Treated as "not visible" instead: a mid-drag zero-height box would
 * otherwise make the native view flicker through every frame of the gesture.
 */
export const DOCK_SURFACE_MIN_VISIBLE_PX = 8

export function isDockSurfaceRectPaintable(rect: DockSurfaceRect | null): boolean {
  if (!rect) return false
  return (
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= DOCK_SURFACE_MIN_VISIBLE_PX &&
    rect.height >= DOCK_SURFACE_MIN_VISIBLE_PX
  )
}

export interface ResolveNativeSurfaceInput {
  /** Measured box of the reservation element. */
  rect: DockSurfaceRect | null
  /** Is this the active tab of its group? */
  active: boolean
  /** Is the dock collapsed to the rail, or the panel otherwise off-screen? */
  hostVisible: boolean
  /** True while a drag or resize is in flight. */
  interacting: boolean
}

/**
 * What the native webview should be told, given where its box is.
 *
 * Hiding during an interaction rather than tracking the box is deliberate: the
 * webview cannot be moved smoothly (see the header), so following a drag frame
 * by frame produces a native rectangle skating across the window a step behind
 * the pointer. Hiding for the duration of the gesture and reappearing where it
 * lands reads as intentional.
 */
export function resolveNativeSurfaceState(
  input: ResolveNativeSurfaceInput
): DockNativeSurfaceState {
  const paintable = isDockSurfaceRectPaintable(input.rect)
  const visible = paintable && input.active && input.hostVisible && !input.interacting
  return { rect: input.rect, visible }
}

/**
 * Does this group hold a panel that cannot be animated around?
 *
 * Called with the instances of one dockview group. A single native surface is
 * enough to disqualify the whole group: the animation moves the container, not
 * the individual tab.
 */
export function groupSuppressesAnimation(
  instances: readonly DockPanelInstance[],
  panelsById: ReadonlyMap<string, ResolvedDockPanel>
): boolean {
  return instances.some((instance) => {
    if (instance.kind === "native-surface") return true
    return panelsById.get(instance.panelId)?.meta.kind === "native-surface"
  })
}

/** Rect equality, so a re-measure that changed nothing does not push an update. */
export function sameDockSurfaceRect(a: DockSurfaceRect | null, b: DockSurfaceRect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
