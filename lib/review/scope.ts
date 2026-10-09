import {
  gitCommitFiles,
  gitDiffCommit,
  gitDiffFile,
  gitDiffRefsFile,
  gitDiffRefsFiles,
  gitStatus,
} from "@/lib/git/commands"
import { hunkContentHash, normalizeReviewKey } from "@/lib/git/hunk-review"
import { parseUnifiedPatch, patchFilePath } from "@/lib/git/unified-patch"
import { getTaskPatchSet, readTaskResourceDiff } from "@/lib/task-workspace/client"
import type { PatchSet } from "@/lib/task-workspace/types"
import type { GitDiff, GitFileChange, GitFileStatus } from "@/types/git"
import type {
  ReviewRepositoryRefs,
  ReviewScope,
  ReviewScopeChoice,
  ReviewScopeSelection,
} from "@/types/review"

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

/** The per-root refs a selection implies. */
export function refsForSelection(selection: ReviewScopeSelection): ReviewRepositoryRefs {
  switch (selection.scope) {
    case "lastTurn":
      return { lastTurnRunId: selection.runId }
    case "commit":
      return { commitSha: selection.commitSha }
    case "branch":
      return { baseRef: selection.baseRef, targetRef: selection.targetRef }
    default:
      return {}
  }
}

/**
 * The selection a scope and one root's refs amount to, for a picker that shows
 * what a refs-based surface (the review sheet) is set to. Missing refs read as
 * empty, which matches nothing in the picker's lists.
 */
export function selectionFromScope(
  scope: ReviewScope,
  refs: ReviewRepositoryRefs
): ReviewScopeSelection {
  switch (scope) {
    case "lastTurn":
      return { scope, runId: refs.lastTurnRunId ?? "" }
    case "commit":
      return { scope, commitSha: refs.commitSha ?? "" }
    case "branch":
      return { scope, baseRef: refs.baseRef ?? "", targetRef: refs.targetRef ?? "" }
    default:
      return { scope }
  }
}

/** Whether two choices name the same target (refs included). */
export function sameScopeChoice(a: ReviewScopeChoice, b: ReviewScopeChoice): boolean {
  if (a.scope !== b.scope) return false
  if (a.scope === "lastTurn" && b.scope === "lastTurn") return a.runId === b.runId
  if (a.scope === "commit" && b.scope === "commit") return a.commitSha === b.commitSha
  if (a.scope === "branch" && b.scope === "branch") {
    return a.baseRef === b.baseRef && a.targetRef === b.targetRef
  }
  return true
}

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
  /** How the file changed, when the listing knew. */
  status?: GitFileStatus
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
    status: change.status,
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
      status: patchStatus(file.kind),
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

  if (
    request.scope === "uncommitted" ||
    request.scope === "staged" ||
    request.scope === "unstaged"
  ) {
    const status = await gitStatus(repositoryRoot)
    const sides =
      request.scope === "staged"
        ? status.staged
        : request.scope === "unstaged"
          ? [...status.changes, ...status.merge]
          : [...status.staged, ...status.changes, ...status.merge]
    const seen = new Set<string>()
    const changes = sides.flatMap((file) => {
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

  // `lastTurn` always arrives with hunks; reaching here means the patch set was
  // read without them, which is a producer bug rather than an empty diff.
  if (ref.source === "lastTurn") {
    throw new Error(`Last-turn review returned no hunks for ${ref.path}`)
  }
  return { ...ref, hunks: gitReviewHunks(await loadGitScopeDiff(refs, ref)) }
}

async function loadGitScopeDiff(
  refs: ReviewRepositoryRefs,
  ref: ReviewScopeFileRef
): Promise<GitDiff> {
  if (ref.source === "commit") {
    if (!refs.commitSha) {
      throw new Error(`Commit review requires a commit SHA for ${ref.repositoryRoot}`)
    }
    return gitDiffCommit(ref.repositoryRoot, refs.commitSha, ref.path)
  }
  if (ref.source === "branch") {
    if (!refs.baseRef || !refs.targetRef) {
      throw new Error(`Branch review requires base and target refs for ${ref.repositoryRoot}`)
    }
    return gitDiffRefsFile(ref.repositoryRoot, refs.baseRef, refs.targetRef, ref.path)
  }
  return gitDiffFile(ref.repositoryRoot, ref.path, ref.staged ?? false)
}

/**
 * One file's full diff, in the shape the diff viewer reads.
 *
 * Git scopes return git's own diff. A turn's diff comes from its Task
 * Workspace run as unified text; it is parsed into hunks and marked
 * `contentOmitted`, because the run keeps the change, not both full texts, so
 * the viewer shows the changed sections.
 */
export async function loadReviewScopeDiff(
  request: ReviewScopeRequest,
  ref: ReviewScopeFileRef
): Promise<GitDiff> {
  const refs = refsForRoot(request, ref.repositoryRoot)
  if (ref.source !== "lastTurn") return loadGitScopeDiff(refs, ref)
  if (!refs.lastTurnRunId) {
    throw new Error(`Turn review requires a run for ${ref.repositoryRoot}`)
  }
  const text = await readTaskResourceDiff(refs.lastTurnRunId, ref.path)
  const files = parseUnifiedPatch(text)
  const file =
    files.find((candidate) => patchFilePath(candidate) === ref.path) ??
    (files.length === 1 ? files[0] : undefined)
  return {
    path: ref.path,
    oldContent: "",
    newContent: "",
    hunks: file?.hunks ?? [],
    isBinary: file?.binary ?? false,
    contentOmitted: true,
  }
}
