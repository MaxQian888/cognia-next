/**
 * Pure view-model for the `@` mention popup. The composer owns the highlighted
 * index (over the flattened candidate list); this module turns that into a
 * fixed-shape, windowed view so the popup NEVER changes height while the user
 * navigates with ↑/↓ (or the wheel).
 *
 * The instability the old palette suffered came from two sources: group-header
 * lines that appeared/disappeared as the window slid, and `↑/↓ more` indicator
 * lines that toggled on and off. Both shifted the composer below — and a long
 * list could push it off-screen entirely. Here:
 *
 *   - Each row self-identifies its kind with a leading glyph, so there are no
 *     separate header lines to appear/vanish.
 *   - The visible row count is `min(rows, candidates.length)` — constant while
 *     navigating (the candidate count only changes when the query changes), so
 *     the height is stable across ↑/↓.
 *   - The component renders the `↑/↓ more` indicators and the preview line as
 *     FIXED slots (blank when empty), so they never change the height either.
 *
 * Ink-free + deterministic, so the windowing math unit-tests without a render.
 */
import { windowList } from "./list-window"
import type { MentionCandidate } from "../mention/types"

/** One rendered line of the windowed candidate body. */
export interface MentionViewRow {
  cand: MentionCandidate
  /** Index into the flattened candidate list. */
  index: number
  selected: boolean
}

export interface MentionView {
  /** The visible candidate rows (length `min(rows, candidates.length)`). */
  rows: MentionViewRow[]
  /** Hidden candidates above / below the window (drive the `↑/↓ more` slots). */
  above: number
  below: number
  /** The highlighted candidate, surfaced for the fixed preview line. */
  preview: MentionCandidate | null
}

/**
 * Window `candidates` around `index`, showing at most `rows` rows and keeping the
 * highlighted candidate on-screen. Returns a constant-shaped view: the row count
 * is `min(rows, length)` and only changes when the candidate list itself changes,
 * so stepping through with ↑/↓ never resizes the popup.
 */
export function buildMentionView(
  candidates: MentionCandidate[],
  index: number,
  rows: number
): MentionView {
  if (candidates.length === 0 || rows <= 0) {
    return { rows: [], above: 0, below: 0, preview: null }
  }
  const clamped = Math.max(0, Math.min(index, candidates.length - 1))
  const win = windowList(candidates.length, clamped, rows)
  const visible = candidates.slice(win.start, win.end).map((cand, i) => ({
    cand,
    index: win.start + i,
    selected: win.start + i === clamped,
  }))
  return { rows: visible, above: win.above, below: win.below, preview: candidates[clamped] }
}

/** Per-kind glyph shown at the head of every row (replaces group headers). */
export const MENTION_GLYPH: Record<MentionCandidate["kind"], string> = {
  file: "📁",
  skill: "🛠",
  agent: "🤖",
}

/**
 * The muted metadata segment shown after a skill's name: origin · category ·
 * `used N×`. Mirrors the `/skill` panel's `skillRowHint` so the two surfaces read
 * the same. Empty for files/agents (and skills with nothing to add).
 */
export function mentionRowMeta(cand: MentionCandidate): string {
  if (cand.kind !== "skill") return ""
  const parts: string[] = []
  if (cand.origin) parts.push(cand.origin)
  if (cand.category && cand.category !== "custom") parts.push(cand.category)
  if (cand.usageCount && cand.usageCount > 0) parts.push(`used ${cand.usageCount}×`)
  return parts.join(" · ")
}
