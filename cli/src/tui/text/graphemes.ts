/** Unicode grapheme-cluster helpers shared by terminal width and input editing. */

export interface GraphemeSegment {
  segment: string
  index: number
  end: number
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function graphemeSegments(text: string): GraphemeSegment[] {
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({
    segment,
    index,
    end: index + segment.length,
  }))
}

export function previousGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let previous = 0
  for (const grapheme of graphemeSegments(text)) {
    if (grapheme.end >= clamped) return grapheme.index
    previous = grapheme.end
  }
  return previous
}

export function nextGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length))
  for (const grapheme of graphemeSegments(text)) {
    if (grapheme.end > clamped) return grapheme.end
  }
  return text.length
}

/** Snap an arbitrary UTF-16 offset backward to the containing cluster's start. */
export function snapToGraphemeBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length))
  if (clamped === text.length) return clamped
  for (const grapheme of graphemeSegments(text)) {
    if (clamped <= grapheme.index) return grapheme.index
    if (clamped < grapheme.end) return grapheme.index
  }
  return text.length
}
