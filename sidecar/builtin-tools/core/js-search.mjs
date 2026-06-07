// Pure-JS search fallback for the core grep/glob tools, used when ripgrep is
// not installed. Enumeration goes through fast-glob (already a sidecar dep)
// with gitignore-derived ignore patterns from `gitignore.mjs`; content
// matching is line-based regex in JS. Deterministic ordering throughout so
// repeated identical calls serialize identically (prompt-cache stability).

import path from "node:path"
import fsp from "node:fs/promises"
import fastGlob from "fast-glob"

import { loadIgnoreGlobs } from "./gitignore.mjs"

const MAX_FILE_BYTES = 4 * 1024 * 1024 // skip files >4 MB in the JS engine
const BINARY_SNIFF_BYTES = 8 * 1024

/** A buffer is "binary" when its first 8 KB contain a NUL byte. */
export function looksBinary(buf) {
  const upto = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < upto; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/**
 * Enumerate files matching a glob pattern. Results are RELATIVE to `cwd`,
 * sorted lexicographically (callers re-sort by mtime when needed).
 *
 * @param {{ pattern: string, cwd: string, cap?: number }} opts
 * @returns {Promise<{ files: string[], truncated: boolean }>}
 */
export async function jsGlob({ pattern, cwd, cap = 1000 }) {
  const ignore = await loadIgnoreGlobs(cwd)
  const files = await fastGlob(pattern, {
    cwd,
    ignore,
    onlyFiles: true,
    dot: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  })
  files.sort()
  const truncated = files.length > cap
  return { files: truncated ? files.slice(0, cap) : files, truncated }
}

/**
 * Line-based regex search over the files matched by `glob` (default: all
 * files) under `root`.
 *
 * @param {{
 *   pattern: string,
 *   root: string,
 *   glob?: string,
 *   ignoreCase?: boolean,
 *   multiline?: boolean,
 *   cap?: number,
 * }} opts
 * @returns {Promise<{ matches: Array<{ file: string, line: number, text: string }>, truncated: boolean, fileCount: number }>}
 *   `matches` is sorted by (file, line). `line` is 1-based. With `multiline`,
 *   the match is reported at the line where it starts.
 */
export async function jsGrep({ pattern, root, glob, ignoreCase, multiline, cap = 2000 }) {
  const flags = `${ignoreCase ? "i" : ""}${multiline ? "ms" : ""}`
  // Validate the pattern once up front so a bad regex fails loudly.
  const re = new RegExp(pattern, flags)

  const { files } = await jsGlob({ pattern: glob ?? "**/*", cwd: root, cap: 50_000 })
  const matches = []
  let truncated = false

  for (const rel of files) {
    if (matches.length >= cap) {
      truncated = true
      break
    }
    let buf
    try {
      const st = await fsp.stat(path.join(root, rel))
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      buf = await fsp.readFile(path.join(root, rel))
    } catch {
      continue
    }
    if (looksBinary(buf)) continue
    const content = buf.toString("utf-8")

    if (multiline) {
      // Multiline: run against the whole content, report the start line of
      // each match.
      const g = new RegExp(pattern, flags.includes("g") ? flags : `g${flags}`)
      let m
      while ((m = g.exec(content)) !== null) {
        const line = content.slice(0, m.index).split("\n").length
        const lineText = content.split("\n")[line - 1] ?? ""
        matches.push({ file: rel, line, text: lineText })
        if (matches.length >= cap) {
          truncated = true
          break
        }
        if (m.index === g.lastIndex) g.lastIndex++ // zero-width safety
      }
    } else {
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({ file: rel, line: i + 1, text: lines[i] })
          if (matches.length >= cap) {
            truncated = true
            break
          }
        }
      }
    }
  }

  matches.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { matches, truncated, fileCount: new Set(matches.map((m) => m.file)).size }
}
