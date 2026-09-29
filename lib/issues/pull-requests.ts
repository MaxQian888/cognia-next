/**
 * Linked pull requests on an issue (`github-pr` refs), for `until-pr` wakeups.
 *
 * Two writers keep the refs honest:
 *
 *   - the GitHub import sweep (`lib/issues/sync/engine.ts` `linkRemote`) links
 *     every PR that names an issue and records the state it saw, each pass;
 *   - a settled run links the PRs it opened (`linkRunPullRequests`), so a PR
 *     the GitHub loop or a squad opened is on the issue even when its text
 *     never names it.
 *
 * State moves only when the sweep observes it, so an `until-pr` rule needs
 * the issue's container bound to its repository in import mode; the wakeup
 * service refuses one that could never fire. The same sweep reads an open
 * linked pull request's CI (`fetchPullRequestCi`), so a `pr-checks` rule
 * has the same requirement.
 */

import type {
  Issue,
  IssueActor,
  IssuePullRequestCiState,
  IssuePullRequestState,
  IssueRunArtifact,
} from "@/types/issues"
import { isIssuePullRequestCiState, isIssuePullRequestState } from "@/types/issues"
import type { OctokitLike } from "@/lib/github/issues"

/** The ref provider every linked pull request is stored under. */
export const PULL_REQUEST_REF_PROVIDER = "github-pr"

/** `owner/repo#12` — the `externalId` of a `github-pr` ref. */
export function pullRequestExternalId(repoFullName: string, number: number): string {
  return `${repoFullName}#${number}`
}

/**
 * A pull request's web URL → its ref id, or `undefined` for anything that is
 * not one (a branch, a session route, an issue URL). Any host: GitHub
 * Enterprise serves pull requests under the same path shape.
 */
export function parsePullRequestUrl(
  href: string
): { repoFullName: string; number: number; url: string } | undefined {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:") return undefined
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname)
  if (!match) return undefined
  const number = Number(match[3])
  if (!Number.isSafeInteger(number) || number <= 0) return undefined
  return { repoFullName: `${match[1]}/${match[2]}`, number, url: `${url.origin}${url.pathname}` }
}

/** GitHub's REST pull shape → our state. `merged_at` wins over `state: closed`. */
export function pullRequestStateOf(raw: {
  state?: string | null
  merged_at?: string | null
  merged?: boolean | null
}): IssuePullRequestState | undefined {
  if (raw.merged_at || raw.merged === true) return "merged"
  if (raw.state === "closed") return "closed"
  if (raw.state === "open") return "open"
  return undefined
}

/** The linked pull requests of an issue with the state and CI last observed, if any. */
export function linkedPullRequests(issue: Pick<Issue, "externalRefs">): {
  externalId: string
  url?: string
  state?: IssuePullRequestState
  ci?: IssuePullRequestCiState
}[] {
  return (issue.externalRefs ?? [])
    .filter((ref) => ref.provider === PULL_REQUEST_REF_PROVIDER)
    .map((ref) => {
      const state = ref.meta?.prState
      const ci = ref.meta?.ciState
      return {
        externalId: ref.externalId,
        ...(ref.url ? { url: ref.url } : {}),
        ...(isIssuePullRequestState(state) ? { state } : {}),
        ...(isIssuePullRequestCiState(ci) ? { ci } : {}),
      }
    })
}

/**
 * Has an open linked pull request's CI settled — to `result`, or to either
 * passing or failing when none is named? A merged or closed PR's last CI is
 * history, not an answer.
 */
export function hasSettledPullRequestChecks(
  issue: Pick<Issue, "externalRefs">,
  result?: "passing" | "failing"
): boolean {
  return linkedPullRequests(issue).some(
    (pr) =>
      pr.state !== "merged" &&
      pr.state !== "closed" &&
      (result ? pr.ci === result : pr.ci === "passing" || pr.ci === "failing")
  )
}

/** Check-run pages read per commit: 3 × 100, beyond which a PR is unusual enough to call pending. */
const CI_CHECK_RUN_PAGES = 3

/**
 * A commit's CI, rolled up over its check runs and commit statuses by the
 * same `summarizeCi` the Agent Team PR observer uses. `undefined` when the
 * commit has no checks at all. Deliberately not the observer's own fetch: that
 * one is ETag-cached against a persisted observation and also reads reviews
 * and comments, none of which a sweep over many pull requests should pay for.
 */
export async function fetchPullRequestCi(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  sha: string
): Promise<IssuePullRequestCiState | undefined> {
  const { summarizeCi } = await import("@/lib/github/pr-observe/fetch")
  const checkRuns: Parameters<typeof summarizeCi>[1] = []
  let truncated = false
  for (let page = 1; page <= CI_CHECK_RUN_PAGES; page += 1) {
    const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner,
      repo,
      ref: sha,
      per_page: 100,
      page,
    })
    const body = (response.data ?? {}) as {
      total_count?: number
      check_runs?: Parameters<typeof summarizeCi>[1]
    }
    const runs = Array.isArray(body.check_runs) ? body.check_runs : []
    checkRuns.push(...runs)
    if (runs.length < 100 || checkRuns.length >= (body.total_count ?? 0)) break
    if (page === CI_CHECK_RUN_PAGES) truncated = true
  }
  const status = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
    owner,
    repo,
    ref: sha,
    per_page: 100,
  })
  const summary = summarizeCi(
    sha,
    checkRuns,
    (status.data ?? null) as Parameters<typeof summarizeCi>[2]
  ).summary
  if (summary === "failing") return "failing"
  // Unread runs could still be going, so an unfinished read is not "passing".
  if (summary === "pending" || (truncated && summary === "passing")) return "pending"
  if (summary === "passing") return "passing"
  return undefined
}

/** Has any linked pull request been observed merged? */
export function hasMergedPullRequest(issue: Pick<Issue, "externalRefs">): boolean {
  return linkedPullRequests(issue).some((pr) => pr.state === "merged")
}

export interface LinkRunPullRequestsDeps {
  getIssue: (id: string) => Promise<Issue | undefined>
  link: (
    id: string,
    ref: { provider: string; externalId: string; url: string; label?: string },
    by: IssueActor
  ) => Promise<void>
}

async function defaultDeps(): Promise<LinkRunPullRequestsDeps> {
  const { getIssue, linkIssueExternal } = await import("@/lib/db/issues")
  return { getIssue, link: linkIssueExternal }
}

/**
 * Link the pull requests among a settled run's artifacts onto its issue as
 * `github-pr` refs. A ref already there is left alone, so the state and the
 * binding the sweep stamped on it survive. Returns the ids it linked.
 */
export async function linkRunPullRequests(
  issueId: string,
  artifacts: readonly IssueRunArtifact[],
  by: IssueActor,
  deps?: LinkRunPullRequestsDeps
): Promise<string[]> {
  const pulls = artifacts.flatMap((artifact) => {
    const parsed = parsePullRequestUrl(artifact.href)
    return parsed ? [{ ...parsed, label: artifact.label }] : []
  })
  if (pulls.length === 0) return []
  const resolved = deps ?? (await defaultDeps())
  const issue = await resolved.getIssue(issueId)
  if (!issue) return []
  const known = new Set(
    (issue.externalRefs ?? [])
      .filter((ref) => ref.provider === PULL_REQUEST_REF_PROVIDER)
      .map((ref) => ref.externalId)
  )
  const linked: string[] = []
  for (const pull of pulls) {
    const externalId = pullRequestExternalId(pull.repoFullName, pull.number)
    if (known.has(externalId)) continue
    known.add(externalId)
    await resolved.link(
      issueId,
      { provider: PULL_REQUEST_REF_PROVIDER, externalId, url: pull.url, label: pull.label },
      by
    )
    linked.push(externalId)
  }
  return linked
}
