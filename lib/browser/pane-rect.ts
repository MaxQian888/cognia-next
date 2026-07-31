/**
 * Module singleton holding the live reserved-region rect of the `/browser`
 * preview pane. The pane's rect observer publishes here; the agent browser
 * engine reads it so `browser_screenshot` can reuse the verified, region-based
 * `browser_embed_capture` path instead of re-deriving capture geometry.
 *
 * Renderer-only — pane and plugin share the same JS context.
 */
import type { ElementRect } from "@/lib/browser/protocol"

let activeRect: ElementRect | null = null

/** Publish the preview pane's current rect (or null when it closes/unmounts). */
export function setActivePaneRect(rect: ElementRect | null): void {
  activeRect = rect
}

/** The preview pane's current rect, or null when no preview is open. */
export function getActivePaneRect(): ElementRect | null {
  return activeRect
}
