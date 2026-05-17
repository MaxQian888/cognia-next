/**
 * Pure geometry helpers for the workflow editor's free-form lasso selection.
 * No React, no DOM — every function takes flow-space coordinates.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Ray-casting point-in-polygon. Handles concave / self-touching shapes. */
export function isPointInPolygon(p: Point, polygon: ReadonlyArray<Point>): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Approximate rectangle-polygon intersection. Cheap, but tight enough for
 * lasso hit-testing of node rects: returns true when any rect corner or its
 * centre is inside the polygon, OR any polygon vertex is inside the rect.
 */
export function rectIntersectsPolygon(rect: Rect, polygon: ReadonlyArray<Point>): boolean {
  if (polygon.length < 3) return false
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
  ]
  for (const c of corners) if (isPointInPolygon(c, polygon)) return true
  for (const v of polygon) {
    if (
      v.x >= rect.x &&
      v.x <= rect.x + rect.width &&
      v.y >= rect.y &&
      v.y <= rect.y + rect.height
    ) {
      return true
    }
  }
  return false
}

export interface LassoNode {
  id: string
  position: Point
  width?: number | null
  height?: number | null
}

export interface NodeIdsInPolygonOptions {
  defaultWidth?: number
  defaultHeight?: number
}

/**
 * Compute the set of node ids whose rect intersects `polygon`.
 *
 * Default rect size matches `WorkflowNodeComponent` (240 × 80).
 */
export function nodeIdsInPolygon(
  nodes: ReadonlyArray<LassoNode>,
  polygon: ReadonlyArray<Point>,
  options: NodeIdsInPolygonOptions = {}
): string[] {
  const dw = options.defaultWidth ?? 240
  const dh = options.defaultHeight ?? 80
  if (polygon.length < 3) return []
  const out: string[] = []
  for (const n of nodes) {
    const rect: Rect = {
      x: n.position.x,
      y: n.position.y,
      width: n.width ?? dw,
      height: n.height ?? dh,
    }
    if (rectIntersectsPolygon(rect, polygon)) out.push(n.id)
  }
  return out
}
