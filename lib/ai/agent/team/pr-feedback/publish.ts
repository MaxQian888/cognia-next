/**
 * Optional auto-publish: push a teammate's worktree branch and open a PR so the
 * observer has something to watch. Off by default (`config.prFeedback.publishPr`);
 * when a team doesn't publish, teammates may still open PRs themselves via their
 * git/gh tools and the observer discovers those by branch.
 *
 * Idempotent: if a PR already exists for the head branch (opened earlier this run
 * or by the teammate), it is returned without pushing or re-creating — and a 422
 * race (PR created between the discover and the create) rediscovers instead of
 * failing the run.
 *
 * The git push is an injected seam so this is testable without Tauri; the real
 * wiring uses `gitPush(..., { remote: "origin", setUpstream: true })`.
 */

import { discoverOpenPrForBranch } from "@/lib/github/pr-observe/discover"
import { parseRepoFullName, type OctokitLike } from "@/lib/github/pr-observe/types"

/** Injected git push seam (real impl wraps `lib/git/commands.ts:gitPush`). */
export interface PublishGitOps {
  push(worktreePath: string, branch: string): Promise<void>
}

export interface PublishPrArgs {
  /** "owner/name". */
  repo: string
  /** Head branch (the teammate's worktree branch). */
  branch: string
  /** Base branch to target. */
  baseBranch: string
  /** Worktree path to push from. */
  worktreePath: string
  title: string
  body?: string
  draft?: boolean
}

export interface PublishedPr {
  number: number
  url: string
  /** True when this call created the PR; false when it already existed. */
  created: boolean
}

export async function publishTeammatePr(
  octokit: OctokitLike,
  git: PublishGitOps,
  args: PublishPrArgs
): Promise<PublishedPr | null> {
  const repo = parseRepoFullName(args.repo)

  // Already open? Return it — never push/create twice.
  const existing = await discoverOpenPrForBranch(octokit, repo, args.branch)
  if (existing) return { number: existing.number, url: existing.url, created: false }

  await git.push(args.worktreePath, args.branch)

  try {
    const res = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: repo.owner,
      repo: repo.name,
      head: args.branch,
      base: args.baseBranch,
      title: args.title,
      body: args.body ?? "",
      draft: args.draft ?? false,
    })
    const data = (res.data ?? {}) as { number?: number; html_url?: string }
    if (typeof data.number !== "number") return null
    return { number: data.number, url: data.html_url ?? "", created: true }
  } catch (err) {
    // 422: a PR for this head/base already exists (race) — rediscover it.
    if ((err as { status?: number })?.status === 422) {
      const found = await discoverOpenPrForBranch(octokit, repo, args.branch)
      if (found) return { number: found.number, url: found.url, created: false }
    }
    throw err
  }
}
