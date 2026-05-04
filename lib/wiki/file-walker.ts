/**
 * Pure file-path filtering / bucketing for the wiki indexer.
 *
 * The orchestrator owns the actual filesystem walk (Tauri `plugin-fs` in
 * production, `node:fs` in the standalone-entry build); this module is
 * fs-free so the rules can be unit-tested against synthetic inputs.
 *
 * Inclusion rules mirror the plan's "Section 3 — Wiki generator":
 *   • Include `lib/`, `app/`, `components/`, `hooks/`, `types/` (files at
 *     any depth)
 *   • Exclude tests, node_modules, build artifacts, `.claude/` worktrees
 *   • Only TypeScript / TSX / Rust / Markdown source extensions count
 */

/** Directory roots a wiki article can be derived from. Every other path is dropped. */
export const INCLUDED_DIR_ROOTS: readonly string[] = [
  "lib",
  "app",
  "components",
  "hooks",
  "types",
] as const

/** File extensions that contribute to the wiki. */
export const INCLUDED_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".rs", ".md", ".mdx"] as const

/**
 * Path fragments that disqualify a file even if it lives under an included
 * root. Matched as substrings on the normalized (forward-slash) path.
 */
export const EXCLUDED_FRAGMENTS: readonly string[] = [
  "/node_modules/",
  "/.next/",
  "/out/",
  "/dist/",
  "/coverage/",
  "/.claude/worktrees/",
  "/components/ui/",
  "/components/ai-elements/",
] as const

/** Filename patterns that disqualify (test files, mocks, generated code). */
export const EXCLUDED_FILENAME_PATTERNS: readonly RegExp[] = [
  /\.test\.[mc]?[jt]sx?$/,
  /\.spec\.[mc]?[jt]sx?$/,
  /\.d\.ts$/,
  /\.stories\.[jt]sx?$/,
] as const

/** Normalize a path to forward slashes (Windows safety). */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

/** True when `path` is rooted under one of `INCLUDED_DIR_ROOTS`. */
export function hasIncludedRoot(path: string): boolean {
  const norm = normalizePath(path).replace(/^\.?\//, "")
  for (const root of INCLUDED_DIR_ROOTS) {
    if (norm === root || norm.startsWith(root + "/")) return true
  }
  return false
}

/** True when the path's extension is one of `INCLUDED_EXTENSIONS`. */
export function hasIncludedExtension(path: string): boolean {
  const norm = normalizePath(path).toLowerCase()
  return INCLUDED_EXTENSIONS.some((ext) => norm.endsWith(ext))
}

/** True when the path contains a disqualifying fragment. */
export function hasExcludedFragment(path: string): boolean {
  const norm = "/" + normalizePath(path).replace(/^\.?\//, "")
  return EXCLUDED_FRAGMENTS.some((frag) => norm.includes(frag))
}

/** True when the *filename* matches a disqualifying pattern. */
export function hasExcludedFilenamePattern(path: string): boolean {
  const filename = normalizePath(path).split("/").pop() ?? ""
  return EXCLUDED_FILENAME_PATTERNS.some((re) => re.test(filename))
}

/**
 * Composite predicate: true iff the file should be indexed for wiki
 * generation. The four sub-predicates above are exposed so test reports
 * can pin-point exactly which rule rejected a file.
 */
export function shouldIncludeFile(path: string): boolean {
  if (!hasIncludedRoot(path)) return false
  if (!hasIncludedExtension(path)) return false
  if (hasExcludedFragment(path)) return false
  if (hasExcludedFilenamePattern(path)) return false
  return true
}

/** Filter helper for arrays of paths. */
export function filterIncludedPaths(paths: readonly string[]): string[] {
  return paths.filter(shouldIncludeFile)
}

/**
 * Module bucket — every file maps to a "module" identifier. The module is
 * the **parent directory** of the file (relative to repo root) — single-file
 * roots collapse to the file's own directory. Examples:
 *
 *   lib/twin/ingest/chunk.ts        → "lib/twin/ingest"
 *   lib/wiki/orchestrator.ts        → "lib/wiki"
 *   types/wiki/index.ts             → "types/wiki"
 *   lib/utils.ts                    → "lib"
 *
 * The orchestrator drives `ModuleArticleAgent` once per unique module key.
 */
export function moduleForPath(path: string): string {
  const norm = normalizePath(path)
  const segments = norm.split("/").filter(Boolean)
  if (segments.length <= 1) return ""
  return segments.slice(0, -1).join("/")
}

/** Bucket a list of paths by their module (parent dir). */
export function bucketByModule(paths: readonly string[]): Map<string, string[]> {
  const buckets = new Map<string, string[]>()
  for (const p of paths) {
    const modulePath = moduleForPath(p)
    const existing = buckets.get(modulePath)
    if (existing) {
      existing.push(p)
    } else {
      buckets.set(modulePath, [p])
    }
  }
  return buckets
}

/**
 * Convert a slug-friendly identifier from a module path:
 *   "lib/twin/ingest" → "lib-twin-ingest"
 * Used by `wikiArticles.slug`. Idempotent (re-running on a slug returns the
 * same value).
 */
export function moduleToSlug(modulePath: string): string {
  return normalizePath(modulePath)
    .replace(/[\\/]/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
}
