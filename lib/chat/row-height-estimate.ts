/**
 * Height estimate for one chat row, used by the TanStack virtualizer in
 * `components/chat/message-list.tsx` before a row has been measured.
 *
 * Why this is not a constant. The virtualizer sized every un-measured row at a
 * flat 200px. A prose turn is close to that; a turn carrying three screenshots
 * is nearer 1000px, and a 200-line code fence is several thousand. The gap is
 * paid as scroll drift: the scrollbar reports a total built from 200px rows,
 * then every row that scrolls into view corrects itself and shoves the content
 * under the user's cursor. The further you scroll through an image-heavy
 * session, the worse it gets.
 *
 * Accuracy is not the goal — *stability* is. An estimate within a couple of
 * hundred pixels keeps the scroll position from lurching; `measureElement`
 * still supplies the truth as soon as the row mounts.
 *
 * Deliberately width-agnostic. The reading column is `max-w-[52rem]` on desktop
 * and viewport-wide on mobile, and threading a live width in would make the
 * estimate a function of layout state the virtualizer reads before layout
 * exists. The constants below are tuned for the desktop column; a narrower
 * column under-estimates prose, which is the harmless direction (rows grow on
 * measure rather than collapsing).
 */

/** Avatar row, sender name, action bar and the row's vertical margins. */
export const ROW_CHROME_PX = 76
export const TEXT_LINE_PX = 22
/** Characters per rendered line in the desktop reading column. */
export const CHARS_PER_LINE = 90
/** A markdown `![](…)` image, rendered inline at the column's width. */
export const IMAGE_BOX_PX = 320
/**
 * Image `file` parts render through `MessageImageGallery`, whose geometry is
 * fixed rather than column-relative: one image is `w-fit max-w-sm max-h-72`
 * (≤288px tall), several tile `grid-cols-2 gap-1.5` inside `max-w-sm` (24rem),
 * so each cell is (384−6)/2 = 189px square and a row pitches 195px.
 *
 * A two-image gallery really is shorter than a one-image one — squares in a
 * half-width column beat a single 288px-tall frame.
 */
export const GALLERY_SINGLE_PX = 288
export const GALLERY_ROW_PX = 195
export const MERMAID_BOX_PX = 280
export const A2UI_BOX_PX = 220
export const MATH_BLOCK_PX = 64
export const CODE_LINE_PX = 20
/** Code fence header, padding and border. */
export const CODE_CHROME_PX = 44
export const TABLE_ROW_PX = 37
export const TOOL_CARD_PX = 92
export const REASONING_CHROME_PX = 40
export const UNKNOWN_PART_PX = 48
/** Used when a message has no parts we recognise at all. */
export const FALLBACK_ROW_PX = 200
/**
 * A single wrong estimate that is wildly too large destabilises the scrollbar
 * more than one that is too small, because the correction on measure is a
 * downward jump. Cap it.
 */
export const MAX_ROW_PX = 6000

interface EstimatablePart {
  type?: string
  text?: string
  url?: string
  mediaType?: string
}

interface EstimatableMessage {
  parts?: readonly EstimatablePart[]
}

/**
 * Estimates are pure in `parts`, and `parts` is a stable reference for any
 * finalized message, so one walk per message is enough for the life of the
 * list. Keyed on the array itself so the entry dies with the message — no
 * eviction policy to get wrong.
 */
const cache = new WeakMap<object, number>()

/** Height estimate in px for a non-streaming row. */
export function estimateMessageHeight(message: EstimatableMessage): number {
  const parts = message.parts
  if (!parts || parts.length === 0) return FALLBACK_ROW_PX
  const cached = cache.get(parts)
  if (cached !== undefined) return cached
  const estimate = computeMessageHeight(parts)
  cache.set(parts, estimate)
  return estimate
}

function computeMessageHeight(parts: readonly EstimatablePart[]): number {
  let total = ROW_CHROME_PX
  // Image `file` parts do not stack — MessageRenderer collects them into one
  // gallery — so they are counted across the whole message, not per part.
  let imageParts = 0

  for (const part of parts) {
    const type = part.type
    if (type === "text") {
      total += estimateMarkdownHeight(part.text ?? "")
    } else if (type === "reasoning") {
      total += REASONING_CHROME_PX + estimateMarkdownHeight(part.text ?? "")
    } else if (type === "file") {
      if (part.mediaType?.startsWith("image/") && part.url) imageParts += 1
      else total += UNKNOWN_PART_PX
    } else if (type?.startsWith("tool-")) {
      total += TOOL_CARD_PX
    } else if (type) {
      total += UNKNOWN_PART_PX
    }
  }

  total += galleryHeight(imageParts)
  return Math.min(MAX_ROW_PX, Math.max(FALLBACK_ROW_PX, Math.round(total)))
}

/** One image renders on its own; several tile into a 2-column grid. */
export function galleryHeight(count: number): number {
  if (count <= 0) return 0
  if (count === 1) return GALLERY_SINGLE_PX
  return Math.ceil(count / 2) * GALLERY_ROW_PX
}

/**
 * Single-pass line scan. Cheap and predictable — no markdown parse, no regex
 * backtracking over the whole body — because this runs for every un-measured
 * row on every virtualizer measure pass.
 *
 * An unterminated fence is scored as if it closed at the end of the text,
 * which is what a mid-stream turn looks like.
 */
export function estimateMarkdownHeight(text: string): number {
  if (!text) return 0
  let total = 0
  let proseLines = 0
  let fenceLanguage: string | null = null
  let fenceLines = 0
  let tableRows = 0

  const flushTable = () => {
    if (tableRows > 0) {
      total += tableRows * TABLE_ROW_PX
      tableRows = 0
    }
  }

  for (const line of text.split("\n")) {
    const fence = /^\s*```(\S*)/.exec(line)
    if (fence) {
      if (fenceLanguage === null) {
        flushTable()
        fenceLanguage = fence[1] ?? ""
        fenceLines = 0
      } else {
        total += fenceHeight(fenceLanguage, fenceLines)
        fenceLanguage = null
      }
      continue
    }
    if (fenceLanguage !== null) {
      fenceLines += 1
      continue
    }
    if (/^\s*\|/.test(line)) {
      tableRows += 1
      continue
    }
    flushTable()

    const images = countMarkdownImages(line)
    if (images > 0) {
      total += images * IMAGE_BOX_PX
      continue
    }
    // A blank line is paragraph spacing, not a full line of text.
    proseLines += line.trim() === "" ? 0.5 : Math.max(1, Math.ceil(line.length / CHARS_PER_LINE))
  }

  if (fenceLanguage !== null) total += fenceHeight(fenceLanguage, fenceLines)
  flushTable()
  return total + proseLines * TEXT_LINE_PX
}

/** Fenced blocks that render as something other than a code listing. */
export function fenceHeight(language: string, lines: number): number {
  const lang = language.toLowerCase()
  if (lang === "mermaid") return MERMAID_BOX_PX
  if (lang === "a2ui") return A2UI_BOX_PX
  if (lang === "math") return MATH_BLOCK_PX
  return CODE_CHROME_PX + lines * CODE_LINE_PX
}

/** `![alt](src)` occurrences on one line, ignoring plain `[text](href)` links. */
export function countMarkdownImages(line: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = line.indexOf("![", from)
    if (at === -1) return count
    const close = line.indexOf("](", at)
    if (close === -1) return count
    count += 1
    from = close + 2
  }
}
