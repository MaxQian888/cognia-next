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
import type { ReviewRepositoryRefs, ReviewScope } from "@/types/review"

/**
 * Scoped review collection, in two steps.
 *
 * The single-step version asked git for a full diff of EVERY changed file, in
 * one `Promise.all`, across every selected root — a branch review of 300 files
 * fired 300 concurrent diff RPCs before the sheet could render anything. Listing
 * and loading are separated so the file list costs one RPC per root and a hunk
 * diff is paid for only when someone looks at that file.
 *
 * Refs are per repository. Two roots in one review are two repositories with
 * two histories: a commit SHA from one is meaningless in the other, and `main`
 * may not exist there at all. The previous request carried a single
 * `commitSha` / `baseRef` / `targetRef` and applied it to every root.
 */

export interface ReviewScopeRequest {
  scope: ReviewScope
  repositoryRoots: string[]
  /** Refs for one specific root. Overrides {@link defaults} key by key. */
  refsByRoot?: Record<string, ReviewRepositoryRefs>
  /** Applied to any root with no entry of its own. */
  defaults?: ReviewRepositoryRefs
}

export interface ReviewScopeFileRef {
  repositoryRoot: string
  path: string
  oldPath?: string
  source: ReviewScope
  staged?: boolean
  reviewKey: string
  /**
   * Hunks the listing step already had.
   *
   * Only Task Workspace patch sets: they arrive complete in one call, so asking
   * again per file would be a second read of the same thing. Git scopes leave
   * this unset — their hunks cost one diff RPC each, which is the whole reason
   * loading is separate.
   */
  hunks?: ReviewScopedHunk[]
}

export interface ReviewScopedFile extends ReviewScopeFileRef {
  hunks: ReviewScopedHunk[]
}

/** A root that could not be scoped, and the reason a person can act on. */
export interface UnavailableReviewRoot {
  repositoryRoot: string
  reason: "missing-run" | "missing-commit" | "missing-refs"
}

export interface ReviewScopeListing {
  files: ReviewScopeFileRef[]
  /**
   * Roots that were selected but had nothing to scope them by.
   *
   * Reported rather than thrown. Only ONE root can have a last-turn run — the
   * one the active task actually wrote in — so throwing meant a multi-root
   * last-turn review failed entirely, including for the root that did have a
   * run. The same applies to a commit SHA filled in for two of three roots.
   *
   * A genuine RPC failure still throws: "this root has nothing to review" and
   * "git could not answer" are different answers and must not be collapsed.
   */
  unavailable: UnavailableReviewRoot[]
}

export interface ReviewScopedHunk {
  index: number
  hunkHash: string
  header: string
  side: "before" | "after"
  line: number
}

/** The refs that apply to one root: its own entry over the shared defaults. */
export function refsForRoot(
  request: ReviewScopeRequest,
  repositoryRoot: string
): ReviewRepositoryRefs {
  return { ...request.defaults, ...request.refsByRoot?.[repositoryRoot] }
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

function fileRef(
  repositoryRoot: string,
  source: ReviewScope,
  change: GitFileChange
): ReviewScopeFileRef {
  return {
    repositoryRoot,
    path: change.path,
    ...(change.origPath ? { oldPath: change.origPath } : {}),
    source,
    staged: change.staged,
    reviewKey: reviewKey(change),
  }
}

function sortRefs<T extends ReviewScopeFileRef>(refs: T[]): T[] {
  return refs.sort(
    (a, b) =>
      a.repositoryRoot.localeCompare(b.repositoryRoot) ||
      a.path.localeCompare(b.path) ||
      Number(Boolean(a.staged)) - Number(Boolean(b.staged))
  )
}

type RootListing =
  { ok: true; files: ReviewScopeFileRef[] } | { ok: false; reason: UnavailableReviewRoot["reason"] }

async function listRootFiles(
  request: ReviewScopeRequest,
  repositoryRoot: string
): Promise<RootListing> {
  const refs = refsForRoot(request, repositoryRoot)

  if (request.scope === "lastTurn") {
    const runId = refs.lastTurnRunId
    if (!runId) return { ok: false, reason: "missing-run" }
    const patch = await getTaskPatchSet(runId)
    const files = (patch?.files ?? []).map((file) => ({
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
    return { ok: true, files }
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
    return { ok: true, files: changes.map((file) => fileRef(repositoryRoot, request.scope, file)) }
  }

  if (request.scope === "commit") {
    if (!refs.commitSha) return { ok: false, reason: "missing-commit" }
    const commitFiles = await gitCommitFiles(repositoryRoot, refs.commitSha)
    return {
      ok: true,
      files: commitFiles.map((file) => fileRef(repositoryRoot, request.scope, file)),
    }
  }

  if (!refs.baseRef || !refs.targetRef) return { ok: false, reason: "missing-refs" }
  const branchFiles = await gitDiffRefsFiles(repositoryRoot, refs.baseRef, refs.targetRef)
  return {
    ok: true,
    files: branchFiles.map((file) => fileRef(repositoryRoot, request.scope, file)),
  }
}

/**
 * Every file in scope, WITHOUT its hunks.
 *
 * One RPC per root. Task Workspace refs come back with hunks attached because
 * its patch set already contained them.
 */
export async function listReviewScopeFiles(
  request: ReviewScopeRequest
): Promise<ReviewScopeListing> {
  if (request.repositoryRoots.length === 0) throw new Error("Review requires a repository root")
  const batches = await Promise.all(
    request.repositoryRoots.map(async (repositoryRoot) => ({
      repositoryRoot,
      listing: await listRootFiles(request, repositoryRoot),
    }))
  )
  const files: ReviewScopeFileRef[] = []
  const unavailable: UnavailableReviewRoot[] = []
  for (const { repositoryRoot, listing } of batches) {
    if (listing.ok) files.push(...listing.files)
    else unavailable.push({ repositoryRoot, reason: listing.reason })
  }
  return { files: sortRefs(files), unavailable }
}

/** One file's hunks. Free when the listing step already carried them. */
export async function loadReviewScopeFile(
  request: ReviewScopeRequest,
  ref: ReviewScopeFileRef
): Promise<ReviewScopedFile> {
  if (ref.hunks) return { ...ref, hunks: ref.hunks }
  const refs = refsForRoot(request, ref.repositoryRoot)

  if (ref.source === "uncommitted") {
    const diff = await gitDiffFile(ref.repositoryRoot, ref.path, ref.staged ?? false)
    return { ...ref, hunks: gitReviewHunks(diff) }
  }
  if (ref.source === "commit") {
    if (!refs.commitSha) {
      throw new Error(`Commit review requires a commit SHA for ${ref.repositoryRoot}`)
    }
    const diff = await gitDiffCommit(ref.repositoryRoot, refs.commitSha, ref.path)
    return { ...ref, hunks: gitReviewHunks(diff) }
  }
  if (ref.source === "branch") {
    if (!refs.baseRef || !refs.targetRef) {
      throw new Error(`Branch review requires base and target refs for ${ref.repositoryRoot}`)
    }
    const diff = await gitDiffRefsFile(ref.repositoryRoot, refs.baseRef, refs.targetRef, ref.path)
    return { ...ref, hunks: gitReviewHunks(diff) }
  }
  // `lastTurn` always arrives with hunks; reaching here means the patch set was
  // read without them, which is a producer bug rather than an empty diff.
  throw new Error(`Last-turn review returned no hunks for ${ref.path}`)
}
