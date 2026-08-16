/**
 * The production entry point for refreshing the GitHub mirror.
 *
 * `lib/issues/github-sync.ts` is deliberately dependency-injected and knows
 * nothing about where repos come from or how a token is obtained. This module
 * supplies both, so the scheduler executor and the manual "Sync now" button run
 * exactly the same code path — a difference between the two would show up as
 * "the button works but the schedule doesn't", which is the kind of bug that
 * survives for months.
 *
 * Credentials come from `createResolveOctokit` (the `gh auth token` seam that
 * Agent Team PR feedback already uses). Reusing it means one credential story
 * for every GitHub read in the app rather than a second one that drifts.
 */

import { createResolveOctokit } from "@/lib/ai/agent/team/pr-feedback/resolvers"
import { listIssueProjects } from "@/lib/db/issue-projects"
import type { OctokitLike } from "@/lib/github/issues"
import {
  syncWorkspaceRepos,
  type SyncRepoIssuesDeps,
  type SyncWorkspaceReposResult,
} from "./github-sync"

export interface WorkspaceGithubBinding {
  repoFullName: string
  issueProjectId: string
}

/**
 * Every `github-repo` resource, as (repo → container) pairs. Omit `projectId`
 * to sweep every workspace — that is what the background schedule does, since
 * one refresh task per install beats one per workspace.
 *
 * Deduplicated by repo, first binding wins. A mirror row's primary key is
 * `owner/repo#number`, so it can belong to exactly one container — binding the
 * same repo to two projects would have the second sync silently steal every row
 * from the first. The add-resource dialog refuses that binding up front; this
 * dedup is the backstop for rows that predate the check or arrive by import.
 *
 * Ordering is by container id so the winner is stable across runs rather than
 * dependent on Dexie's iteration order.
 */
export async function resolveWorkspaceGithubBindings(
  projectId?: string
): Promise<WorkspaceGithubBinding[]> {
  const containers = await listIssueProjects(projectId === undefined ? {} : { projectId })
  const seen = new Set<string>()
  const bindings: WorkspaceGithubBinding[] = []

  for (const container of [...containers].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const resource of container.resources) {
      if (resource.kind !== "github-repo") continue
      if (seen.has(resource.repoFullName)) continue
      seen.add(resource.repoFullName)
      bindings.push({ repoFullName: resource.repoFullName, issueProjectId: container.id })
    }
  }

  return bindings
}

export interface RunWorkspaceGithubSyncInput {
  /** Workspace scope. Omit to refresh every bound repo across all workspaces. */
  projectId?: string
  /** Ignore the stored watermark and re-read every issue. */
  full?: boolean
}

export interface RunWorkspaceGithubSyncDeps {
  resolveBindings?: typeof resolveWorkspaceGithubBindings
  /** Returns null when no credential is available — see `createResolveOctokit`. */
  resolveOctokitOrNull?: (repoFullName: string) => Promise<OctokitLike | null>
  sync?: typeof syncWorkspaceRepos
}

export interface RunWorkspaceGithubSyncResult extends SyncWorkspaceReposResult {
  /** Bound repos considered. Zero means nothing is bound — not an error. */
  repoCount: number
}

/** Thrown so a missing credential fails that repo alone, not the whole run. */
export class MissingGithubCredentialError extends Error {
  constructor(repoFullName: string) {
    super(`No GitHub credential available for "${repoFullName}"`)
    this.name = "MissingGithubCredentialError"
    // Subclassing a builtin loses the prototype link when the transform
    // downlevels the class, which silently breaks `instanceof`. Jest's SWC
    // pipeline does exactly that, so restore it explicitly.
    Object.setPrototypeOf(this, MissingGithubCredentialError.prototype)
  }
}

/**
 * Prefer this over `instanceof` at surface boundaries: it survives a downlevel
 * transform and a duplicated module instance, both of which would otherwise
 * turn "connect GitHub first" into a generic "sync failed".
 */
export function isMissingGithubCredential(error: unknown): boolean {
  return error instanceof Error && error.name === "MissingGithubCredentialError"
}

/**
 * Refresh every repo bound in the workspace.
 *
 * A workspace with no bound repo returns an empty success rather than an
 * error: the scheduled task is registered once per install, so "nothing bound
 * yet" is the normal state for most of its life and must not show up as a
 * failing execution in the scheduler history.
 */
export async function runWorkspaceGithubSync(
  input: RunWorkspaceGithubSyncInput,
  deps: RunWorkspaceGithubSyncDeps = {}
): Promise<RunWorkspaceGithubSyncResult> {
  const resolveBindings = deps.resolveBindings ?? resolveWorkspaceGithubBindings
  const bindings = await resolveBindings(input.projectId)
  if (bindings.length === 0) {
    return { repoCount: 0, results: [], failures: [] }
  }

  const resolveOctokitOrNull =
    deps.resolveOctokitOrNull ??
    (createResolveOctokit() as (repoFullName: string) => Promise<OctokitLike | null>)

  const syncDeps: SyncRepoIssuesDeps = {
    resolveOctokit: async (repoFullName) => {
      const octokit = await resolveOctokitOrNull(repoFullName)
      if (!octokit) throw new MissingGithubCredentialError(repoFullName)
      return octokit
    },
  }

  const sync = deps.sync ?? syncWorkspaceRepos
  const result = await sync({ bindings, ...(input.full ? { full: true } : {}) }, syncDeps)
  return { repoCount: bindings.length, ...result }
}
