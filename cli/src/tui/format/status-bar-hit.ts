/**
 * Hit-testing for the persistent status footer: map a clicked display column to
 * the {@link StatusSegment} rendered under it. The {@link Footer} draws the
 * fitted segments joined by the ` · ` separator (display width 3); this walks
 * that exact layout so App can turn a footer click into the right action
 * (clicking the model segment opens the model picker, the mode segment cycles
 * the permission mode, the thinking segment opens the effort slider). Pure →
 * unit-tested without a terminal.
 */
import { stringWidth } from "../markdown/width"
import type { StatusSegment } from "../../config/schema"
import type { StatusSegmentView } from "./status-bar"

/** Display width of the ` · ` separator the Footer renders between segments. */
export const FOOTER_SEP_WIDTH = 3

/**
 * The id of the segment under display column `col` (0-based, measured from the
 * first segment's first cell), or null when the click lands on a separator gap,
 * before the first segment, or past the last one. CJK-aware via
 * {@link stringWidth} so a wide-glyph segment maps its full cell span.
 */
export function segmentAtColumn(segments: StatusSegmentView[], col: number): StatusSegment | null {
  if (col < 0) return null
  let start = 0
  for (let i = 0; i < segments.length; i++) {
    const width = stringWidth(segments[i].text)
    if (col >= start && col < start + width) return segments[i].id
    start += width
    // A separator follows every segment except the last; its cells are dead.
    if (i < segments.length - 1) start += FOOTER_SEP_WIDTH
  }
  return null
}
