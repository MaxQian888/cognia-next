// content_search — search file contents under a directory (read-only).

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import fastGlob from "fast-glob"

import { toolError, toolText } from "../safety.mjs"
import { statOrNull } from "../shared/fs-stat.mjs"

const MAX_CONTENT_MATCH_RESULTS = 500
const MAX_FILE_READ_BYTES = 5 * 1024 * 1024 // skip files larger than 5 MB

const contentSearchShape = {
  directory: z.string().min(1).describe("Absolute root directory to search."),
  pattern: z.string().min(1).describe("Substring or regex to search for."),
  regex: z.boolean().default(false).describe("Treat pattern as a regular expression."),
  caseSensitive: z.boolean().default(false).describe("Match case-sensitively."),
  extensions: z.array(z.string()).optional().describe("Restrict to these file extensions."),
  recursive: z.boolean().default(true).describe("Walk subdirectories."),
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
    const fileEntries = await fastGlob(args.recursive ? "**/*" : "*", {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
    const allowedExts = args.extensions?.map((e) => e.toLowerCase().replace(/^\./, ""))
    const matches = []
    for (const rel of fileEntries) {
      if (allowedExts?.length) {
        const ext = path.extname(rel).replace(/^\./, "").toLowerCase()
        if (!allowedExts.includes(ext)) continue
      }
      const abs = path.join(root, rel)
      const stat = await statOrNull(abs)
      if (!stat || stat.size > MAX_FILE_READ_BYTES) continue
      let content
      try {
        content = await fsp.readFile(abs, "utf-8")
      } catch {
        continue
      }
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
          matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 400) })
          if (matches.length >= args.maxResults) {
            return toolText({
              root,
              pattern: args.pattern,
              matches,
              truncated: true,
            })
          }
        }
      }
    }
    return toolText({ root, pattern: args.pattern, matches, truncated: false })
  } catch (err) {
    return toolError(err, "content_search")
  }
}

export const contentSearchTool = tool(
  "content_search",
  "Search file contents under a directory for a substring or regex. Read-only. Returns line numbers.",
  contentSearchShape,
  execContentSearch
)

export { execContentSearch }
