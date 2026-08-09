import {
  gitCommitFiles,
  gitDiffCommit,
  gitDiffFile,
  gitDiffRefsFile,
  gitDiffRefsFiles,
  gitStatus,
} from "@/lib/git/commands"
import { hunkContentHash, normalizeReviewKey } from "@/lib/git/hunk-review"
import { getTaskPatchSet } from "@/lib/task-workspace/client"
import type { PatchSet } from "@/lib/task-workspace/types"
import type { GitDiff, GitFileChange, GitFileStatus } from "@/types/git"
import type { ReviewScope } from "@/types/review"

export interface ReviewScopeRequest {
  scope: ReviewScope
  repositoryRoots: string[]
  lastTurnRunIdByRoot?: Record<string, string>
  commitSha?: string
  baseRef?: string
  targetRef?: string
}

export interface ReviewScopedFile {
  repositoryRoot: string
  path: string
  oldPath?: string
  source: ReviewScope
  staged?: boolean
  reviewKey: string
  hunks: ReviewScopedHunk[]
}

export interface ReviewScopedHunk {
  index: number
  hunkHash: string
  header: string
  side: "before" | "after"
  line: number
}

function gitReviewHunks(diff: GitDiff): ReviewScopedHunk[] {
  return diff.hunks.map((hunk, index) => {
    const side = hunk.newLines === 0 ? "before" : "after"
    return {
      index,
      hunkHash: hunkContentHash(hunk),
      header: hunk.header,
      side,
      line: side === "before" ? hunk.oldStart : hunk.newStart,
    }
  })
}

function taskWorkspaceHunkAnchor(header: string): Pick<ReviewScopedHunk, "side" | "line"> {
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(header)
  if (!match) throw new Error(`Task Workspace returned an invalid hunk header: ${header}`)
  const oldStart = Number(match[1])
  const newStart = Number(match[3])
  const newLines = match[4] === undefined ? 1 : Number(match[4])
  return newLines === 0 ? { side: "before", line: oldStart } : { side: "after", line: newStart }
}

function patchStatus(kind: PatchSet["files"][number]["kind"]): GitFileStatus {
  if (kind === "created") return "added"
  if (kind === "renamed") return "renamed"
  if (kind === "deleted") return "deleted"
  return "modified"
}

function reviewKey(change: Pick<GitFileChange, "path" | "origPath" | "status">): string {
  return normalizeReviewKey(change)
}

async function gitScopedFile(
  repositoryRoot: string,
  source: ReviewScope,
  change: GitFileChange,
  loadDiff: () => Promise<GitDiff>
): Promise<ReviewScopedFile> {
  return {
    repositoryRoot,
    path: change.path,
    ...(change.origPath ? { oldPath: change.origPath } : {}),
    source,
    staged: change.staged,
    reviewKey: reviewKey(change),
    hunks: gitReviewHunks(await loadDiff()),
  }
}

export async function collectReviewScope(request: ReviewScopeRequest): Promise<ReviewScopedFile[]> {
  if (request.repositoryRoots.length === 0) throw new Error("Review requires a repository root")
  const batches = await Promise.all(
    request.repositoryRoots.map(async (repositoryRoot): Promise<ReviewScopedFile[]> => {
      if (request.scope === "lastTurn") {
        const runId = request.lastTurnRunIdByRoot?.[repositoryRoot]
        if (!runId) throw new Error(`Last-turn review requires a run for ${repositoryRoot}`)
        const patch = await getTaskPatchSet(runId)
        return (patch?.files ?? []).map((file) => ({
          repositoryRoot,
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          source: request.scope,
          reviewKey: reviewKey({
            path: file.path,
            origPath: file.oldPath,
            status: patchStatus(file.kind),
          }),
          hunks: file.hunks.map((hunk, index) => ({
            index,
            hunkHash: hunk.forwardPatchHash,
            header: hunk.header,
            ...taskWorkspaceHunkAnchor(hunk.header),
          })),
        }))
      }
      if (request.scope === "uncommitted") {
        const status = await gitStatus(repositoryRoot)
        const seen = new Set<string>()
        const changes = [...status.staged, ...status.changes, ...status.merge].flatMap((file) => {
          const key = `${file.path}:${file.staged}`
          if (seen.has(key)) return []
          seen.add(key)
          return [file]
        })
        return Promise.all(
          changes.map((file) =>
            gitScopedFile(repositoryRoot, request.scope, file, () =>
              gitDiffFile(repositoryRoot, file.path, file.staged)
            )
          )
        )
      }
      if (request.scope === "commit") {
        if (!request.commitSha) throw new Error("Commit review requires a commit SHA")
        const files = await gitCommitFiles(repositoryRoot, request.commitSha)
        return Promise.all(
          files.map((file) =>
            gitScopedFile(repositoryRoot, request.scope, file, () =>
              gitDiffCommit(repositoryRoot, request.commitSha!, file.path)
            )
          )
        )
      }
      if (!request.baseRef || !request.targetRef) {
        throw new Error("Branch review requires base and target refs")
      }
      const files = await gitDiffRefsFiles(repositoryRoot, request.baseRef, request.targetRef)
      return Promise.all(
        files.map((file) =>
          gitScopedFile(repositoryRoot, request.scope, file, () =>
            gitDiffRefsFile(repositoryRoot, request.baseRef!, request.targetRef!, file.path)
          )
        )
      )
    })
  )
  return batches
    .flat()
    .sort(
      (a, b) =>
        a.repositoryRoot.localeCompare(b.repositoryRoot) ||
        a.path.localeCompare(b.path) ||
        Number(Boolean(a.staged)) - Number(Boolean(b.staged))
    )
}
