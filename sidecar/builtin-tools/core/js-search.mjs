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
/** Files read concurrently per chunk — bounds open FDs while overlapping I/O
 * latency (the previous sequential read was the JS-engine bottleneck). */
const READ_CONCURRENCY = 24

/** Extensions we treat as binary by name, so we never even read them. Catches
 * the bulk of non-text files cheaply; anything not listed still gets the NUL
 * sniff. */
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "tif",
  "tiff",
  "avif",
  "heic",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "wmv",
  "flv",
  "zip",
  "gz",
  "tar",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "zst",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "o",
  "a",
  "obj",
  "class",
  "wasm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "png",
  "psd",
  "sketch",
  "db",
  "sqlite",
  "sqlite3",
  "pyc",
])

/** True when a relative path's extension is a known-binary type. */
export function hasBinaryExtension(rel) {
  const dot = rel.lastIndexOf(".")
  if (dot < 0) return false
  return BINARY_EXTENSIONS.has(rel.slice(dot + 1).toLowerCase())
}

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
  // Drop known-binary files by extension up front so we never read them.
  const candidates = files.filter((rel) => !hasBinaryExtension(rel))
  const matches = []
  let truncated = false

  // Read in bounded-concurrency chunks (I/O overlap) while preserving the
  // original file order for scanning, so output and the cap short-circuit stay
  // deterministic across identical calls.
  outer: for (let start = 0; start < candidates.length; start += READ_CONCURRENCY) {
    if (matches.length >= cap) {
      truncated = true
      break
    }
    const chunk = candidates.slice(start, start + READ_CONCURRENCY)
    const bufs = await Promise.all(
      chunk.map(async (rel) => {
        try {
          const st = await fsp.stat(path.join(root, rel))
          if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
          return await fsp.readFile(path.join(root, rel))
        } catch {
          return null
        }
      })
    )

    for (let ci = 0; ci < chunk.length; ci++) {
      if (matches.length >= cap) {
        truncated = true
        break outer
      }
      const rel = chunk[ci]
      const buf = bufs[ci]
      if (!buf || looksBinary(buf)) continue
      const content = buf.toString("utf-8")

      if (multiline) {
        // Multiline: run against the whole content, report the start line of
        // each match. Split into lines ONCE and track the line number with a
        // monotonic newline counter — exec() yields matches in non-decreasing
        // index order, so we never rescan from the start (the previous
        // slice(0,index).split() per match was O(matches × fileSize)).
        const g = new RegExp(pattern, flags.includes("g") ? flags : `g${flags}`)
        const fileLines = content.split("\n")
        let scanPos = 0
        let scanLine = 1
        let m
        while ((m = g.exec(content)) !== null) {
          while (scanPos < m.index) {
            if (content.charCodeAt(scanPos) === 10 /* \n */) scanLine++
            scanPos++
          }
          matches.push({ file: rel, line: scanLine, text: fileLines[scanLine - 1] ?? "" })
          if (matches.length >= cap) {
            truncated = true
            break
          }
          if (m.index === g.lastIndex) g.lastIndex++ // zero-width safety
        }
      } else {
        const lines = content.split("\n")
        for (let li = 0; li < lines.length; li++) {
          if (re.test(lines[li])) {
            matches.push({ file: rel, line: li + 1, text: lines[li] })
            if (matches.length >= cap) {
              truncated = true
              break
            }
          }
        }
      }
    }
  }

  matches.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { matches, truncated, fileCount: new Set(matches.map((m) => m.file)).size }
}
