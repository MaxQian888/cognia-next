// Core `grep` tool — ripgrep-grade content search with Claude Code's
// parameter surface: output modes, context lines, case folding, head_limit
// paging, multiline mode, glob/type filters.
//
// Engine: ripgrep when available; the js-search fallback otherwise (context
// lines are reconstructed from the file in the fallback).

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { detectRipgrep, runRipgrep } from "./rg.mjs"
import { jsGrep } from "./js-search.mjs"
import { decodeText } from "./text-io.mjs"
import { resolveToolPath } from "./read.mjs"

export const DEFAULT_HEAD_LIMIT = 250
export const MAX_LINE_CHARS = 1000

export const grepShape = {
  pattern: z.string().min(1).describe("Regular expression to search for (ripgrep syntax)."),
  path: z
    .string()
    .optional()
    .describe("File or directory to search in. Defaults to the session working directory."),
  glob: z.string().optional().describe('Filter files by glob (e.g. "*.ts", "src/**/*.tsx").'),
  type: z
    .string()
    .optional()
    .describe(
      'Filter files by type (ripgrep --type, e.g. "js", "rust"). Ignored by the fallback engine.'
    ),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .default("files_with_matches")
    .describe(
      '"content" shows matching lines; "files_with_matches" shows file paths only (default); "count" shows per-file match counts.'
    ),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of context before AND after each match (content mode only)."),
  before_context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of context before each match (content mode only)."),
  after_context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of context after each match (content mode only)."),
  case_insensitive: z.boolean().optional().describe("Case-insensitive matching."),
  multiline: z
    .boolean()
    .optional()
    .describe("Allow the pattern to span lines (. matches newlines)."),
  head_limit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Limit output to the first N lines/entries (default ${DEFAULT_HEAD_LIMIT}; 0 = unlimited).`
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip the first N lines/entries before applying head_limit (paging)."),
}

/** Apply offset + head_limit to a list of output lines. */
export function pageLines(lines, { offset = 0, headLimit = DEFAULT_HEAD_LIMIT }) {
  const afterOffset = offset > 0 ? lines.slice(offset) : lines
  if (headLimit === 0) return { lines: afterOffset, truncated: false }
  return {
    lines: afterOffset.slice(0, headLimit),
    truncated: afterOffset.length > headLimit,
  }
}

function clipLine(text) {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text
}

/**
 * Compress `content`-mode output by hoisting a repeated file path out of every
 * match line. ripgrep's `--no-heading` format repeats the full path on each
 * match (`path:line:text`); for a file with several hits that path is pure
 * duplicated tokens. When ≥2 consecutive lines share a path we emit the path
 * once on its own line, then `line:text` rows beneath it:
 *
 *     src/foo/bar.ts          ← path once
 *     12:  match              ← line:text, path dropped
 *     40:  other match
 *
 * A lone match keeps the inline `path:line:text` form (hoisting it would only
 * ADD a line), and any line that doesn't parse as `path:line:text` (e.g. a
 * context row or a `--` separator) passes through untouched — which is why the
 * caller only applies this when no context lines were requested. The model can
 * still cite `src/foo/bar.ts:12` from the grouped form.
 */
export function groupByFile(lines) {
  const parsed = lines.map((line) => {
    const m = /^(.*?):(\d+):([\s\S]*)$/.exec(line)
    return m ? { file: m[1], rest: `${m[2]}:${m[3]}`, raw: line } : { raw: line }
  })
  const out = []
  let i = 0
  while (i < parsed.length) {
    const head = parsed[i]
    if (head.file === undefined) {
      out.push(head.raw)
      i++
      continue
    }
    let j = i + 1
    while (j < parsed.length && parsed[j].file === head.file) j++
    const run = parsed.slice(i, j)
    if (run.length >= 2) {
      out.push(head.file)
      for (const r of run) out.push(r.rest)
    } else {
      out.push(head.raw)
    }
    i = j
  }
  return out
}

async function execWithRipgrep(args, { root, rgPath }) {
  const rgArgs = ["--no-config", "--no-heading", "--glob", "!.git/**"]
  if (args.case_insensitive) rgArgs.push("-i")
  if (args.multiline) rgArgs.push("-U", "--multiline-dotall")
  if (args.glob) rgArgs.push("--glob", args.glob)
  if (args.type) rgArgs.push("--type", args.type)

  const mode = args.output_mode ?? "files_with_matches"
  if (mode === "files_with_matches") rgArgs.push("--files-with-matches")
  else if (mode === "count") rgArgs.push("--count")
  else {
    rgArgs.push("--line-number")
    const before = args.before_context ?? args.context
    const after = args.after_context ?? args.context
    if (before) rgArgs.push("--before-context", String(before))
    if (after) rgArgs.push("--after-context", String(after))
  }
  rgArgs.push("--regexp", args.pattern, "--", ".")

  const {
    stdout,
    code,
    truncated: streamTruncated,
  } = await runRipgrep(rgArgs, {
    cwd: root,
    rgPath,
  })
  if (code === 1 && stdout.length === 0) return { lines: [], streamTruncated }
  const lines = stdout
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => clipLine(l.replace(/\\/g, "/")))
  return { lines, streamTruncated }
}

async function execWithJsFallback(args, { root }) {
  const { matches, truncated } = await jsGrep({
    pattern: args.pattern,
    root,
    glob: args.glob,
    ignoreCase: args.case_insensitive,
    multiline: args.multiline,
  })
  const mode = args.output_mode ?? "files_with_matches"

  if (mode === "files_with_matches") {
    const files = [...new Set(matches.map((m) => m.file))]
    return { lines: files, streamTruncated: truncated }
  }
  if (mode === "count") {
    const counts = new Map()
    for (const m of matches) counts.set(m.file, (counts.get(m.file) ?? 0) + 1)
    return {
      lines: [...counts.entries()].map(([f, c]) => `${f}:${c}`),
      streamTruncated: truncated,
    }
  }

  // content mode — reconstruct context windows from the files.
  const before = args.before_context ?? args.context ?? 0
  const after = args.after_context ?? args.context ?? 0
  const fileCache = new Map()
  const lines = []
  for (const m of matches) {
    if (before === 0 && after === 0) {
      lines.push(clipLine(`${m.file}:${m.line}:${m.text}`))
      continue
    }
    if (!fileCache.has(m.file)) {
      try {
        const raw = await fsp.readFile(path.join(root, m.file), "utf-8")
        fileCache.set(m.file, decodeText(raw).content.split("\n"))
      } catch {
        fileCache.set(m.file, null)
      }
    }
    const fileLines = fileCache.get(m.file)
    if (!fileLines) {
      lines.push(clipLine(`${m.file}:${m.line}:${m.text}`))
      continue
    }
    const start = Math.max(1, m.line - before)
    const end = Math.min(fileLines.length, m.line + after)
    for (let n = start; n <= end; n++) {
      const sep = n === m.line ? ":" : "-"
      lines.push(clipLine(`${m.file}${sep}${n}${sep}${fileLines[n - 1]}`))
    }
    lines.push("--")
  }
  if (lines[lines.length - 1] === "--") lines.pop()
  return { lines, streamTruncated: truncated }
}

export function createGrepTool({ cwd }) {
  async function execGrep(args) {
    try {
      const root = resolveToolPath(cwd, args.path ?? ".")
      const rgPath = await detectRipgrep()
      const { lines, streamTruncated } = rgPath
        ? await execWithRipgrep(args, { root, rgPath })
        : await execWithJsFallback(args, { root })

      if (lines.length === 0) return toolText("No matches found.")

      const { lines: shown, truncated } = pageLines(lines, {
        offset: args.offset ?? 0,
        headLimit: args.head_limit ?? DEFAULT_HEAD_LIMIT,
      })
      // Token-saving compression for plain content mode: hoist a repeated file
      // path out of its match lines. Paging stays in match-line units (we group
      // the already-paged slice), so head_limit / offset semantics are unchanged.
      // Skipped when context lines were requested — those interleave `-`/`--`
      // rows that don't fit the `path:line:text` shape. files/count modes never
      // group (their lines aren't match lines).
      const mode = args.output_mode ?? "files_with_matches"
      const hasContext = Boolean(args.context || args.before_context || args.after_context)
      const displayed = mode === "content" && !hasContext ? groupByFile(shown) : shown
      const notes = []
      if (truncated) {
        const nextOffset = (args.offset ?? 0) + shown.length
        notes.push(
          `… output truncated at ${shown.length} lines (continue with offset=${nextOffset}, or narrow with glob/path).`
        )
      }
      if (streamTruncated)
        notes.push("(engine output was capped — refine the pattern for complete results)")
      return toolText([...displayed, ...notes].join("\n"))
    } catch (err) {
      return toolError(err, "grep")
    }
  }

  return tool(
    "grep",
    'Search file contents with a regular expression (ripgrep-backed). output_mode: "files_with_matches" (default) lists files, "content" shows matching lines with optional context, "count" shows match counts. Respects .gitignore. Read-only.',
    grepShape,
    execGrep,
    { alwaysLoad: true }
  )
}
