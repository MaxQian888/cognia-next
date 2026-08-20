/**
 * Turn an issue into the files it is about (ADR-0088 Phase 3).
 *
 * Issues carry no first-class file references — the schema has a title, a
 * description, labels, and optionally a GitHub ref, but nothing that says
 * "this is about `lib/foo/bar.ts:42`". In practice people write the path into
 * the text, which is exactly the shortest path from an issue to the code and
 * exactly what a human does by hand: read the issue, copy the path, open it.
 *
 * So this module recovers those references by scanning the text, and the issue
 * detail panel offers the first one as an "open in Pro IDE" affordance.
 *
 * Deliberately conservative. A false positive sends the user to a file that
 * does not exist, which is worse than offering nothing, so a candidate must
 * look like a real source path: a known extension, at least one path segment
 * that is not `..`, and no scheme or whitespace. Prose that merely mentions a
 * word with a dot in it ("v1.2 regressed") does not qualify.
 */

/**
 * Extensions worth linking. An allowlist rather than "anything after a dot"
 * because prose is full of dotted tokens (version numbers, sentence ends,
 * domain names) and each one would become a broken link.
 */
const SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "py",
  "go",
  "java",
  "kt",
  "swift",
  "rb",
  "php",
  "cs",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "css",
  "scss",
  "html",
  "vue",
  "svelte",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "sql",
  "sh",
  "md",
  "mdx",
])

/** One file reference recovered from an issue's text. */
export interface IssueFileReference {
  /** Path as written — absolute, or relative to the workspace root. */
  path: string
  /** 1-based line, when the text carried a `:42` suffix. */
  line?: number
  /** 1-based column, when the text carried a `:42:7` suffix. */
  column?: number
}

/**
 * Candidate token: a run of path-ish characters ending in `.<ext>`, optionally
 * followed by `:line` or `:line:col`. Bounded by whitespace, quotes, backticks
 * and the common prose brackets so `(see lib/a.ts)` and `` `lib/a.ts` `` both work.
 */
const CANDIDATE = /[^\s"'`()[\]{}<>,;]+\.[A-Za-z0-9]+(?::\d+){0,2}/g

/** Trailing sentence punctuation that is not part of a path. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

function parseCandidate(raw: string): IssueFileReference | null {
  const token = raw.replace(TRAILING_PUNCTUATION, "")
  if (!token) return null

  // Split a `:line[:col]` suffix off the path.
  const parts = token.split(":")
  let path = parts[0] ?? ""
  let line: number | undefined
  let column: number | undefined
  // A Windows drive letter (`C:\work\a.ts`) is a path, not a line suffix.
  if (/^[A-Za-z]$/.test(path) && parts[1]?.startsWith("\\")) {
    path = `${parts[0]}:${parts[1]}`
    if (parts[2] !== undefined) line = Number.parseInt(parts[2], 10)
    if (parts[3] !== undefined) column = Number.parseInt(parts[3], 10)
  } else {
    if (parts[1] !== undefined) line = Number.parseInt(parts[1], 10)
    if (parts[2] !== undefined) column = Number.parseInt(parts[2], 10)
  }
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) return null
  if (column !== undefined && (!Number.isInteger(column) || column < 1)) return null

  // A scheme means it is a URL, not a workspace path — `detail.openInGithub`
  // already covers those.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null

  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "")
  const extension = normalized.split(".").pop()?.toLowerCase()
  if (!extension || !SOURCE_EXTENSIONS.has(extension)) return null

  const segments = normalized.split("/").filter(Boolean)
  if (segments.length === 0) return null
  // `..` anywhere means it escapes whatever root we would resolve against.
  if (segments.some((segment) => segment === "..")) return null

  return {
    path,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  }
}

/**
 * Every distinct file reference in `text`, in the order it appears.
 *
 * De-duplicated by path AND position: an issue that names the same file twice
 * should offer it once, but `a.ts:10` and `a.ts:99` are two real destinations.
 */
export function collectFileReferences(
  ...texts: Array<string | null | undefined>
): IssueFileReference[] {
  const seen = new Set<string>()
  const out: IssueFileReference[] = []
  for (const text of texts) {
    if (!text) continue
    for (const match of text.match(CANDIDATE) ?? []) {
      const parsed = parseCandidate(match)
      if (!parsed) continue
      const key = `${parsed.path}:${parsed.line ?? ""}:${parsed.column ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(parsed)
    }
  }
  return out
}

/**
 * The reference an "open in editor" affordance should act on, or null when the
 * issue names no file. The first one: issues lead with the thing they are
 * about, and offering a picker for what is usually a single path is friction.
 */
export function primaryFileReference(
  ...texts: Array<string | null | undefined>
): IssueFileReference | null {
  return collectFileReferences(...texts)[0] ?? null
}
