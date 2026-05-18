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

// (A6) Per-anchor entry in the sorted index. Stored by axis value so the
// inner loop can binary-search the matching range [target-tol, target+tol]
// instead of scanning every peer.
interface VerticalAnchorEntry {
  axis: number
  peer: RectLike
}

interface HorizontalAnchorEntry {
  axis: number
  peer: RectLike
}

/**
 * Pre-built alignment index. Cache one of these per drag (the peer set
 * doesn't change while a single node is being moved), then call
 * `computeAlignmentGuides(dragged, index)` on every rAF tick to avoid the
 * O(n) build cost per frame.
 *
 * The internal arrays are sorted by axis value so query is O(log n + k)
 * via binary search.
 */
export interface AlignmentIndex {
  /** All vertical anchors (left/center/right of each peer) sorted by `axis`. */
  vertical: ReadonlyArray<VerticalAnchorEntry>
  /** All horizontal anchors (top/middle/bottom of each peer) sorted by `axis`. */
  horizontal: ReadonlyArray<HorizontalAnchorEntry>
}

/**
 * Build an `AlignmentIndex` once. Cost is O(n log n) and amortised over
 * the lifetime of a drag.
 */
export function buildAlignmentIndex(peers: ReadonlyArray<RectLike>): AlignmentIndex {
  const vertical: VerticalAnchorEntry[] = []
  const horizontal: HorizontalAnchorEntry[] = []
  for (const peer of peers) {
    vertical.push({ axis: peer.x, peer })
    vertical.push({ axis: peer.x + peer.width / 2, peer })
    vertical.push({ axis: peer.x + peer.width, peer })
    horizontal.push({ axis: peer.y, peer })
    horizontal.push({ axis: peer.y + peer.height / 2, peer })
    horizontal.push({ axis: peer.y + peer.height, peer })
  }
  vertical.sort((a, b) => a.axis - b.axis)
  horizontal.sort((a, b) => a.axis - b.axis)
  return { vertical, horizontal }
}

/**
 * Binary search for the first index whose `axis >= target`. Returns
 * `arr.length` if no such index exists.
 */
function lowerBound<T extends { axis: number }>(arr: ReadonlyArray<T>, target: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid].axis < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function isAlignmentIndex(v: unknown): v is AlignmentIndex {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as AlignmentIndex).vertical) &&
    Array.isArray((v as AlignmentIndex).horizontal)
  )
}

/**
 * Compute alignment guides for `dragged` against either a list of peers OR
 * a pre-built `AlignmentIndex`.
 *
 * - Returns at most ONE vertical guide per `source` axis (the closest
 *   peer wins for that axis), so the canvas doesn't render a forest.
 * - `snap.dx` / `snap.dy` is the smallest signed delta that aligns the
 *   dragged rect to one of the matched guides — apply when the user wants
 *   snap-on-drag.
 *
 * Passing an `AlignmentIndex` is preferred during a drag (build the index
 * once at drag-start; query 6 anchors per rAF tick at O(log n + k) each).
 * Passing a plain peer array is fine for one-shot calls and keeps the
 * pure-function ergonomics for tests.
 */
export function computeAlignmentGuides(
  dragged: RectLike,
  peersOrIndex: ReadonlyArray<RectLike> | AlignmentIndex,
  tolerance: number = DEFAULT_TOLERANCE
): GuidesResult {
  const index = isAlignmentIndex(peersOrIndex) ? peersOrIndex : buildAlignmentIndex(peersOrIndex)

  const vertical: VerticalGuide[] = []
  const horizontal: HorizontalGuide[] = []
  let snapDx = 0
  let snapDy = 0
  let bestVerticalDist = Infinity
  let bestHorizontalDist = Infinity

  const draggedV = verticalAnchors(dragged)
  const draggedH = horizontalAnchors(dragged)

  const bestPerVerticalSource = new Map<
    VerticalGuide["source"],
    { guide: VerticalGuide; dist: number; delta: number }
  >()
  const bestPerHorizontalSource = new Map<
    HorizontalGuide["source"],
    { guide: HorizontalGuide; dist: number; delta: number }
  >()

  for (const da of draggedV) {
    // Binary-search the sorted vertical anchors for the range
    // [da.axis - tolerance, da.axis + tolerance]; only those can match.
    const lo = da.axis - tolerance
    const hi = da.axis + tolerance
    const startIdx = lowerBound(index.vertical, lo)
    for (let i = startIdx; i < index.vertical.length; i++) {
      const entry = index.vertical[i]
      if (entry.axis > hi) break
      const peer = entry.peer
      if (peer.id === dragged.id) continue
      const dist = Math.abs(da.axis - entry.axis)
      const guide: VerticalGuide = {
        x: entry.axis,
        yStart: Math.min(dragged.y, peer.y),
        yEnd: Math.max(dragged.y + dragged.height, peer.y + peer.height),
        source: da.kind,
        peerId: peer.id,
      }
      const delta = entry.axis - da.axis
      const prev = bestPerVerticalSource.get(da.kind)
      if (!prev || dist < prev.dist) {
        bestPerVerticalSource.set(da.kind, { guide, dist, delta })
      }
    }
  }

  for (const da of draggedH) {
    const lo = da.axis - tolerance
    const hi = da.axis + tolerance
    const startIdx = lowerBound(index.horizontal, lo)
    for (let i = startIdx; i < index.horizontal.length; i++) {
      const entry = index.horizontal[i]
      if (entry.axis > hi) break
      const peer = entry.peer
      if (peer.id === dragged.id) continue
      const dist = Math.abs(da.axis - entry.axis)
      const guide: HorizontalGuide = {
        y: entry.axis,
        xStart: Math.min(dragged.x, peer.x),
        xEnd: Math.max(dragged.x + dragged.width, peer.x + peer.width),
        source: da.kind,
        peerId: peer.id,
      }
      const delta = entry.axis - da.axis
      const prev = bestPerHorizontalSource.get(da.kind)
      if (!prev || dist < prev.dist) {
        bestPerHorizontalSource.set(da.kind, { guide, dist, delta })
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
