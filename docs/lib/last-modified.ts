import { execFileSync } from "node:child_process"

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

export function docsSourceCandidates(lang: string, slug: string[] | undefined): string[] {
  const stem = ["docs", "content", "docs", lang, ...(slug?.length ? slug : ["index"])].join("/")
  return [`${stem}.mdx`, `${stem}.md`]
}

/** Build-time git timestamp; null keeps the footer hidden outside a Git checkout. */
export function getDocsLastModified(lang: string, slug?: string[]): string | null {
  try {
    const root = findRepositoryRoot()
    if (!root) return null
    for (const sourcePath of docsSourceCandidates(lang, slug)) {
      const value = execFileSync("git", ["log", "-1", "--format=%cI", "--", sourcePath], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      if (value) return value
    }
    return null
  } catch {
    return null
  }
}
