// content_search — search file contents under a directory (read-only).

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import fastGlob from "fast-glob"

import { toolError, toolText } from "../safety.mjs"
import { statOrNull } from "../shared/fs-stat.mjs"
import { loadIgnoreGlobs } from "../core/gitignore.mjs"

const MAX_CONTENT_MATCH_RESULTS = 500
const MAX_FILE_READ_BYTES = 5 * 1024 * 1024 // skip files larger than 5 MB
// Files are scanned in fast-glob (deterministic) order but READ concurrently in
// batches of this size — the previous one-file-at-a-time await chain serialized
// every stat+read, which dominated wall-clock on large trees. Batching keeps
// the match ordering and the stop-at-cap semantics identical while overlapping
// the IO.
const READ_CONCURRENCY = 16

/** Scan one file, returning its match rows in line order (empty on skip/error). */
async function scanFile(root, rel, matcher) {
  const abs = path.join(root, rel)
  const stat = await statOrNull(abs)
  if (!stat || stat.size > MAX_FILE_READ_BYTES) return []
  let content
  try {
    content = await fsp.readFile(abs, "utf-8")
  } catch {
    return []
  }
  const out = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (matcher.test(lines[i])) out.push({ file: rel, line: i + 1, text: lines[i].slice(0, 400) })
  }
  return out
}

const contentSearchShape = {
  directory: z.string().min(1).describe("Absolute root directory to search."),
  pattern: z.string().min(1).describe("Substring or regex to search for."),
  regex: z.boolean().default(false).describe("Treat pattern as a regular expression."),
  caseSensitive: z.boolean().default(false).describe("Match case-sensitively."),
  extensions: z.array(z.string()).optional().describe("Restrict to these file extensions."),
  recursive: z.boolean().default(true).describe("Walk subdirectories."),
  respectGitignore: z
    .boolean()
    .default(true)
    .describe("Skip files ignored by .gitignore (root + nested). Set false to search everything."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTENT_MATCH_RESULTS)
    .default(100)
    .describe("Cap on the number of match rows returned."),
}

async function execContentSearch(args) {
  try {
    const root = path.resolve(args.directory)
    const rootStat = await statOrNull(root)
    if (!rootStat || !rootStat.isDirectory()) return toolError(`not a directory: ${root}`)
    const flags = args.caseSensitive ? "" : "i"
    const matcher = args.regex
      ? new RegExp(args.pattern, flags)
      : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
    const ignore = args.respectGitignore === false ? undefined : await loadIgnoreGlobs(root)
    const fileEntries = await fastGlob(args.recursive ? "**/*" : "*", {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
      ...(ignore ? { ignore } : {}),
    })
    const allowedExts = args.extensions?.map((e) => e.toLowerCase().replace(/^\./, ""))
    // Cheap extension filter first (no IO), preserving fast-glob order.
    const candidates = allowedExts?.length
      ? fileEntries.filter((rel) =>
          allowedExts.includes(path.extname(rel).replace(/^\./, "").toLowerCase())
        )
      : fileEntries

    const matches = []
    // Walk the candidates in ordered batches: read a batch concurrently, then
    // append its matches in file order so the result is byte-identical to the
    // old serial scan. Stop as soon as the cap is reached (batch granularity).
    for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
      const batch = candidates.slice(i, i + READ_CONCURRENCY)
      const perFile = await Promise.all(batch.map((rel) => scanFile(root, rel, matcher)))
      for (const fileMatches of perFile) {
        for (const m of fileMatches) {
          matches.push(m)
          if (matches.length >= args.maxResults) {
            // Omit `root`/`pattern` echoes — the model already has them in its
            // own call args; returning only matches + the cap flag saves tokens.
            // Hitting the cap proves more matches exist, so surface an explicit,
            // non-silent note (mirrors glob/grep/ls truncation style) rather than
            // a bare boolean the model might overlook.
            return toolText({
              matches,
              truncated: true,
              note: `result capped at ${args.maxResults} matches — more exist; narrow the pattern, extensions, or directory.`,
            })
          }
        }
      }
    }
    return toolText({ matches, truncated: false })
  } catch (err) {
    return toolError(err, "content_search")
  }
}

export const contentSearchTool = tool(
  "content_search",
  "Search file contents under a directory for a substring or regex. Respects .gitignore (root + nested) by default. Read-only. Returns line numbers.",
  contentSearchShape,
  execContentSearch
)

export { execContentSearch }
