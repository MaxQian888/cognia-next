// Core `glob` tool — file pattern matching, mtime-sorted (newest first).
//
// Engine: ripgrep `--files --glob` when available (full gitignore fidelity),
// otherwise the fast-glob fallback from js-search.mjs (root .gitignore only).

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { detectRipgrep, runRipgrep } from "./rg.mjs"
import { jsGlob } from "./js-search.mjs"
import { resolveToolPath } from "./read.mjs"

export const MAX_FILES = 1000

export const globShape = {
  pattern: z
    .string()
    .min(1)
    .describe('Glob pattern to match files against (e.g. "**/*.ts", "src/**/*.test.tsx").'),
  path: z
    .string()
    .optional()
    .describe(
      "Directory to search in (absolute, or relative to the session working directory). Defaults to the working directory."
    ),
}

/**
 * Enumerate matching files (relative paths). Exported for the grep tool's
 * fallback and for tests.
 *
 * @param {{ pattern: string, root: string }} opts
 * @returns {Promise<{ files: string[], truncated: boolean }>}
 */
export async function enumerateGlob({ pattern, root }) {
  const rgPath = await detectRipgrep()
  if (rgPath) {
    const { stdout, truncated } = await runRipgrep(
      ["--no-config", "--files", "--glob", pattern, "--glob", "!.git/**"],
      { cwd: root, rgPath }
    )
    const files = stdout
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/\\/g, "/"))
    files.sort()
    const over = files.length > MAX_FILES
    return { files: over ? files.slice(0, MAX_FILES) : files, truncated: truncated || over }
  }
  return jsGlob({ pattern, cwd: root, cap: MAX_FILES })
}

export function createGlobTool({ cwd }) {
  async function execGlob(args) {
    try {
      const root = resolveToolPath(cwd, args.path ?? ".")
      const { files, truncated } = await enumerateGlob({ pattern: args.pattern, root })
      if (files.length === 0) return toolText("No files matched the pattern.")

      // Sort by mtime, newest first — recently-touched files are usually what
      // the agent wants. Deterministic tiebreak on the path keeps identical
      // trees serializing identically.
      const stats = await Promise.all(
        files.map(async (rel) => {
          try {
            const st = await fsp.stat(path.join(root, rel))
            return { rel, mtime: st.mtimeMs }
          } catch {
            return { rel, mtime: 0 }
          }
        })
      )
      stats.sort((a, b) => (b.mtime === a.mtime ? (a.rel < b.rel ? -1 : 1) : b.mtime - a.mtime))

      const lines = stats.map((s) => s.rel)
      const note = truncated
        ? `\n… result capped at ${MAX_FILES} files — narrow the pattern or path.`
        : ""
      return toolText(`${lines.join("\n")}${note}`)
    } catch (err) {
      return toolError(err, "glob")
    }
  }

  return tool(
    "glob",
    'Find files by glob pattern (e.g. "**/*.ts"). Results are sorted by modification time, newest first. Respects .gitignore. Read-only.',
    globShape,
    execGlob,
    { alwaysLoad: true }
  )
}
