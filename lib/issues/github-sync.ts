/**
 * GitHub → mirror sync.
 *
 * Ties `lib/github/issues.ts` (fetch) to `lib/db/github-issue-mirror.ts`
 * (store). Nothing else calls the network on the issue board's behalf: opening
 * `/issues` reads Dexie only, so a slow or expired token degrades to
 * stale-but-visible rather than a blank board.
 *
 * The incremental contract is `since` + `ETag`:
 *   - `since` is the newest `updatedAt` already mirrored, so a routine sync
 *     asks only for what changed.
 *   - the ETag revalidates that answer; a 304 means the cache is current and
 *     nothing is written. This is the path `proxyFetch`'s null-body bug used to
 *     break, which is why that fix ships alongside.
 *
 * Deps are injected so the whole flow is testable without a network, a
 * keyring, or Dexie mocking games.
 */

import { fetchRepoIssues, type OctokitLike } from "@/lib/github/issues"
import {
  latestMirroredUpdate,
  repoMirrorEtag,
  upsertGithubIssues,
} from "@/lib/db/github-issue-mirror"

export interface SyncRepoIssuesDeps {
  resolveOctokit: (repoFullName: string) => Promise<OctokitLike>
  latestMirroredUpdate?: typeof latestMirroredUpdate
  repoMirrorEtag?: typeof repoMirrorEtag
  upsertGithubIssues?: typeof upsertGithubIssues
  now?: () => number
}

export interface SyncRepoIssuesInput {
  repoFullName: string
  /** Delivery container to bind the mirrored rows to. */
  issueProjectId: string
  /**
   * Ignore the stored watermark and re-read everything. The manual "Sync now"
   * affordance uses this so a user who suspects drift has a way out that does
   * not involve clearing the cache by hand.
   */
  full?: boolean
}

export interface SyncRepoIssuesResult {
  repoFullName: string
  /** Rows written. Zero on a 304, and on a genuinely quiet window. */
  written: number
  notModified: boolean
  truncated: boolean
  rateLimitRemaining?: number
}

/**
 * `since` must be strictly newer than nothing and inclusive of the last known
 * change — GitHub's `since` is inclusive, so passing the exact watermark
 * re-returns the boundary issue. That is deliberate: re-writing one unchanged
 * row is cheaper than risking a missed edit that landed in the same second.
 */
function sinceFor(watermark: number | undefined): string | undefined {
  return watermark === undefined ? undefined : new Date(watermark).toISOString()
}

export async function syncRepoIssues(
  input: SyncRepoIssuesInput,
  deps: SyncRepoIssuesDeps
): Promise<SyncRepoIssuesResult> {
  const readWatermark = deps.latestMirroredUpdate ?? latestMirroredUpdate
  const readEtag = deps.repoMirrorEtag ?? repoMirrorEtag
  const write = deps.upsertGithubIssues ?? upsertGithubIssues
  const now = deps.now ?? Date.now

  const [watermark, etag] = input.full
    ? [undefined, undefined]
    : await Promise.all([readWatermark(input.repoFullName), readEtag(input.repoFullName)])

  const octokit = await deps.resolveOctokit(input.repoFullName)
  const result = await fetchRepoIssues(octokit, {
    repoFullName: input.repoFullName,
    issueProjectId: input.issueProjectId,
    now: now(),
    ...(sinceFor(watermark) ? { since: sinceFor(watermark) } : {}),
    ...(etag ? { etag } : {}),
  })

  if (!result.notModified && result.rows.length > 0) {
    await write(result.rows)
  }

  return {
    repoFullName: input.repoFullName,
    written: result.notModified ? 0 : result.rows.length,
    notModified: result.notModified,
    truncated: result.truncated,
    ...(result.rateLimitRemaining !== undefined
      ? { rateLimitRemaining: result.rateLimitRemaining }
      : {}),
  }
}

export interface SyncWorkspaceReposInput {
  /** Every (repo, container) pair bound in the workspace. */
  bindings: ReadonlyArray<{ repoFullName: string; issueProjectId: string }>
  full?: boolean
}

export interface SyncWorkspaceReposResult {
  results: SyncRepoIssuesResult[]
  failures: Array<{ repoFullName: string; error: unknown }>
}

/**
 * Sync every bound repo. One repo failing must not abandon the rest — a single
 * revoked installation should not leave the whole board stale, and the caller
 * needs to know which repo to complain about.
 */
export async function syncWorkspaceRepos(
  input: SyncWorkspaceReposInput,
  deps: SyncRepoIssuesDeps
): Promise<SyncWorkspaceReposResult> {
  const results: SyncRepoIssuesResult[] = []
  const failures: Array<{ repoFullName: string; error: unknown }> = []

  for (const binding of input.bindings) {
    try {
      results.push(
        await syncRepoIssues(
          {
            repoFullName: binding.repoFullName,
            issueProjectId: binding.issueProjectId,
            ...(input.full ? { full: true } : {}),
          },
          deps
        )
      )
    } catch (error) {
      failures.push({ repoFullName: binding.repoFullName, error })
    }
  }

  return { results, failures }
}
