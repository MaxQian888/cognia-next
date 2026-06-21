// Minimal .gitignore loader for the JS search fallback.
//
// The primary engine (ripgrep) honours .gitignore natively; this module only
// serves the pure-JS fallback path (`js-search.mjs`) and the file-ops
// content/file search tools, which enumerate files through fast-glob.
// fast-glob's `ignore` option takes plain glob patterns with NO negation
// support, so we convert the repository's .gitignore files into that
// vocabulary:
//   - comment / blank lines dropped
//   - negation lines (`!pattern`) dropped (un-ignoring is not expressible in
//     fast-glob's ignore list — acceptable for a fallback engine)
//   - `dir/` (directory-only) → `dir/**` and `**/dir/**`
//   - leading `/` anchors to the root (no `**/` prefix added)
//   - bare names/patterns match at any depth: `name` → `**/name` + `**/name/**`
// `.git` itself is always ignored.
//
// Nested .gitignore files are honoured too: each one's patterns are anchored to
// its containing directory (relative to the search root), matching git's
// per-directory scoping — so a `pkg/.gitignore` with `dist/` only ignores
// `pkg/dist`, not a sibling `other/dist`. Discovery prunes `.git` and
// `node_modules` (which are themselves ignored in virtually every repo) so the
// loader never walks heavy trees just to find ignore files.

import path from "node:path"
import fsp from "node:fs/promises"
import fastGlob from "fast-glob"

export const ALWAYS_IGNORE = Object.freeze(["**/.git", "**/.git/**"])

/** Dirs pruned while DISCOVERING nested .gitignore files (not the search
 * itself). Both are ignored by the root .gitignore in practically every repo,
 * so descending into them just to read their own ignore files wastes a tree
 * walk; skipping them keeps `loadIgnoreGlobs` cheap on large repos. */
const DISCOVERY_PRUNE = Object.freeze(["**/.git/**", "**/node_modules/**"])

/**
 * Convert one .gitignore line into zero or more fast-glob ignore patterns.
 * Exported for tests.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function gitignoreLineToGlobs(line) {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) return []

  const dirOnly = trimmed.endsWith("/")
  let body = dirOnly ? trimmed.slice(0, -1) : trimmed

  const anchored = body.startsWith("/")
  if (anchored) body = body.slice(1)
  if (body.length === 0) return []

  // A pattern containing a slash is anchored to the root per gitignore rules.
  const hasSlash = body.includes("/")
  const roots = anchored || hasSlash ? [body] : [`**/${body}`]

  const out = []
  for (const r of roots) {
    out.push(r)
    // Whether it names a directory explicitly or might be one, also ignore
    // its contents (gitignore ignores everything beneath a matched dir).
    out.push(`${r}/**`)
  }
  return out
}

/**
 * Anchor a converted glob to a directory relative to the search root. Root-level
 * patterns (`relDir === ""`) pass through unchanged; a nested directory prefixes
 * its path so the pattern only matches beneath that directory.
 *
 * @param {string} glob
 * @param {string} relDir POSIX-separated dir relative to root, or "".
 * @returns {string}
 */
function anchorGlob(glob, relDir) {
  return relDir ? `${relDir}/${glob}` : glob
}

/**
 * Load every `.gitignore` under `root` (the root one plus nested ones) and
 * return fast-glob ignore patterns. Nested files are anchored to their own
 * directory, matching git's per-directory semantics. `.git` is always ignored.
 *
 * For full fidelity (negation, `**` edge cases) ripgrep remains the primary
 * engine; this is the deterministic JS fallback that covers the common cases.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function loadIgnoreGlobs(root) {
  const patterns = [...ALWAYS_IGNORE]
  let files
  try {
    files = await fastGlob("**/.gitignore", {
      cwd: root,
      dot: true,
      ignore: [...DISCOVERY_PRUNE],
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  } catch {
    files = []
  }
  // Deterministic, shallow-first order so identical trees serialize identically.
  files.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))
  for (const rel of files) {
    const dir = path.posix.dirname(rel.split(path.sep).join("/"))
    const relDir = dir === "." ? "" : dir
    let raw
    try {
      raw = await fsp.readFile(path.join(root, rel), "utf-8")
    } catch {
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      for (const glob of gitignoreLineToGlobs(line)) {
        patterns.push(anchorGlob(glob, relDir))
      }
    }
  }
  return patterns
}
