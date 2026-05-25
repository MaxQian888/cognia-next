/**
 * Pure geometry helpers for the selection toolbar's align + distribute actions.
 *
 * Both take measured node rects (id + position + size) and return a sparse
 * `{ id: { x, y } }` position map for the nodes that move. The caller feeds the
 * result through `applyAutoLayoutPositions` + `setNodes` so the whole operation
 * lands as a single undo entry (same path auto-layout already uses).
 *
 * Alignment is relative to the selection's bounding box (Figma semantics):
 * left = box left edge, right = box right edge, centerH = box horizontal
 * centre, etc. Distribute keeps the two extreme nodes fixed and equalises the
 * gaps between adjacent edges.
 */

export type AlignOp = "left" | "centerH" | "right" | "top" | "centerV" | "bottom"
export type DistributeAxis = "horizontal" | "vertical"

export interface NodeRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export type PositionMap = Record<string, { x: number; y: number }>

/** Align selected rects to the selection bounding box. Needs ≥2 rects. */
export function computeAlign(rects: readonly NodeRect[], op: AlignOp): PositionMap {
  if (rects.length < 2) return {}
  const minX = Math.min(...rects.map((r) => r.x))
  const maxRight = Math.max(...rects.map((r) => r.x + r.width))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxBottom = Math.max(...rects.map((r) => r.y + r.height))
  const centerX = (minX + maxRight) / 2
  const centerY = (minY + maxBottom) / 2

  const out: PositionMap = {}
  for (const r of rects) {
    switch (op) {
      case "left":
        out[r.id] = { x: minX, y: r.y }
        break
      case "right":
        out[r.id] = { x: maxRight - r.width, y: r.y }
        break
      case "centerH":
        out[r.id] = { x: centerX - r.width / 2, y: r.y }
        break
      case "top":
        out[r.id] = { x: r.x, y: minY }
        break
      case "bottom":
        out[r.id] = { x: r.x, y: maxBottom - r.height }
        break
      case "centerV":
        out[r.id] = { x: r.x, y: centerY - r.height / 2 }
        break
    }
  }
  return out
}

/**
 * Distribute selected rects so the gaps between adjacent edges along the axis
 * are equal. The first and last rect (by position) stay put. Needs ≥3 rects.
 */
export function computeDistribute(rects: readonly NodeRect[], axis: DistributeAxis): PositionMap {
  if (rects.length < 3) return {}
  const out: PositionMap = {}

  if (axis === "horizontal") {
    const sorted = [...rects].sort((a, b) => a.x - b.x)
    const first = sorted[0]!
    const last = sorted[sorted.length - 1]!
    const totalWidth = sorted.reduce((sum, r) => sum + r.width, 0)
    const span = last.x + last.width - first.x
    const gap = (span - totalWidth) / (sorted.length - 1)
    let cursor = first.x
    for (const r of sorted) {
      out[r.id] = { x: cursor, y: r.y }
      cursor += r.width + gap
    }
  } else {
    const sorted = [...rects].sort((a, b) => a.y - b.y)
    const first = sorted[0]!
    const last = sorted[sorted.length - 1]!
    const totalHeight = sorted.reduce((sum, r) => sum + r.height, 0)
    const span = last.y + last.height - first.y
    const gap = (span - totalHeight) / (sorted.length - 1)
    let cursor = first.y
    for (const r of sorted) {
      out[r.id] = { x: r.x, y: cursor }
      cursor += r.height + gap
    }
  }
  return out
}
