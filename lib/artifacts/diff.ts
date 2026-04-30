/**
 * Diff algorithm for artifact version comparison
 * Simple LCS-based line diff (no external dependency)
 */

import type { DiffLine, DiffStats } from "@/types"

/**
 * Compute line-based diff using LCS (Longest Common Subsequence)
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  const m = oldLines.length
  const n = newLines.length

  // Guard: fall back to simple diff for very large inputs to prevent browser freeze
  if (m * n > 1_000_000) {
    const result: DiffLine[] = []
    oldLines.forEach((line, i) =>
      result.push({ type: "removed", content: line, oldLineNum: i + 1 })
    )
    newLines.forEach((line, i) => result.push({ type: "added", content: line, newLineNum: i + 1 }))
    return result
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to find diff
  const result: DiffLine[] = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({
        type: "unchanged",
        content: oldLines[i - 1],
        oldLineNum: i,
        newLineNum: j,
      })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({
        type: "added",
        content: newLines[j - 1],
        newLineNum: j,
      })
      j--
    } else {
      result.unshift({
        type: "removed",
        content: oldLines[i - 1],
        oldLineNum: i,
      })
      i--
    }
  }

  return result
}

/**
 * Compute diff statistics from a diff result
 */
export function computeDiffStats(diff: DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  for (const line of diff) {
    if (line.type === "added") added++
    if (line.type === "removed") removed++
  }
  return { added, removed }
}
