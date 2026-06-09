/**
 * Recursive `@import` expansion for instruction files (Claude Code parity).
 *
 * A line may reference another file with `@relative/path` (or an absolute /
 * `~`-rooted path). The referenced file's content is inlined in place, with its
 * own imports expanded first. Cycles are broken via a `seen` set keyed by
 * absolute path, and recursion is bounded by `maxDepth`. To avoid false
 * positives on `user@host`-style tokens we only substitute when the token looks
 * path-like AND the resolved file actually reads — anything else is left as-is.
 *
 * `@` tokens inside fenced code blocks (``` … ```) are ignored, matching
 * Claude Code's behaviour of not expanding imports in code samples.
 */

import { dirname, joinPath, pathKey } from "./paths"
import type { InstructionFs } from "./types"

export interface ExpandResult {
  content: string
  /** Absolute paths of every file inlined (excluding the entry file). */
  imported: string[]
  warnings: string[]
}

/** A token is path-like when it carries a separator, a dot, or a `~`/`.` prefix. */
function looksLikePath(token: string): boolean {
  return /[\\/.]/.test(token) || token.startsWith("~")
}

function resolveImport(baseDir: string, token: string): string {
  // Absolute (posix `/`, windows `C:\`) or home — pass through verbatim; the fs
  // adapter handles `~` if the host supports it (else the read simply fails).
  if (/^([A-Za-z]:[\\/]|[\\/]|~)/.test(token)) return token
  return joinPath(baseDir, token)
}

const IMPORT_RE = /(^|\s)@([^\s)]+)/g

/**
 * Expand `@import` references in `content`. `baseDir` is the directory of the
 * file the content came from (imports resolve relative to it).
 */
export async function expandImports(
  content: string,
  baseDir: string,
  fs: InstructionFs,
  opts: { maxDepth?: number; seen?: Set<string> } = {}
): Promise<ExpandResult> {
  const maxDepth = opts.maxDepth ?? 5
  const seen = opts.seen ?? new Set<string>()
  const imported: string[] = []
  const warnings: string[] = []

  async function walk(text: string, dir: string, depth: number): Promise<string> {
    const lines = text.split("\n")
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      if (!line.includes("@")) continue

      // Collect substitutions for this line, then apply.
      const replacements: Array<{ match: string; with: string }> = []
      for (const m of line.matchAll(IMPORT_RE)) {
        const lead = m[1]
        const token = m[2]
        if (!looksLikePath(token)) continue
        const abs = resolveImport(dir, token)
        const key = pathKey(abs)
        if (seen.has(key)) {
          warnings.push(`skipped circular @import: ${token}`)
          continue
        }
        if (depth >= maxDepth) {
          warnings.push(`@import depth limit reached at: ${token}`)
          continue
        }
        let body: string
        try {
          body = await fs.readText(abs)
        } catch {
          // Not a real file (e.g. an email address) — leave the token untouched.
          continue
        }
        seen.add(key)
        imported.push(abs)
        const expanded = await walk(body, dirname(abs), depth + 1)
        replacements.push({ match: `${lead}@${token}`, with: `${lead}${expanded.trim()}` })
      }
      for (const r of replacements) {
        lines[i] = lines[i].replace(r.match, () => r.with)
      }
    }
    return lines.join("\n")
  }

  const out = await walk(content, baseDir, 0)
  return { content: out, imported, warnings }
}
