// Human-readable rendering of ast-grep results, grouped by file. Ported from
// oh-my-opencode-slim's `src/tools/ast-grep/utils.ts`.

/** @typedef {import("./run.mjs").SgResult} SgResult */
/** @typedef {import("./run.mjs").SgMatch} SgMatch */

/**
 * @param {SgMatch[]} matches
 * @returns {Map<string, SgMatch[]>}
 */
function groupByFile(matches) {
  const byFile = new Map()
  for (const match of matches) {
    const existing = byFile.get(match.file) ?? []
    existing.push(match)
    byFile.set(match.file, existing)
  }
  return byFile
}

/**
 * @param {SgResult} result
 * @returns {string}
 */
export function formatSearchResult(result) {
  if (result.error) return `Error: ${result.error}`
  if (result.matches.length === 0) return "No matches found."

  const lines = []
  const byFile = groupByFile(result.matches)
  for (const [file, matches] of byFile) {
    lines.push(`\n${file}:`)
    for (const match of matches) {
      const startLine = match.range.start.line + 1
      const text = match.text.length > 100 ? `${match.text.slice(0, 100)}...` : match.text
      lines.push(`  ${startLine}: ${text.replace(/\n/g, "\\n")}`)
    }
  }

  const summary = `Found ${result.totalMatches} matches in ${byFile.size} files`
  lines.push(
    result.truncated ? `\n${summary} (output truncated: ${result.truncatedReason})` : `\n${summary}`
  )
  return lines.join("\n")
}

/**
 * @param {SgResult} result
 * @param {boolean} isDryRun
 * @returns {string}
 */
export function formatReplaceResult(result, isDryRun) {
  if (result.error) return `Error: ${result.error}`
  if (result.matches.length === 0) return "No matches found for replacement."

  const lines = []
  const mode = isDryRun ? "[DRY RUN]" : "[APPLIED]"
  const byFile = groupByFile(result.matches)
  for (const [file, matches] of byFile) {
    lines.push(`\n${file}:`)
    for (const match of matches) {
      const startLine = match.range.start.line + 1
      const original = match.text.length > 60 ? `${match.text.slice(0, 60)}...` : match.text
      const replacement = match.replacement
        ? match.replacement.length > 60
          ? `${match.replacement.slice(0, 60)}...`
          : match.replacement
        : "[no replacement]"
      lines.push(
        `  ${startLine}: ${original.replace(/\n/g, "\\n")} → ${replacement.replace(/\n/g, "\\n")}`
      )
    }
  }

  const verb = isDryRun ? "would change" : "changed"
  const summary = `${mode} ${verb} ${result.totalMatches} matches in ${byFile.size} files`
  lines.push(
    result.truncated ? `\n${summary} (output truncated: ${result.truncatedReason})` : `\n${summary}`
  )
  if (isDryRun) lines.push("Re-run with `dry_run: false` to write these changes.")
  return lines.join("\n")
}

/**
 * Suggest a correction when a search returns nothing for a common malformed
 * pattern (the most frequent ast-grep beginner mistakes).
 * @param {string} pattern
 * @param {string} lang
 * @returns {string | null}
 */
export function getEmptyResultHint(pattern, lang) {
  const src = pattern.trim()

  if (lang === "python") {
    if (
      (src.startsWith("class ") || src.startsWith("def ") || src.startsWith("async def ")) &&
      src.endsWith(":")
    ) {
      return `Hint: Remove the trailing colon. Try: "${src.slice(0, -1)}"`
    }
  }

  if (["javascript", "typescript", "tsx"].includes(lang)) {
    if (/^(export\s+)?(async\s+)?function\s+\$[A-Z_]+\s*$/i.test(src)) {
      return 'Hint: Function patterns need params and body. Try "function $NAME($$$) { $$$ }"'
    }
  }

  return null
}
