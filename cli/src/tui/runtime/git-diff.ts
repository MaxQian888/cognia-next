import { lstat } from "node:fs/promises"
import { runGit, type ExecFn } from "../../agent/run-git"
import { createCliTranslator, type CliLocale } from "../i18n"

/** Git review inventory and legacy document formatting for terminal callers. */

/** A diff section title + raw `git diff` text. */
interface DiffSection {
  heading: string
  diff: string
}

/** Stable patch headers identify distinct files in the legacy document format. */
function changedFiles(diff: string): string[] {
  return diff.split("\n").filter((line) => line.startsWith("diff --git "))
}

/**
 * Compose the `/diff` document from the unstaged + staged `git diff` outputs.
 * Empty / whitespace-only sections are dropped. Returns null when both are empty.
 */
export function buildGitDiffDoc(
  unstaged: string,
  staged: string,
  locale?: CliLocale
): { title: string; body: string } | null {
  const t = createCliTranslator(locale, "cliUiDiff")
  const sections: DiffSection[] = []
  if (staged.trim()) sections.push({ heading: t("staged"), diff: staged.trim() })
  if (unstaged.trim()) sections.push({ heading: t("unstaged"), diff: unstaged.trim() })
  if (sections.length === 0) return null

  const totalFiles = new Set(sections.flatMap((section) => changedFiles(section.diff))).size
  const parts = [
    `# ${t("workingTitle")}`,
    ``,
    t(totalFiles === 1 ? "changedOne" : "changed", { count: totalFiles }),
    ``,
  ]
  for (const s of sections) {
    parts.push(`## ${s.heading}`, ``, "```diff", s.diff, "```", ``)
  }
  return { title: t("title"), body: parts.join("\n").trimEnd() }
}

export type GitDiffScope = "all" | "staged" | "unstaged" | "untracked" | "branch"

export interface GitDiffFile {
  path: string
  staged: string
  unstaged: string
  untracked: string
  branch?: string
  /** Git lists embedded repositories as opaque untracked directories. */
  untrackedDirectory?: boolean
}

export interface GitDiffReview {
  files: GitDiffFile[]
  /** Explicit comparison base: branch patches show merge-base(base, HEAD)..HEAD. */
  baseRef?: string
}

/** Read-only inventory. NUL-delimited names and argv keep unusual paths literal. */
export async function loadGitDiff(
  cwd: string,
  baseRef?: string,
  exec?: ExecFn
): Promise<GitDiffReview> {
  const git = async (args: string[], allowDifference = false): Promise<string> => {
    const result = await runGit(args, cwd, exec)
    if (
      result.error ||
      (result.code !== 0 && !(allowDifference && result.code === 1 && !result.stderr.trim()))
    ) {
      throw new Error(
        result.error || result.stderr.trim() || `git ${args[0]} failed (${result.code})`
      )
    }
    return result.stdout
  }
  const root = (await git(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "")
  // Resolve the revision before passing it to diff. --end-of-options blocks ref-as-option.
  const base = baseRef
    ? (await git(["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])).trim()
    : undefined
  const comparison = base ? `${base}...HEAD` : undefined
  const commands: Array<{ scope: Exclude<GitDiffScope, "all">; args: string[] }> = [
    { scope: "staged", args: ["diff", "--cached"] },
    { scope: "unstaged", args: ["diff"] },
    ...(comparison ? [{ scope: "branch" as const, args: ["diff", comparison] }] : []),
  ]
  const files = new Map<string, GitDiffFile>()
  const getFile = (path: string): GitDiffFile => {
    let file = files.get(path)
    if (!file) {
      file = { path, staged: "", unstaged: "", untracked: "" }
      files.set(path, file)
    }
    return file
  }
  for (const { scope, args } of commands) {
    const options = [
      "--no-relative",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
    ]
    const combined = await git([...args, ...options, "--raw", "-z", "--patch", "--"])
    const patches = splitRawGitDiff(combined)
    if (patches) {
      for (const patch of patches) getFile(patch.path)[scope] = patch.body
    } else {
      // Combined/unmerged diff formats vary. Preserve their full git output
      // with literal per-path queries instead of guessing a file association.
      const names = await git([...args, "--name-only", "--no-relative", "--no-renames", "-z", "--"])
      for (const path of names.split("\0").filter(Boolean)) {
        getFile(path)[scope] = await git([...args, ...options, "--", `:(top,literal)${path}`])
      }
    }
  }
  const untracked = await git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--full-name",
    "-z",
    "--",
    ":(top)**",
  ])
  for (const path of untracked.split("\0").filter(Boolean)) {
    // Never pass a directory to --no-index with /dev/null: Git would compare
    // against <directory>/null. Keep the boundary Git reported without traversing it.
    if (path.endsWith("/") && (await lstat(`${root}/${path}`)).isDirectory()) {
      getFile(path).untrackedDirectory = true
      continue
    }
    let patch = await git(
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        "/dev/null",
        `${root}/${path}`,
      ],
      true
    )
    if (!patch) {
      // Some Git versions produce no patch for an empty new file. Only synthesize
      // metadata after verifying that no content or special file is being hidden.
      const stat = await lstat(`${root}/${path}`)
      if (!stat.isFile() || stat.size !== 0) throw new Error(`Git returned no patch for ${path}`)
      const mode = stat.mode & 0o111 ? "100755" : "100644"
      patch = `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\nnew file mode ${mode}\n`
    }
    getFile(path).untracked = patch
  }
  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    ...(baseRef ? { baseRef } : {}),
  }
}

export function gitDiffFileBody(
  file: GitDiffFile,
  scope: GitDiffScope,
  locale?: CliLocale
): string {
  if (file.untrackedDirectory && (scope === "all" || scope === "untracked")) {
    return createCliTranslator(locale, "cliUiDiff")("directoryDetails")
  }
  return scope === "all"
    ? [file.staged, file.unstaged, file.untracked].filter(Boolean).join("\n")
    : (file[scope] ?? "")
}

/** Git emits raw NUL-delimited path records followed by patches in the same order. */
export function splitRawGitDiff(output: string): Array<{ path: string; body: string }> | null {
  if (!output) return []
  const boundary = output.indexOf("\0\0")
  if (boundary < 0) return null
  const records = output.slice(0, boundary).split("\0")
  if (records.length % 2 !== 0) return null
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 2) {
    // --no-renames guarantees exactly one path per ordinary record.
    // Unmerged and combined records deliberately fall back to git itself.
    if (!/^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ [ACDMT]$/.test(records[index])) return null
    paths.push(records[index + 1])
  }
  const patches = output.slice(boundary + 2).split(/(?=^diff --git )/m)
  if (patches.length !== paths.length || patches.some((patch) => !patch.startsWith("diff --git ")))
    return null
  return paths.map((path, index) => ({ path, body: patches[index] }))
}

/** Count changed lines inside hunks only; metadata and binary payloads are not lines. */
export function gitDiffFileStats(
  file: GitDiffFile,
  scope: GitDiffScope
): { additions: number; deletions: number; binary: boolean; hunks: number } {
  const stats = { additions: 0, deletions: 0, binary: false, hunks: 0 }
  let columns = 0
  for (const line of gitDiffFileBody(file, scope).split("\n")) {
    if (/^diff --(?:git|cc|combined) /.test(line)) columns = 0
    const hunk = /^(@{2,}) .* \1(?: |$)/.exec(line)
    if (hunk) {
      columns = hunk[1].length - 1
      stats.hunks++
    } else if (columns) {
      const prefix = line.slice(0, columns)
      if (prefix.length === columns && /^[ +\-]+$/.test(prefix)) {
        if (prefix.includes("+")) stats.additions++
        if (prefix.includes("-")) stats.deletions++
      }
    } else if (/^(?:Binary files .* differ|GIT binary patch)$/.test(line)) stats.binary = true
  }
  return stats
}
