// file_search — list files under a directory by glob + extension (read-only).

import path from "node:path"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import fastGlob from "fast-glob"

import { toolError, toolText } from "../safety.mjs"
import { statOrNull } from "../shared/fs-stat.mjs"
import { loadIgnoreGlobs } from "../core/gitignore.mjs"

const MAX_LIST_ITEMS = 5000

const fileSearchShape = {
  directory: z.string().min(1).describe("Absolute root directory to search."),
  pattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern (e.g., '**/*.ts'). When omitted lists every entry under the directory."
    ),
  extensions: z
    .array(z.string())
    .optional()
    .describe("Filter to files with these extensions (e.g., ['ts','tsx'])."),
  recursive: z.boolean().default(true).describe("Whether to recurse into subdirectories."),
  respectGitignore: z
    .boolean()
    .default(true)
    .describe("Skip files ignored by .gitignore (root + nested). Set false to list everything."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_ITEMS)
    .default(200)
    .describe("Hard cap on returned entries."),
}

async function execFileSearch(args) {
  try {
    const root = path.resolve(args.directory)
    const st = await statOrNull(root)
    if (!st || !st.isDirectory()) return toolError(`not a directory: ${root}`)
    const patterns = args.pattern ? [args.pattern] : args.recursive ? ["**/*"] : ["*"]
    const ignore = args.respectGitignore === false ? undefined : await loadIgnoreGlobs(root)
    const entries = await fastGlob(patterns, {
      cwd: root,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      deep: args.recursive ? Infinity : 1,
      suppressErrors: true,
      ...(ignore ? { ignore } : {}),
    })
    const filtered = args.extensions?.length
      ? entries.filter((p) => {
          const ext = path.extname(p).replace(/^\./, "").toLowerCase()
          return args.extensions.some((e) => e.toLowerCase() === ext)
        })
      : entries
    const sliced = filtered.slice(0, args.maxResults)
    // Omit `root`/`pattern` echoes (already in the model's call args); keep the
    // `total` + `truncated` signals so the model knows when results were capped.
    return toolText({
      total: filtered.length,
      truncated: filtered.length > sliced.length,
      results: sliced,
    })
  } catch (err) {
    return toolError(err, "file_search")
  }
}

export const fileSearchTool = tool(
  "file_search",
  "List files under a directory matching an optional glob pattern and extension filter. Respects .gitignore (root + nested) by default. Read-only.",
  fileSearchShape,
  execFileSearch
)

export { execFileSearch }
