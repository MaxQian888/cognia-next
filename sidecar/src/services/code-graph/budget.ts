// Adaptive output budgeting for code-graph context/explore results.
//
// Ported from codegraph's "adaptive output budgeting": the character budget
// scales with project size (more context for big repos where exploration is
// costly, tighter for small ones), and packing drops WHOLE snippets (methods /
// files) rather than truncating mid-method — a half-printed function is worse
// than an omitted one. The drop list is surfaced so the agent knows what was
// withheld and can request it explicitly.

export interface OutputBudget {
  maxOutputChars: number
  maxCharsPerFile: number
}

/**
 * Compute the output budget for a project of `fileCount` indexed files.
 * Step function (not continuous) so identical projects serialize identically.
 */
export function computeBudget(fileCount: number): OutputBudget {
  const n = Number.isFinite(fileCount) && fileCount > 0 ? fileCount : 0
  let maxOutputChars: number
  if (n <= 100) maxOutputChars = 24000
  else if (n <= 1000) maxOutputChars = 18000
  else if (n <= 5000) maxOutputChars = 13000
  else maxOutputChars = 9000
  // Per-file cap keeps one huge file from eating the whole budget; clamped so a
  // single large-but-relevant symbol can still appear in small projects.
  const maxCharsPerFile = clamp(Math.floor(maxOutputChars / 3), 1500, 7000)
  return { maxOutputChars, maxCharsPerFile }
}

export interface Snippet {
  id?: string
  file?: string
  text: string
}

export interface Dropped {
  id?: string | undefined
  file?: string | undefined
  chars: number
  reason: "too-large" | "budget"
}

/**
 * Pack priority-ordered snippets (most relevant first) under a budget,
 * preserving that order. Never truncates a snippet: a snippet larger than the
 * per-file cap is dropped whole (`too-large`); once the running total can't
 * fit a snippet it is dropped (`budget`) but smaller later snippets are still
 * considered.
 */
export function packSnippets<S extends Snippet>(
  items: readonly S[] | null | undefined,
  budget: OutputBudget
): { kept: S[]; dropped: Dropped[]; usedChars: number } {
  const kept: S[] = []
  const dropped: Dropped[] = []
  let used = 0
  const list: readonly S[] = Array.isArray(items) ? items : []
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

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}
