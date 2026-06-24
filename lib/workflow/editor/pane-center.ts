/**
 * Compute the client-space (screen) point at the centre of the workflow
 * canvas PANE, for feeding into React Flow's `screenToFlowPosition`.
 *
 * The editor surrounds the canvas with a left node palette and a right
 * inspector/sidebar, so the pane is narrower than the window. Centering work
 * (drop-a-node-at-centre, locate) must measure the pane's own rect — using
 * `window.innerWidth/2` instead lands the point right of the pane centre, so
 * new/located nodes drift to the right edge of the visible canvas.
 *
 * Pass `el.getBoundingClientRect()` of the React Flow wrapper. When no rect is
 * available (ref not yet attached) it falls back to the window centre.
 */
export function paneCenterScreenPoint(
  rect: { left: number; top: number; width: number; height: number } | null | undefined
): { x: number; y: number } {
  if (!rect) {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}
