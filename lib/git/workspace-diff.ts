/**
 * The working tree's current diff as one clamped unified-patch text.
 *
 * Built for the independent reviewer (ADR-0117 `verified-fresh-agent`): the
 * verifier gets the user's request, the main agent's final reply and, when the
 * turn ran inside a repository, what actually changed on disk. Nothing else in
 * `lib/git/` returns the whole working-tree diff as text: `gitDiffStagedAll`
 * covers only the index, and `gitDiffFile` answers one path at a time. This
 * composes the per-path reader over `collectWorkspaceChanges`, which already
 * dedupes a path that is both staged and modified.
 *
 * Pure over injected readers so a test never needs the git bridge. The
 * production defaults are the seam wrappers in `./commands`, which short
 * circuit to empty answers when there is no host runtime, so a shell without a
 * git bridge reads as "no diff" rather than throwing into the verifier.
 */

import { gitDiffFile, gitIsRepo, gitStatus } from "./commands"
import { clampDiff } from "./ai-commit"
import { collectWorkspaceChanges } from "./workspace-changes"
import type { GitDiff, GitStatus } from "@/types/git"

export interface WorkspaceDiffReaderDeps {
  isRepo: (repoPath: string) => Promise<boolean>
  status: (repoPath: string) => Promise<GitStatus>
  diffFile: (repoPath: string, path: string, staged: boolean) => Promise<GitDiff>
}

export interface WorkspaceDiffSnapshot {
  /** Unified patch text, clamped to `maxChars`. Empty when nothing changed. */
  text: string
  /** Distinct paths that contributed at least one hunk. */
  fileCount: number
  /** True when `text` was cut to fit the budget. */
  truncated: boolean
}

export const EMPTY_WORKSPACE_DIFF: WorkspaceDiffSnapshot = Object.freeze({
  text: "",
  fileCount: 0,
  truncated: false,
})

/** Generous enough for a typical turn, small enough to leave the verifier room to think. */
export const DEFAULT_WORKSPACE_DIFF_CHAR_BUDGET = 40_000

const defaultDeps: WorkspaceDiffReaderDeps = {
  isRepo: gitIsRepo,
  status: gitStatus,
  diffFile: gitDiffFile,
}

function patchOf(diff: GitDiff): string {
  if (diff.isBinary) return ""
  return diff.hunks
    .map((hunk) => hunk.patch.trim())
    .filter(Boolean)
    .join("\n")
}

/**
 * Read every changed path (staged, unstaged and merge entries) and join their
 * hunks. A path present in both the index and the working tree contributes
 * both diffs, labelled, so the verifier can tell what is already staged.
 */
export async function readWorkspaceDiff(
  repoPath: string,
  options: {
    maxChars?: number
    deps?: WorkspaceDiffReaderDeps
  } = {}
): Promise<WorkspaceDiffSnapshot> {
  const deps = options.deps ?? defaultDeps
  const maxChars = options.maxChars ?? DEFAULT_WORKSPACE_DIFF_CHAR_BUDGET
  const root = repoPath.trim()
  if (!root) return EMPTY_WORKSPACE_DIFF
  if (!(await deps.isRepo(root))) return EMPTY_WORKSPACE_DIFF

  const status = await deps.status(root)
  const files = collectWorkspaceChanges(status)
  if (files.length === 0) return EMPTY_WORKSPACE_DIFF

  const sections: string[] = []
  let fileCount = 0
  for (const file of files) {
    const staged = file.changes.some((change) => change.staged)
    const unstaged = file.changes.some((change) => !change.staged)
    const fileSections: string[] = []
    if (staged) {
      const patch = patchOf(await deps.diffFile(root, file.path, true))
      if (patch) fileSections.push(`# ${file.path} (staged)\n${patch}`)
    }
    if (unstaged) {
      const patch = patchOf(await deps.diffFile(root, file.path, false))
      if (patch) fileSections.push(`# ${file.path}\n${patch}`)
    }
    if (fileSections.length > 0) {
      fileCount += 1
      sections.push(...fileSections)
    }
  }

  if (sections.length === 0) return EMPTY_WORKSPACE_DIFF
  const full = sections.join("\n\n")
  const text = clampDiff(full, maxChars)
  return { text, fileCount, truncated: text.length < full.length }
}
