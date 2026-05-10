/**
 * Alignment-guide computation. Given a node being dragged plus its peers,
 * return horizontal + vertical guide lines whenever the dragged node's
 * left / center / right (or top / middle / bottom) is within `tolerance`
 * pixels of any peer's matching axis position. Used to render dashed
 * helper lines in the canvas overlay.
 *
 * Pure function — no React, no DOM. Keeps the math testable and the
 * rendering layer thin.
 */

export interface RectLike {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface VerticalGuide {
  /** Flow-space x-coordinate of the line. */
  x: number
  /** y-range covering both the dragged rect and the matching peer. */
  yStart: number
  yEnd: number
  /** Which feature on the dragged rect aligns: left / center / right. */
  source: "left" | "center" | "right"
  /** Peer rect id. */
  peerId: string
}

export interface HorizontalGuide {
  y: number
  xStart: number
  xEnd: number
  source: "top" | "middle" | "bottom"
  peerId: string
}

export interface GuidesResult {
  vertical: VerticalGuide[]
  horizontal: HorizontalGuide[]
  /**
   * Suggested snap deltas (in pixels). Apply to the dragged rect's position
   * so it snaps to the nearest guide. `0` means already aligned.
   */
  snap: { dx: number; dy: number }
}

const DEFAULT_TOLERANCE = 4

/** Extract the three vertical anchors (left, center, right) of a rect. */
function verticalAnchors(rect: RectLike): Array<{ axis: number; kind: VerticalGuide["source"] }> {
  return [
    { axis: rect.x, kind: "left" },
    { axis: rect.x + rect.width / 2, kind: "center" },
    { axis: rect.x + rect.width, kind: "right" },
  ]
}

function horizontalAnchors(
  rect: RectLike
): Array<{ axis: number; kind: HorizontalGuide["source"] }> {
  return [
    { axis: rect.y, kind: "top" },
    { axis: rect.y + rect.height / 2, kind: "middle" },
    { axis: rect.y + rect.height, kind: "bottom" },
  ]
}

/**
 * Compute alignment guides for `dragged` against the given peer rects.
 *
 * - Returns at most ONE vertical guide per `source` axis (the closest
 *   peer wins for that axis), so the canvas doesn't render a forest.
 * - `snap.dx` / `snap.dy` is the smallest signed delta that aligns the
 *   dragged rect to one of the matched guides — apply when the user wants
 *   snap-on-drag.
 */
export function computeAlignmentGuides(
  dragged: RectLike,
  peers: ReadonlyArray<RectLike>,
  tolerance: number = DEFAULT_TOLERANCE
): GuidesResult {
  const vertical: VerticalGuide[] = []
  const horizontal: HorizontalGuide[] = []
  let snapDx = 0
  let snapDy = 0
  let bestVerticalDist = Infinity
  let bestHorizontalDist = Infinity

  const draggedV = verticalAnchors(dragged)
  const draggedH = horizontalAnchors(dragged)

  // Track best-per-source so we don't emit redundant guides.
  const bestPerVerticalSource = new Map<
    VerticalGuide["source"],
    { guide: VerticalGuide; dist: number; delta: number }
  >()
  const bestPerHorizontalSource = new Map<
    HorizontalGuide["source"],
    { guide: HorizontalGuide; dist: number; delta: number }
  >()

  for (const peer of peers) {
    if (peer.id === dragged.id) continue
    const peerV = verticalAnchors(peer)
    const peerH = horizontalAnchors(peer)

    for (const da of draggedV) {
      for (const pa of peerV) {
        const dist = Math.abs(da.axis - pa.axis)
        if (dist > tolerance) continue
        const guide: VerticalGuide = {
          x: pa.axis,
          yStart: Math.min(dragged.y, peer.y),
          yEnd: Math.max(dragged.y + dragged.height, peer.y + peer.height),
          source: da.kind,
          peerId: peer.id,
        }
        const delta = pa.axis - da.axis
        const prev = bestPerVerticalSource.get(da.kind)
        if (!prev || dist < prev.dist) {
          bestPerVerticalSource.set(da.kind, { guide, dist, delta })
        }
      }
    }
    for (const da of draggedH) {
      for (const pa of peerH) {
        const dist = Math.abs(da.axis - pa.axis)
        if (dist > tolerance) continue
        const guide: HorizontalGuide = {
          y: pa.axis,
          xStart: Math.min(dragged.x, peer.x),
          xEnd: Math.max(dragged.x + dragged.width, peer.x + peer.width),
          source: da.kind,
          peerId: peer.id,
        }
        const delta = pa.axis - da.axis
        const prev = bestPerHorizontalSource.get(da.kind)
        if (!prev || dist < prev.dist) {
          bestPerHorizontalSource.set(da.kind, { guide, dist, delta })
        }
      }
    }
  }

  for (const entry of bestPerVerticalSource.values()) {
    vertical.push(entry.guide)
    if (entry.dist < bestVerticalDist) {
      bestVerticalDist = entry.dist
      snapDx = entry.delta
    }
  }
  for (const entry of bestPerHorizontalSource.values()) {
    horizontal.push(entry.guide)
    if (entry.dist < bestHorizontalDist) {
      bestHorizontalDist = entry.dist
      snapDy = entry.delta
    }
  }

  return { vertical, horizontal, snap: { dx: snapDx, dy: snapDy } }
}
