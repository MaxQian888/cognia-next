/**
 * Read a GitHub issue's conversation for the issue detail panel.
 *
 * The mirror stores `commentCount` only, and nothing in the app read an
 * issue's comments, so the discussion on GitHub was invisible from the board.
 * This is an on-demand read — opened by the person looking at the issue, never
 * mirrored into Dexie — through the same read credential the mirror sync uses
 * (a connected account first, the `gh` CLI second).
 */

import { createResolveOctokit } from "@/lib/ai/agent/team/pr-feedback/resolvers"
import { hasNextPage, type OctokitLike } from "@/lib/github/issues"
import { MissingGithubCredentialError } from "./sync-runner"

/** 10 × 100 comments. Past that the panel says the list was cut short. */
const MAX_COMMENT_PAGES = 10

export interface GithubIssueComment {
  id: number
  author: string
  authorIsBot: boolean
  body: string
  createdAt: number
  updatedAt: number
  url?: string
}

export interface GithubIssueComments {
  comments: GithubIssueComment[]
  truncated: boolean
}

interface RawComment {
  id?: number
  body?: string | null
  html_url?: string
  created_at?: string
  updated_at?: string
  user?: { login?: string; type?: string } | null
}

export interface FetchGithubIssueCommentsDeps {
  resolveOctokit: (repoFullName: string) => Promise<OctokitLike | null>
}

const DEFAULT_DEPS: FetchGithubIssueCommentsDeps = {
  resolveOctokit: (repoFullName) =>
    (createResolveOctokit() as (name: string) => Promise<OctokitLike | null>)(repoFullName),
}

function toComment(raw: RawComment): GithubIssueComment | null {
  if (typeof raw.id !== "number") return null
  const login = raw.user?.login ?? ""
  return {
    id: raw.id,
    author: login,
    authorIsBot: raw.user?.type === "Bot" || login.endsWith("[bot]"),
    body: raw.body ?? "",
    createdAt: Date.parse(raw.created_at ?? "") || 0,
    updatedAt: Date.parse(raw.updated_at ?? raw.created_at ?? "") || 0,
    ...(raw.html_url ? { url: raw.html_url } : {}),
  }
}

/**
 * Every comment on `owner/repo#number`, oldest first. Throws
 * `MissingGithubCredentialError` when no credential can read the repository,
 * so the panel can say "connect an account" rather than "no comments".
 */
export async function fetchGithubIssueComments(
  target: { repoFullName: string; number: number },
  deps: FetchGithubIssueCommentsDeps = DEFAULT_DEPS
): Promise<GithubIssueComments> {
  const [owner, repo] = target.repoFullName.split("/")
  if (!owner || !repo) throw new Error(`Not an "owner/repository" name: ${target.repoFullName}`)
  const octokit = await deps.resolveOctokit(target.repoFullName)
  if (!octokit) throw new MissingGithubCredentialError(target.repoFullName)

  const comments: GithubIssueComment[] = []
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: target.number, per_page: 100, page }
    )
    const rows = Array.isArray(response.data) ? (response.data as RawComment[]) : []
    for (const row of rows) {
      const comment = toComment(row)
      if (comment) comments.push(comment)
    }
    if (!hasNextPage(response.headers?.link)) return { comments, truncated: false }
  }
  return { comments, truncated: true }
}
