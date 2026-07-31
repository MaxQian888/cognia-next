import { execFileSync } from "node:child_process"

/** Where the MDX tree lives, relative to the repository root. */
export const DOCS_CONTENT_ROOT = "docs/content/docs"

let repositoryRoot: string | null | undefined

function findRepositoryRoot(): string | null {
  if (repositoryRoot !== undefined) return repositoryRoot
  try {
    repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return repositoryRoot || null
  } catch {
    repositoryRoot = null
    return null
  }
}

/**
 * Repo-relative source path for a page, from fumadocs' virtualized
 * `page.path` (already relative to `content/docs`, extension included).
 *
 * Taking the path from fumadocs rather than rebuilding it from `lang + slug`
 * is what makes the locale-shared tree work: `content/docs/plugin-dev/` has
 * no locale segment, so a reconstructed `{lang}/plugin-dev/...` path pointed
 * at 24 files that don't exist — no "last updated" line, and an
 * "Edit this page" link that 404s on GitHub.
 */
export function docsSourcePath(contentPath: string): string {
  return `${DOCS_CONTENT_ROOT}/${contentPath}`
}

/**
 * Memoised because each page is now queried twice per build worker — once by
 * the page footer, once by the sitemap — and every miss forks a `git log`.
 */
const timestamps = new Map<string, string | null>()

/** Build-time git timestamp; null keeps the footer hidden outside a Git checkout. */
export function getDocsLastModified(contentPath: string): string | null {
  const cached = timestamps.get(contentPath)
  if (cached !== undefined) return cached

  const value = readDocsLastModified(contentPath)
  timestamps.set(contentPath, value)
  return value
}

function readDocsLastModified(contentPath: string): string | null {
  try {
    const root = findRepositoryRoot()
    if (!root) return null

    const value = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", docsSourcePath(contentPath)],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim()

    return value || null
  } catch {
    return null
  }
}
