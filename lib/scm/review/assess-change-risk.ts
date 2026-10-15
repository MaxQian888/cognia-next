/**
 * Deterministic risk of an agent changeset, from WHAT it changes (ADR-0227 §3).
 *
 * The ADR-0070 classifier judges a run before it starts, from the tools it can
 * reach. This judges the change after it exists, from its paths and size —
 * the signal that classifier cannot see: a one-line edit to a CI workflow can
 * run arbitrary code on the next push, and a migration can drop a table, while
 * a thousand-line README rewrite cannot. Same tier vocabulary, same "gate on
 * positive evidence" rule: an ordinary source edit is `low`.
 *
 * No model, no I/O. A safety gate must not depend on a model's mood, and the
 * changeset under judgement must not be able to talk its way past it.
 *
 * Reasons are codes, not sentences: the UI translates them, and a test pins
 * each rule by its code.
 */

import { matchGlob } from "@/lib/claude/permissions/ruleset"
import type { RiskTier } from "@/lib/policy/risk/classify-risk"
import { isSensitiveResourcePath } from "@/lib/task-workspace/run-changes"

import type { ReviewPolicy } from "./review-policy"

export type ChangeRiskFileStatus = "added" | "modified" | "deleted" | "renamed" | "typeChanged"

/** The per-file facts a changeset carries (mirrors the host's `ChangesetFile`). */
export interface ChangeRiskFile {
  path: string
  oldPath?: string | null
  status: ChangeRiskFileStatus
  insertions: number | null
  deletions: number | null
  binary: boolean
  /** Classified sensitive by the host. */
  sensitive: boolean
  /** Withheld from the changeset's tree (sensitive files always are). */
  excluded: boolean
}

/**
 * Built-in protected categories. Each one is a path whose change executes code
 * somewhere else, alters data irreversibly, or changes who decides — so a human
 * approves it, whatever the repository's own policy says.
 */
export type ProtectedCategory =
  "ci" | "hooks" | "deploy" | "migrations" | "ownership" | "cogniaConfig" | "repositoryPolicy"

export const BUILTIN_PROTECTED_PATHS: Readonly<
  Record<Exclude<ProtectedCategory, "repositoryPolicy">, readonly string[]>
> = Object.freeze({
  ci: [
    ".github/workflows/**",
    ".github/actions/**",
    ".gitlab-ci.yml",
    ".gitlab/**",
    ".circleci/**",
    ".buildkite/**",
    "azure-pipelines.yml",
    "Jenkinsfile",
    ".drone.yml",
    "bitbucket-pipelines.yml",
  ],
  hooks: [".husky/**", ".githooks/**", ".git-hooks/**", "lefthook.yml", ".pre-commit-config.yaml"],
  deploy: [
    "deploy/**",
    "Dockerfile",
    "**/Dockerfile",
    "docker-compose*.yml",
    "**/docker-compose*.yml",
    "**/*.tf",
    "k8s/**",
    "helm/**",
    "**/wrangler.toml",
  ],
  migrations: ["**/migrations/**", "**/migration/**", "**/*.migration.sql"],
  ownership: ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", ".gitattributes"],
  cogniaConfig: [".cognia/**"],
})

/** Dependency manifests and lockfiles: supply-chain surface, medium on their own. */
export const DEPENDENCY_PATHS: readonly string[] = Object.freeze([
  "package.json",
  "**/package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.toml",
  "**/Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "requirements*.txt",
  "Gemfile",
  "Gemfile.lock",
])

/** Deleting this many files, or this many lines from deleted files, is medium. */
export const MASS_DELETION_FILES = 10
export const MASS_DELETION_LINES = 500

export type ChangeRiskReasonCode =
  | "protectedPath"
  | "dependencyChange"
  | "largeChange"
  | "massDeletion"
  | "binaryChange"
  | "sensitiveWithheld"
  | "humanApprovalAlways"

export interface ChangeRiskReason {
  code: ChangeRiskReasonCode
  /** The paths that tripped the rule (empty for change-wide rules). */
  paths: string[]
  /** For `protectedPath`: which category. */
  category?: ProtectedCategory
  /** For size rules: the measured value. */
  value?: number
}

export interface ChangeRiskAssessment {
  tier: RiskTier
  reasons: ChangeRiskReason[]
  /** Every changed path under protection, built-in or declared. */
  protectedPaths: string[]
  requiresHumanApproval: boolean
  /** Insertions + deletions over text files. */
  changedLines: number
}

/**
 * Globs are matched against the path and against `/path`, so a pattern that
 * starts with `**` followed by a directory also catches that directory at the
 * repository root: `**` in `matchGlob` needs a separator before the literal.
 */
export function pathMatches(glob: string, path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "")
  return matchGlob(glob, normalized) || matchGlob(glob, `/${normalized}`)
}

function touchedPaths(file: ChangeRiskFile): string[] {
  return file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path]
}

function protectedCategoryOf(path: string, policy: ReviewPolicy): ProtectedCategory | null {
  for (const [category, globs] of Object.entries(BUILTIN_PROTECTED_PATHS)) {
    if (globs.some((glob) => pathMatches(glob, path))) return category as ProtectedCategory
  }
  if (policy.protectedPaths.some((glob) => pathMatches(glob, path))) return "repositoryPolicy"
  return null
}

const TIER_ORDER: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 }
function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b
}

export function assessChangeRisk(
  files: readonly ChangeRiskFile[],
  policy: ReviewPolicy
): ChangeRiskAssessment {
  const reasons: ChangeRiskReason[] = []
  let tier: RiskTier = "low"

  const byCategory = new Map<ProtectedCategory, string[]>()
  const dependency: string[] = []
  const binary: string[] = []
  const withheld: string[] = []
  const deleted: string[] = []
  let deletedLines = 0
  let changedLines = 0

  for (const file of files) {
    if (file.excluded || file.sensitive || isSensitiveResourcePath(file.path)) {
      withheld.push(file.path)
      // A withheld file never reaches the integration, so it says nothing
      // about the change's own paths beyond the fact that it was touched.
      continue
    }
    for (const path of touchedPaths(file)) {
      const category = protectedCategoryOf(path, policy)
      if (category) {
        const list = byCategory.get(category) ?? []
        if (!list.includes(path)) list.push(path)
        byCategory.set(category, list)
      }
      if (DEPENDENCY_PATHS.some((glob) => pathMatches(glob, path)) && !dependency.includes(path)) {
        dependency.push(path)
      }
    }
    if (file.binary) binary.push(file.path)
    else changedLines += (file.insertions ?? 0) + (file.deletions ?? 0)
    if (file.status === "deleted") {
      deleted.push(file.path)
      deletedLines += file.deletions ?? 0
    }
  }

  const protectedPaths: string[] = []
  for (const [category, paths] of byCategory) {
    reasons.push({ code: "protectedPath", category, paths })
    protectedPaths.push(...paths)
    tier = "high"
  }
  if (dependency.length > 0) {
    reasons.push({ code: "dependencyChange", paths: dependency })
    tier = maxTier(tier, "medium")
  }
  if (changedLines > policy.largeChangeLines) {
    reasons.push({ code: "largeChange", paths: [], value: changedLines })
    tier = maxTier(tier, "medium")
  }
  if (deleted.length >= MASS_DELETION_FILES || deletedLines >= MASS_DELETION_LINES) {
    reasons.push({ code: "massDeletion", paths: deleted, value: deleted.length })
    tier = maxTier(tier, "medium")
  }
  if (binary.length > 0) {
    reasons.push({ code: "binaryChange", paths: binary })
    tier = maxTier(tier, "medium")
  }
  if (withheld.length > 0) {
    reasons.push({ code: "sensitiveWithheld", paths: withheld })
    tier = maxTier(tier, "medium")
  }

  let requiresHumanApproval = protectedPaths.length > 0 || tier === "high"
  if (policy.humanApproval === "always") {
    requiresHumanApproval = true
    reasons.push({ code: "humanApprovalAlways", paths: [] })
  }

  return { tier, reasons, protectedPaths, requiresHumanApproval, changedLines }
}
