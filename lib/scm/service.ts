/**
 * One source-control port (ADR-0227 §4).
 *
 * Callers that are not the Source Control panel — the changeset pipeline, the
 * Agent Team integration, a workflow node, a plugin host API — ask this for
 * snapshot, diff, history, blame, commit, merge and rollback instead of
 * reaching for `lib/git/commands` and the task-workspace client separately.
 * Git is the only backend; the registry exists so another one can be added
 * without a second facade, not because there is one.
 *
 * Local and remote are not two backends. A `repo` here is whatever
 * `lib/git/commands` accepts — a local path or an opaque `git-workspace:`
 * target — and the routed transport sends the call to the host that owns the
 * checkout. So the same service works on the desktop, a paired phone and the
 * always-on host.
 */

import {
  gitBlame,
  gitBranches,
  gitCommit,
  gitCreateBranch,
  gitDiffFile,
  gitDiffRefsFile,
  gitDiffRefsFiles,
  gitFileHistory,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitReadBlobAtRef,
  gitRevert,
  gitStatus,
} from "@/lib/git/commands"
import type {
  GitBlameLine,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileChange,
  GitStatus,
} from "@/types/git"

import { createScmHost, type ScmHost } from "./host"
import type { AgentChangeset, CaptureChangeset, IntegrationRun } from "./types"

export interface HistoryQuery {
  maxCount: number
  skip?: number
  /** Only commits that touched this repository-relative path. */
  path?: string
}

export interface SourceControlService {
  readonly kind: string
  status(repo: string): Promise<GitStatus>
  branches(repo: string): Promise<GitBranch[]>
  /** Create `name` at `from` without checking it out. */
  createBranch(repo: string, name: string, from: string): Promise<void>
  /** Working-tree diff of one file; `staged` compares HEAD to the index. */
  diffWorking(repo: string, path: string, staged: boolean): Promise<GitDiff>
  /** Files changed between two revisions (from their merge base). */
  diffRevisions(repo: string, base: string, target: string): Promise<GitFileChange[]>
  diffRevisionFile(repo: string, base: string, target: string, path: string): Promise<GitDiff>
  readFileAt(repo: string, rev: string, path: string): Promise<string | null>
  history(repo: string, query: HistoryQuery): Promise<GitCommit[]>
  blame(repo: string, path: string, rev?: string): Promise<GitBlameLine[]>
  /** Commit the index; resolves to the new commit's SHA. */
  commit(
    repo: string,
    message: string,
    options?: { amend?: boolean; signoff?: boolean }
  ): Promise<string>
  merge(repo: string, branch: string): Promise<void>
  abortMerge(repo: string): Promise<void>
  /** Revert one commit with a new commit (the reviewable undo of a published change). */
  revert(repo: string, sha: string): Promise<void>
  /** Capture an agent's isolated workspace as an immutable, reviewable changeset. */
  snapshot(input: CaptureChangeset): Promise<AgentChangeset>
  /** Undo a published integration by compare-and-swap, or by revert once the target moved on. */
  rollback(integrationId: string): Promise<IntegrationRun>
  /** The changeset and integration queue host commands. */
  readonly changesets: ScmHost
}

export type SourceControlBackendFactory = () => SourceControlService

const backends = new Map<string, SourceControlBackendFactory>()

export const GIT_BACKEND = "git"

/** The Git backend over the transport-routed `lib/git/commands` wrappers. */
export function createGitSourceControlService(
  host: ScmHost = createScmHost()
): SourceControlService {
  return {
    kind: GIT_BACKEND,
    status: (repo) => gitStatus(repo),
    branches: (repo) => gitBranches(repo),
    createBranch: (repo, name, from) => gitCreateBranch(repo, name, false, from),
    diffWorking: (repo, path, staged) => gitDiffFile(repo, path, staged),
    diffRevisions: (repo, base, target) => gitDiffRefsFiles(repo, base, target),
    diffRevisionFile: (repo, base, target, path) => gitDiffRefsFile(repo, base, target, path),
    readFileAt: (repo, rev, path) => gitReadBlobAtRef(repo, rev, path),
    history: (repo, query) =>
      query.path
        ? gitFileHistory(repo, query.path, query.maxCount)
        : gitLog(repo, query.maxCount, query.skip ?? 0),
    blame: (repo, path, rev) => gitBlame(repo, path, rev),
    commit: (repo, message, options = {}) =>
      gitCommit(repo, message, options.amend ?? false, options.signoff ?? false),
    merge: (repo, branch) => gitMerge(repo, branch),
    abortMerge: (repo) => gitMergeAbort(repo),
    revert: (repo, sha) => gitRevert(repo, sha),
    snapshot: (input) => host.captureChangeset(input),
    rollback: (integrationId) => host.rollbackIntegration(integrationId),
    changesets: host,
  }
}

backends.set(GIT_BACKEND, () => createGitSourceControlService())

/** Register another backend. Returns the unregister function. Refuses to shadow one. */
export function registerSourceControlBackend(
  kind: string,
  factory: SourceControlBackendFactory
): () => void {
  if (backends.has(kind)) throw new Error(`source-control backend "${kind}" is already registered`)
  backends.set(kind, factory)
  return () => {
    if (backends.get(kind) === factory) backends.delete(kind)
  }
}

export function listSourceControlBackends(): string[] {
  return [...backends.keys()]
}

/** The service for `kind` (Git by default). */
export function getSourceControlService(kind: string = GIT_BACKEND): SourceControlService {
  const factory = backends.get(kind)
  if (!factory) throw new Error(`no source-control backend "${kind}"`)
  return factory()
}
