/**
 * Conventional Commits → semver bump + release notes generator.
 *
 * Spec: https://www.conventionalcommits.org/en/v1.0.0/
 *
 *   feat:        → minor bump
 *   fix:         → patch bump
 *   <type>!:     → major bump (regardless of type)
 *   BREAKING CHANGE: in footer → major bump
 *   chore/docs/… → no bump (release skipped if all commits are non-bumping)
 *
 * `renderChangelog` produces a Markdown body suitable for the GitHub Release
 * `body` field, grouped by category with author + commit-link footers.
 */

export type SemverPart = "major" | "minor" | "patch" | "none"

export interface ParsedCommit {
  hash: string
  type: string
  scope?: string
  breaking: boolean
  subject: string
  body?: string
  authorName?: string
  authorEmail?: string
}

const HEADER_RE = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!?):\s*(?<subject>.+)$/
const BREAKING_FOOTER_RE = /(^|\n)BREAKING CHANGE:/i

/**
 * Parse one commit message into a {@link ParsedCommit}. Returns null when the
 * header doesn't match the conventional commits grammar — caller treats
 * non-conforming commits as "none" type for bump computation.
 */
export function parseCommitMessage(
  hash: string,
  message: string,
  meta: { authorName?: string; authorEmail?: string } = {}
): ParsedCommit | null {
  const lines = message.split(/\r?\n/)
  const header = lines[0]?.trim() ?? ""
  const m = HEADER_RE.exec(header)
  if (!m?.groups) return null
  const body = lines.slice(1).join("\n").trim() || undefined
  return {
    hash,
    type: m.groups.type.toLowerCase(),
    scope: m.groups.scope,
    breaking: !!m.groups.bang || (body ? BREAKING_FOOTER_RE.test(body) : false),
    subject: m.groups.subject.trim(),
    body,
    ...meta,
  }
}

/**
 * Compute the resulting semver bump given a list of parsed commits.
 *
 * Empty input or all-non-bumping commits → "none". This signals "no release
 * needed" to the calling workflow node.
 */
export function computeBump(commits: ReadonlyArray<ParsedCommit>): SemverPart {
  let bump: SemverPart = "none"
  for (const c of commits) {
    if (c.breaking) return "major"
    if (c.type === "feat" && bump !== "major") bump = "minor"
    else if (c.type === "fix" && bump === "none") bump = "patch"
  }
  return bump
}

/**
 * Apply a bump to a semver string ("X.Y.Z"). Pre-release / build identifiers
 * are stripped because release notes should target a clean version.
 */
export function applyBump(currentVersion: string, bump: SemverPart): string {
  const clean = currentVersion.replace(/^v/i, "").split(/[-+]/)[0]
  const parts = clean.split(".").map((n) => parseInt(n, 10) || 0)
  const maj = parts[0] ?? 0
  const min = parts[1] ?? 0
  const pat = parts[2] ?? 0
  switch (bump) {
    case "major":
      return `${maj + 1}.0.0`
    case "minor":
      return `${maj}.${min + 1}.0`
    case "patch":
      return `${maj}.${min}.${pat + 1}`
    case "none":
      return `${maj}.${min}.${pat}`
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactor",
  docs: "Documentation",
  test: "Tests",
  build: "Build",
  ci: "CI",
  chore: "Chores",
  style: "Style",
  revert: "Reverts",
}

const CATEGORY_ORDER = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "style",
  "revert",
]

/**
 * Render Markdown release notes. Sections appear in {@link CATEGORY_ORDER};
 * any commit with an unknown type is appended under "Other Changes".
 *
 * `repoFullName` is used to render `[abc1234](https://github.com/.../commit/...)`
 * style links. Pass `null` to disable links (useful in tests).
 */
export function renderChangelog(
  commits: ReadonlyArray<ParsedCommit>,
  opts: { bump: SemverPart; repoFullName: string | null; nextVersion: string }
): string {
  const groups: Record<string, ParsedCommit[]> = {}
  for (const c of commits) {
    const key = CATEGORY_LABELS[c.type] ? c.type : "other"
    ;(groups[key] ||= []).push(c)
  }
  const breaking = commits.filter((c) => c.breaking)

  const out: string[] = []
  out.push(`## ${opts.nextVersion}`)
  out.push(`_Bump: ${opts.bump}_`)
  out.push("")

  if (breaking.length > 0) {
    out.push("### ⚠ BREAKING CHANGES")
    for (const c of breaking) {
      out.push(`- ${c.subject} (${formatHash(c.hash, opts.repoFullName)})`)
    }
    out.push("")
  }

  for (const cat of CATEGORY_ORDER) {
    const list = groups[cat]
    if (!list?.length) continue
    out.push(`### ${CATEGORY_LABELS[cat]}`)
    for (const c of list) {
      out.push(`- ${formatLine(c, opts.repoFullName)}`)
    }
    out.push("")
  }

  if (groups.other?.length) {
    out.push("### Other Changes")
    for (const c of groups.other) {
      out.push(`- ${formatLine(c, opts.repoFullName)}`)
    }
    out.push("")
  }

  return out.join("\n").trim() + "\n"
}

function formatLine(c: ParsedCommit, repoFullName: string | null): string {
  const scope = c.scope ? `**${c.scope}**: ` : ""
  return `${scope}${c.subject} (${formatHash(c.hash, repoFullName)})`
}

function formatHash(hash: string, repoFullName: string | null): string {
  const short = hash.slice(0, 7)
  if (!repoFullName) return short
  return `[${short}](https://github.com/${repoFullName}/commit/${hash})`
}
