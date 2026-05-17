/**
 * Heuristic edge router for the visual workflow editor.
 *
 * Pure geometry — no React, no DOM. Two cases:
 *   • L-shaped orthogonal step with rounded corners when source/target are
 *     roughly horizontal and far apart (the common "left→right" Flowith
 *     look).
 *   • Bezier fallback otherwise, with single-blocker midpoint offset so a
 *     curve that would land inside a non-endpoint node's rect bends
 *     around it.
 *
 * Caller is responsible for excluding the source + target nodes from the
 * blocker scan via `excludeNodeIds`.
 */

export interface RouteRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export type HandlePosition = "left" | "right" | "top" | "bottom"

export interface RouteInputs {
  sourceX: number
  sourceY: number
  sourcePosition: HandlePosition
  targetX: number
  targetY: number
  targetPosition: HandlePosition
  nodes: ReadonlyArray<RouteRect>
  excludeNodeIds: ReadonlyArray<string>
  /** Default 8. */
  cornerRadius?: number
}

export interface RouteResult {
  /** SVG path `d` attribute. */
  path: string
  /** Approximate midpoint for label placement. */
  midpoint: { x: number; y: number }
}

const ORTHOGONAL_MIN_DELTA = 60

function pointInRect(p: { x: number; y: number }, r: RouteRect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

export function computeSmartRoute(input: RouteInputs): RouteResult {
  const r = input.cornerRadius ?? 8
  const dx = input.targetX - input.sourceX
  const dy = input.targetY - input.sourceY
  const horizontalHandles = input.sourcePosition === "left" || input.sourcePosition === "right"
  const verticalHandles = input.sourcePosition === "top" || input.sourcePosition === "bottom"
  const farEnough = Math.abs(dx) >= ORTHOGONAL_MIN_DELTA && Math.abs(dy) >= ORTHOGONAL_MIN_DELTA

  if (horizontalHandles && farEnough) {
    // Horizontal-bend L: source/target sit on the left or right edge of
    // their nodes; we step across to a vertical midline, turn 90°, drop to
    // the target row, then step in.
    const midX = input.sourceX + dx / 2
    const sx = Math.sign(dx) || 1
    const sy = Math.sign(dy) || 1
    const rr = Math.min(r, Math.abs(dx) / 2 - 1, Math.abs(dy) / 2 - 1)
    const path =
      `M ${input.sourceX} ${input.sourceY} ` +
      `L ${midX - rr * sx} ${input.sourceY} ` +
      `Q ${midX} ${input.sourceY} ${midX} ${input.sourceY + rr * sy} ` +
      `L ${midX} ${input.targetY - rr * sy} ` +
      `Q ${midX} ${input.targetY} ${midX + rr * sx} ${input.targetY} ` +
      `L ${input.targetX} ${input.targetY}`
    return {
      path,
      midpoint: { x: midX, y: (input.sourceY + input.targetY) / 2 },
    }
  }

  if (verticalHandles && farEnough) {
    // Vertical-bend L: source/target sit on the top or bottom edge; we
    // drop to a horizontal midline, turn 90°, step across to the target
    // column, then descend in.
    const midY = input.sourceY + dy / 2
    const sx = Math.sign(dx) || 1
    const sy = Math.sign(dy) || 1
    const rr = Math.min(r, Math.abs(dx) / 2 - 1, Math.abs(dy) / 2 - 1)
    const path =
      `M ${input.sourceX} ${input.sourceY} ` +
      `L ${input.sourceX} ${midY - rr * sy} ` +
      `Q ${input.sourceX} ${midY} ${input.sourceX + rr * sx} ${midY} ` +
      `L ${input.targetX - rr * sx} ${midY} ` +
      `Q ${input.targetX} ${midY} ${input.targetX} ${midY + rr * sy} ` +
      `L ${input.targetX} ${input.targetY}`
    return {
      path,
      midpoint: { x: (input.sourceX + input.targetX) / 2, y: midY },
    }
  }

  // Bezier fallback. The control points sit 60px horizontally outside the
  // endpoints by default, which gives the familiar smooth-curve look.
  let c1 = { x: input.sourceX + 60, y: input.sourceY }
  let c2 = { x: input.targetX - 60, y: input.targetY }
  let mid = {
    x: (input.sourceX + input.targetX) / 2,
    y: (input.sourceY + input.targetY) / 2,
  }

  // Single-blocker avoidance: if the midpoint sits inside a non-endpoint
  // node's rect, offset the control points (and the midpoint we report for
  // the label) above or below the blocker.
  const excludeSet = new Set(input.excludeNodeIds)
  const blocker = input.nodes.find((n) => !excludeSet.has(n.id) && pointInRect(mid, n))
  if (blocker) {
    const blockerCenterY = blocker.y + blocker.height / 2
    const dir = mid.y < blockerCenterY ? -1 : 1
    const offset = blocker.height / 2 + 24
    c1 = { x: c1.x, y: c1.y + offset * dir }
    c2 = { x: c2.x, y: c2.y + offset * dir }
    mid = { x: mid.x, y: mid.y + offset * dir }
  }

  const path =
    `M ${input.sourceX} ${input.sourceY} ` +
    `C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${input.targetX} ${input.targetY}`
  return { path, midpoint: mid }
}
