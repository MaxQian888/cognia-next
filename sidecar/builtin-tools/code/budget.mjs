// Adaptive output budgeting for code-graph context/explore results.
//
// Ported from codegraph's "adaptive output budgeting": the character budget
// scales with project size (more context for big repos where exploration is
// costly, tighter for small ones), and packing drops WHOLE snippets (methods /
// files) rather than truncating mid-method — a half-printed function is worse
// than an omitted one. The drop list is surfaced so the agent knows what was
// withheld and can request it explicitly.

/**
 * @typedef {{ maxOutputChars: number, maxCharsPerFile: number }} OutputBudget
 */

/**
 * Compute the output budget for a project of `fileCount` indexed files.
 * Step function (not continuous) so identical projects serialize identically.
 * @param {number} fileCount
 * @returns {OutputBudget}
 */
export function computeBudget(fileCount) {
  const n = Number.isFinite(fileCount) && fileCount > 0 ? fileCount : 0
  let maxOutputChars
  if (n <= 100) maxOutputChars = 24000
  else if (n <= 1000) maxOutputChars = 18000
  else if (n <= 5000) maxOutputChars = 13000
  else maxOutputChars = 9000
  // Per-file cap keeps one huge file from eating the whole budget; clamped so a
  // single large-but-relevant symbol can still appear in small projects.
  const maxCharsPerFile = clamp(Math.floor(maxOutputChars / 3), 1500, 7000)
  return { maxOutputChars, maxCharsPerFile }
}

/**
 * @typedef {{ id?: string, file?: string, text: string }} Snippet
 * @typedef {{ id?: string, file?: string, chars: number, reason: "too-large" | "budget" }} Dropped
 */

/**
 * Pack snippets under a budget, preserving caller-supplied priority order.
 * Never truncates a snippet: a snippet larger than the per-file cap is dropped
 * whole (`too-large`); once the running total can't fit a snippet it is dropped
 * (`budget`) but smaller later snippets are still considered.
 *
 * @param {Snippet[]} items   priority-ordered snippets (most relevant first)
 * @param {OutputBudget} budget
 * @returns {{ kept: Snippet[], dropped: Dropped[], usedChars: number }}
 */
export function packSnippets(items, budget) {
  const kept = []
  const dropped = []
  let used = 0
  const list = Array.isArray(items) ? items : []
  const { maxOutputChars, maxCharsPerFile } = budget
  for (const item of list) {
    const text = typeof item?.text === "string" ? item.text : ""
    const len = text.length
    if (len > maxCharsPerFile) {
      dropped.push({ id: item.id, file: item.file, chars: len, reason: "too-large" })
      continue
    }
    if (used + len > maxOutputChars) {
      dropped.push({ id: item.id, file: item.file, chars: len, reason: "budget" })
      continue
    }
    kept.push(item)
    used += len
  }
  return { kept, dropped, usedChars: used }
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value))
}
