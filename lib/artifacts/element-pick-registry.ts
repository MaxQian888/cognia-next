"use client"

/**
 * How the dock arms the element picker on a LIVE artifact preview.
 *
 * The split of responsibility is the whole point. Only `ArtifactPreview` knows
 * how to reach the pixels it drew — and the three answers are genuinely
 * different (`components/artifacts/runtime-adapters.ts`):
 *
 * - `renderer` types and `jupyter` draw as live React in the app's own tree, so
 *   the picker installs on the app document scoped to the mounted node;
 * - `html` / `svg` render into an `allow-same-origin` frame the parent already
 *   writes, so the picker installs on `iframe.contentDocument`;
 * - `react` / interactive `html` render into an opaque-origin `allow-scripts`
 *   frame, so arming is a postMessage and picks come back the same way.
 *
 * Nothing outside the preview should have to branch on that. So the preview
 * registers a controller and the toolbar just says "arm" — the same shape
 * `frame-capture-registry.ts` uses for exports, and for the same reasons: a
 * plain module-level Map, because nothing renders off it and a React context
 * would re-render every preview whenever an unrelated one mounted.
 *
 * A registration is proof of a MOUNTED preview. That is what lets the toolbar
 * disable its toggle honestly instead of arming a picker into a panel the user
 * cannot see — the artifact may be open on the `code` tab, or the dock may be
 * showing comments.
 */

import type { ElementSelectionCore } from "@/types/element-selection"

/** Which modifier keys were down when the pick was committed. */
export interface ArtifactPickModifiers {
  metaKey: boolean
  ctrlKey: boolean
}

export interface ArtifactPickRequest {
  onPick: (selection: ElementSelectionCore, modifiers: ArtifactPickModifiers) => void
  /** The user aborted with Escape inside the preview. */
  onCancel?: () => void
  /** Stamped onto every payload, so the prompt heading can name the surface. */
  originLabel?: string
}

export interface ArtifactPickController {
  arm: (request: ArtifactPickRequest) => void
  disarm: () => void
}

const controllers = new Map<string, ArtifactPickController>()

/**
 * Subscribers to "which artifacts can be pointed at right now".
 *
 * A plain Map would be enough to ANSWER the question, but not to make a toolbar
 * react to it: the preview registers while it mounts, which is after the
 * toolbar has already rendered and decided its toggle was disabled. Nothing
 * would re-render it, so the button would sit greyed out over a perfectly
 * pickable preview. This is what `useSyncExternalStore` subscribes to.
 */
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Subscribe to registration changes. Returns an unsubscribe. */
export function subscribeToArtifactPickers(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Record how to arm `artifactId`'s live preview, returning a disposer.
 *
 * Re-registering the same id replaces the entry: the preview iframe is keyed
 * and the dock swaps panels, so a remount must not leave the toolbar holding a
 * controller that talks to a torn-down document.
 */
export function registerArtifactPicker(
  artifactId: string,
  controller: ArtifactPickController
): () => void {
  controllers.set(artifactId, controller)
  notify()
  return () => {
    if (controllers.get(artifactId) !== controller) return
    controllers.delete(artifactId)
    notify()
  }
}

/** Whether `artifactId` currently has a preview that can be pointed at. */
export function canPickArtifactElements(artifactId: string | null | undefined): boolean {
  return !!artifactId && controllers.has(artifactId)
}

/**
 * Arm the picker. Returns false when no preview is mounted, so the caller can
 * say why nothing happened rather than leaving a toggle stuck on.
 */
export function armArtifactPicker(artifactId: string, request: ArtifactPickRequest): boolean {
  const controller = controllers.get(artifactId)
  if (!controller) return false
  controller.arm(request)
  return true
}

/**
 * Disarm the picker. Safe to call for an artifact whose preview has already
 * unmounted — that is the ordinary teardown order when the dock closes, and a
 * throw there would take the whole panel down with it.
 */
export function disarmArtifactPicker(artifactId: string): void {
  controllers.get(artifactId)?.disarm()
}

/** Test seam: drop every registration between cases. */
export function __resetArtifactPickersForTests(): void {
  controllers.clear()
  notify()
  listeners.clear()
}
