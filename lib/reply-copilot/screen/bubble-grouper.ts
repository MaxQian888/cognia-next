/**
 * Turn the OCR lines of one chat window into message bubbles (ADR-0194 §8).
 *
 * Pure geometry, no app APIs: the desktop copilot reads other apps' windows
 * only as pixels, so everything here is inferred from where text sits.
 *
 * 1. **Pane.** When the focused element is the app's message composer (the
 *    usual case: the user pressed the shortcut while typing), its horizontal
 *    extent IS the conversation pane, and its top edge is where the input area
 *    starts. That rules out the conversation list beside the pane, which no
 *    fixed band can. Otherwise the whole window is the pane, minus a header
 *    band at the top and an input band at the bottom.
 * 2. **Noise.** Timestamps, symbol-only fragments and centered system lines
 *    ("以下为新消息", "You recalled a message") are dropped; a real message is
 *    anchored to one side, never centered.
 * 3. **Side.** A line hugging the pane's left edge is the other person's, one
 *    hugging the right edge is the user's; a line whose margins are too close
 *    to call is `unknown` (Jarvis 1.3: an unsided turn beats a wrong one).
 * 4. **Bubbles.** Consecutive lines on the same side, left-aligned and closer
 *    than a line gap, are one message. A smaller line directly above another
 *    person's bubble is a group-chat sender name, kept apart as `speaker`.
 */

import type { ChatLayout } from "./chat-apps"

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenLine {
  text: string
  bbox: ScreenRect
}

export type BubbleSide = "me" | "other" | "unknown"

export interface ScreenBubble {
  text: string
  side: BubbleSide
  /** Top edge in frame pixels; bubbles are returned top to bottom. */
  top: number
  /** Group-chat sender name read above the bubble, when there was one. */
  speaker: string | null
}

export interface ChatPane {
  left: number
  right: number
  top: number
  bottom: number
  source: "composer" | "window"
}

export interface GroupedScreen {
  bubbles: ScreenBubble[]
  /** The conversation title read from the header band, when one was legible. */
  header: string | null
  pane: ChatPane
  dropped: { outside: number; timestamps: number; system: number }
}

export interface GroupInput {
  lines: readonly ScreenLine[]
  frame: { width: number; height: number }
  /** Focused composer in frame pixels, when the focus was a text input. */
  composer?: ScreenRect | null
  layout: ChatLayout
}

/** Fraction of the frame treated as the title bar / chat header. */
export const HEADER_BAND = 0.08
/** Fraction treated as the input area when no composer was focused. */
export const INPUT_BAND = 0.2
/** Margin asymmetry (fraction of pane width) needed to call a side. */
export const SIDE_MARGIN = 0.04
/** A line centered within this fraction of the pane is a system line… */
export const CENTER_BAND = 0.06
/** …unless it is wider than this fraction (a long message fills the pane). */
export const SYSTEM_MAX_WIDTH = 0.6
/** Lines closer than this many median line heights belong to one bubble. */
export const LINE_GAP = 0.6
/** Left edges within this fraction of the pane width are aligned. */
export const ALIGN_TOLERANCE = 0.03
/** A line shorter than this share of the median height reads as a name label. */
export const LABEL_HEIGHT = 0.82

const TIMESTAMP_PATTERNS: readonly RegExp[] = [
  /^\d{1,2}[:：]\d{2}([:：]\d{2})?(\s?[AaPp]\.?[Mm]\.?)?$/,
  /^(上午|下午|晚上|凌晨|中午|早上|傍晚)\s*\d{1,2}[:：]\d{2}$/,
  /^(昨天|今天|前天|星期[一二三四五六日天]|周[一二三四五六日天])(\s*(上午|下午|晚上|凌晨|中午|早上|傍晚)?\s*\d{1,2}[:：]\d{2})?$/,
  /^(yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\.?(,?\s+\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?)?$/i,
  /^\d{4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}\s*日?(\s+.*\d{1,2}[:：]\d{2}.*)?$/,
  /^\d{1,2}\s*月\s*\d{1,2}\s*日(\s+.*)?$/,
  /^\d{1,2}\/\d{1,2}(\/\d{2,4})?(,?\s+\d{1,2}:\d{2}(\s?[AaPp][Mm])?)?$/,
]

const MEANINGFUL = /[\p{L}\p{N}]/u
const CJK_EDGE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/
const MEMBER_COUNT = /\s*[(（]\s*\d+\s*[)）]\s*$/

export function isTimestampLine(text: string): boolean {
  const value = text.trim()
  return TIMESTAMP_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * The conversation pane. A composer only counts when it is plausibly the
 * message input: wide enough to span a pane and in the lower part of the
 * window (a focused search field at the top must not define the pane).
 */
export function resolvePane(
  frame: GroupInput["frame"],
  composer: ScreenRect | null | undefined
): ChatPane {
  const top = frame.height * HEADER_BAND
  if (
    composer &&
    composer.width >= frame.width * 0.25 &&
    composer.y >= frame.height * 0.4 &&
    composer.y < frame.height &&
    composer.x >= 0 &&
    composer.x + composer.width <= frame.width + 1
  ) {
    return {
      left: composer.x,
      right: composer.x + composer.width,
      top,
      bottom: composer.y,
      source: "composer",
    }
  }
  return {
    left: 0,
    right: frame.width,
    top,
    bottom: frame.height * (1 - INPUT_BAND),
    source: "window",
  }
}

function centerX(rect: ScreenRect): number {
  return rect.x + rect.width / 2
}

function centerY(rect: ScreenRect): number {
  return rect.y + rect.height / 2
}

function paneWidth(pane: ChatPane): number {
  return Math.max(1, pane.right - pane.left)
}

export function sideOfLine(rect: ScreenRect, pane: ChatPane, layout: ChatLayout): BubbleSide {
  if (layout === "single_column") return "unknown"
  const leftGap = rect.x - pane.left
  const rightGap = pane.right - (rect.x + rect.width)
  const asymmetry = (rightGap - leftGap) / paneWidth(pane)
  if (asymmetry >= SIDE_MARGIN) return "other"
  if (asymmetry <= -SIDE_MARGIN) return "me"
  return "unknown"
}

function isCenteredSystemLine(rect: ScreenRect, pane: ChatPane): boolean {
  const width = paneWidth(pane)
  const middle = (pane.left + pane.right) / 2
  return (
    Math.abs(centerX(rect) - middle) <= width * CENTER_BAND &&
    rect.width <= width * SYSTEM_MAX_WIDTH
  )
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function joinLines(a: string, b: string): string {
  return CJK_EDGE.test(a.at(-1) ?? "") && CJK_EDGE.test(b[0] ?? "") ? a + b : `${a} ${b}`
}

function readHeader(lines: readonly ScreenLine[], pane: ChatPane): string | null {
  const candidates = lines.filter(
    (line) =>
      centerY(line.bbox) < pane.top &&
      centerX(line.bbox) >= pane.left &&
      centerX(line.bbox) <= pane.right &&
      MEANINGFUL.test(line.text) &&
      !isTimestampLine(line.text)
  )
  if (candidates.length === 0) return null
  const tallest = candidates.reduce((best, line) =>
    line.bbox.height > best.bbox.height ||
    (line.bbox.height === best.bbox.height && line.bbox.x < best.bbox.x)
      ? line
      : best
  )
  const title = tallest.text.replace(MEMBER_COUNT, "").trim()
  return title || null
}

interface WorkingBubble {
  lines: ScreenLine[]
  side: BubbleSide
  left: number
  bottom: number
}

export function groupBubbles(input: GroupInput): GroupedScreen {
  const pane = resolvePane(input.frame, input.composer)
  const width = paneWidth(pane)
  const dropped = { outside: 0, timestamps: 0, system: 0 }

  const kept: ScreenLine[] = []
  for (const raw of input.lines) {
    const text = raw.text.replace(/\s+/g, " ").trim()
    if (!text) continue
    const line = { text, bbox: raw.bbox }
    const cx = centerX(line.bbox)
    const cy = centerY(line.bbox)
    if (cx < pane.left || cx > pane.right || cy < pane.top || cy > pane.bottom) {
      dropped.outside += 1
      continue
    }
    if (isTimestampLine(text)) {
      dropped.timestamps += 1
      continue
    }
    if (!MEANINGFUL.test(text) || isCenteredSystemLine(line.bbox, pane)) {
      dropped.system += 1
      continue
    }
    kept.push(line)
  }

  kept.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
  const lineHeight = median(kept.map((line) => line.bbox.height)) || 1

  const working: WorkingBubble[] = []
  for (const line of kept) {
    const side = sideOfLine(line.bbox, pane, input.layout)
    const last = working.at(-1)
    if (
      last &&
      last.side === side &&
      line.bbox.y - last.bottom <= lineHeight * LINE_GAP &&
      Math.abs(line.bbox.x - last.left) <= width * ALIGN_TOLERANCE
    ) {
      last.lines.push(line)
      last.bottom = Math.max(last.bottom, line.bbox.y + line.bbox.height)
      continue
    }
    working.push({ lines: [line], side, left: line.bbox.x, bottom: line.bbox.y + line.bbox.height })
  }

  const isSmall = (line: ScreenLine) => line.bbox.height < lineHeight * LABEL_HEIGHT
  // A name sits a little apart from the text under it (the bubble's padding);
  // lines inside one bubble are tighter.
  const apart = (upper: ScreenLine, lower: ScreenLine) =>
    lower.bbox.y - (upper.bbox.y + upper.bbox.height) > lineHeight * 0.25
  // A lone small line is a name only when another person's bubble follows,
  // aligned and close. Otherwise it is a short message ("ok" has no ascenders
  // and reads shorter than a CJK line) and must be kept as one.
  const labels = (bubble: WorkingBubble, next: WorkingBubble | undefined) =>
    bubble.side === "other" &&
    bubble.lines.length === 1 &&
    isSmall(bubble.lines[0]) &&
    next !== undefined &&
    next.side === "other" &&
    Math.abs(next.left - bubble.left) <= width * ALIGN_TOLERANCE * 2 &&
    next.lines[0].bbox.y - bubble.bottom <= lineHeight * 1.5

  const bubbles: ScreenBubble[] = []
  for (let index = 0; index < working.length; index += 1) {
    const bubble = working[index]
    const previous = index > 0 ? working[index - 1] : undefined
    if (labels(bubble, working[index + 1])) continue

    let lines = bubble.lines
    let speaker: string | null = null
    if (previous && labels(previous, bubble)) {
      speaker = previous.lines[0].text
    } else if (
      bubble.side === "other" &&
      lines.length > 1 &&
      isSmall(lines[0]) &&
      !lines.slice(1).some(isSmall) &&
      apart(lines[0], lines[1])
    ) {
      speaker = lines[0].text
      lines = lines.slice(1)
    }

    bubbles.push({
      text: lines.map((line) => line.text).reduce(joinLines),
      side: bubble.side,
      top: lines[0].bbox.y,
      speaker,
    })
  }

  return { bubbles, header: readHeader(input.lines, pane), pane, dropped }
}
