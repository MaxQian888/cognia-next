export interface TimelineMarker {
  key: string
  position: number
  representativeIndex: number
  isActive: boolean
  isBookmarked: boolean
}

interface BuildTimelineMarkersOptions {
  count: number
  positions: number[]
  activeIndex: number
  bookmarkedIndices: ReadonlySet<number>
  maxMarkers: number
}

function fallbackPosition(index: number, count: number): number {
  return count <= 1 ? 0 : index / (count - 1)
}

function markerPosition(index: number, count: number, positions: number[]): number {
  const measured = positions.length === count ? positions[index] : undefined
  if (typeof measured !== "number" || !Number.isFinite(measured)) {
    return fallbackPosition(index, count)
  }
  return Math.max(0, Math.min(1, measured))
}

/**
 * Collapse an arbitrarily dense set of turns into a fixed number of visual
 * rail markers. Highlight state is aggregated per bucket, so active and
 * bookmarked turns remain visible without allowing the DOM to grow with the
 * conversation.
 */
export function buildTimelineMarkers({
  count,
  positions,
  activeIndex,
  bookmarkedIndices,
  maxMarkers,
}: BuildTimelineMarkersOptions): TimelineMarker[] {
  if (count <= 0 || maxMarkers <= 0) return []

  if (count <= maxMarkers) {
    return Array.from({ length: count }, (_, index) => ({
      key: String(index),
      position: markerPosition(index, count, positions),
      representativeIndex: index,
      isActive: index === activeIndex,
      isBookmarked: bookmarkedIndices.has(index),
    }))
  }

  const bookmarkedBuckets = new Set<number>()
  for (const index of bookmarkedIndices) {
    if (index < 0 || index >= count) continue
    bookmarkedBuckets.add(Math.min(maxMarkers - 1, Math.floor((index * maxMarkers) / count)))
  }
  const activeBucket =
    activeIndex >= 0 && activeIndex < count
      ? Math.min(maxMarkers - 1, Math.floor((activeIndex * maxMarkers) / count))
      : -1

  return Array.from({ length: maxMarkers }, (_, bucket) => {
    const start = Math.floor((bucket * count) / maxMarkers)
    const end = Math.max(start, Math.floor(((bucket + 1) * count) / maxMarkers) - 1)
    const isFirst = bucket === 0
    const isLast = bucket === maxMarkers - 1
    const representativeIndex = isFirst ? 0 : isLast ? count - 1 : Math.round((start + end) / 2)
    return {
      key: `${start}-${end}`,
      position: markerPosition(representativeIndex, count, positions),
      representativeIndex,
      isActive: bucket === activeBucket,
      isBookmarked: bookmarkedBuckets.has(bucket),
    }
  })
}
