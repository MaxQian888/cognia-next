/**
 * Pure formatter for the inline compaction-boundary notice the TUI renders when
 * the context is compacted (auto threshold or a manual `/compact`). Reuses the
 * footer's token humanizer (`formatTokens`) so the figures match the rest of the
 * UI. Kept tiny + pure so the reducer can stay declarative and unit-tested.
 */
import { formatTokens } from "./usage"

/**
 * One-line summary of a compaction boundary, e.g.
 * `⊟ Context compacted (manual): 45.0k → 8.0k tokens (−82%)`.
 * The percentage is omitted when `preTokens` is 0 (unknown), so we never print a
 * misleading `−100%` / `NaN%`.
 */
export function formatCompactBoundary(
  trigger: "manual" | "auto",
  preTokens: number,
  postTokens: number
): string {
  const head = `⊟ Context compacted (${trigger}): ${formatTokens(preTokens)} → ${formatTokens(
    postTokens
  )} tokens`
  if (preTokens > 0 && postTokens >= 0 && postTokens <= preTokens) {
    const pct = Math.round(((preTokens - postTokens) / preTokens) * 100)
    return `${head} (−${pct}%)`
  }
  return head
}
