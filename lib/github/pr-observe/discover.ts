/**
 * Discover the open PR for a teammate's worktree branch. GitHub allows at most
 * one open PR per head branch within the same repo, so the first match is the
 * binding. Same-repo heads only — team worktree branches are pushed to origin,
 * never a fork.
 */

import type { ObserveRepo, OctokitLike } from "./types"
import { parseRepoFullName } from "./types"

export interface DiscoveredPr {
  number: number
  url: string
}

/**
 * Find the open PR whose head branch is `branch`. Returns null when none is
 * open (the loop then stays inert for that teammate). A 404 (repo/branch gone)
 * also resolves to null rather than throwing, so a transient discovery miss
 * never aborts the run.
 */
export async function discoverOpenPrForBranch(
  octokit: OctokitLike,
  repo: string | ObserveRepo,
  branch: string
): Promise<DiscoveredPr | null> {
  const r = typeof repo === "string" ? parseRepoFullName(repo) : repo
  let res: Awaited<ReturnType<OctokitLike["request"]>>
  try {
    res = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: r.owner,
      repo: r.name,
      head: `${r.owner}:${branch}`,
      state: "open",
      per_page: 1,
    })
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return null
    throw err
  }
  if (res.status === 404) return null
  const list = Array.isArray(res.data)
    ? (res.data as Array<{ number?: number; html_url?: string; url?: string }>)
    : []
  const first = list[0]
  if (!first || typeof first.number !== "number") return null
  return { number: first.number, url: first.html_url ?? first.url ?? "" }
}
