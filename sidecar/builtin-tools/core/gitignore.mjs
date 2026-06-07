// Minimal .gitignore loader for the JS search fallback.
//
// The primary engine (ripgrep) honours .gitignore natively; this module only
// serves the pure-JS fallback path (`js-search.mjs`), which enumerates files
// through fast-glob. fast-glob's `ignore` option takes plain glob patterns
// with NO negation support, so we convert the repository's root .gitignore
// into that vocabulary:
//   - comment / blank lines dropped
//   - negation lines (`!pattern`) dropped (un-ignoring is not expressible in
//     fast-glob's ignore list — acceptable for a fallback engine)
//   - `dir/` (directory-only) → `dir/**` and `**/dir/**`
//   - leading `/` anchors to the root (no `**/` prefix added)
//   - bare names/patterns match at any depth: `name` → `**/name` + `**/name/**`
// `.git` itself is always ignored.

import path from "node:path"
import fsp from "node:fs/promises"

export const ALWAYS_IGNORE = Object.freeze(["**/.git", "**/.git/**"])

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
 * Load the root `.gitignore` of `root` (if any) and return fast-glob ignore
 * patterns. Nested .gitignore files are not consulted — ripgrep is the
 * correct engine when full fidelity matters.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function loadIgnoreGlobs(root) {
  const patterns = [...ALWAYS_IGNORE]
  try {
    const raw = await fsp.readFile(path.join(root, ".gitignore"), "utf-8")
    for (const line of raw.split(/\r?\n/)) {
      patterns.push(...gitignoreLineToGlobs(line))
    }
  } catch {
    // No .gitignore — only the defaults apply.
  }
  return patterns
}
