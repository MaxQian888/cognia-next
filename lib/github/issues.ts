/**
 * GitHub issue reads — the half of the API this repo never had.
 *
 * Before this module, `plugins/github-delivery` could comment, label and close
 * an issue but could not LIST one: there was no `listForRepo`, no search, no
 * cursor'd fetch, and no GraphQL client at all. This adds the read path the
 * issue mirror needs, and nothing else.
 *
 * Conventions are lifted from `lib/github/pr-observe/fetch.ts`, the only real
 * caching layer in the codebase:
 *   - `OctokitLike` keeps the fetch logic decoupled from `@octokit/core`, so
 *     tests inject a plain object.
 *   - `safeRequest` normalises both throw-based and resolve-based 304/404 into
 *     a resolved `{status}` with no body.
 *   - ETag conditional requests: a 304 means "reuse what you have", which is
 *     the whole reason `proxyFetch` had to stop throwing on null-body statuses.
 *
 * Pull requests are excluded: GitHub's issues endpoint returns PRs too (they
 * carry a `pull_request` key), and mixing them onto an issue board is noise —
 * the PR surface already exists in `lib/github/pr-observe/`.
 */

import type {
  GithubIssueMirrorRow,
  GithubIssueState,
  GithubIssueStateReason,
} from "@/lib/db/github-issue-mirror-types"
import { githubMirrorId } from "@/lib/db/github-issue-mirror"

/** Minimal surface we need from Octokit — see `pr-observe/types.ts`. */
export interface OctokitLike {
  request(
    route: string,
    params?: Record<string, unknown>
  ): Promise<{
    status: number
    headers: Record<string, string | undefined>
    data: unknown
  }>
}

/** GitHub caps `per_page` at 100; anything larger is silently clamped anyway. */
export const ISSUES_PER_PAGE = 100

/** Hard ceiling on pages walked in one sync, so a huge repo can't hang a run. */
export const MAX_ISSUE_PAGES = 10

export interface FetchRepoIssuesOptions {
  /** `owner/repo`. */
  repoFullName: string
  /** ISO-8601; only issues updated at or after this are returned. */
  since?: string
  /** ETag from the previous fetch, for conditional revalidation. */
  etag?: string
  /** Delivery container to stamp on the mirrored rows. */
  issueProjectId?: string
  /** Injected for tests; defaults to `Date.now()`. */
  now?: number
}

export interface FetchRepoIssuesResult {
  /** Empty when `notModified` is true. */
  rows: GithubIssueMirrorRow[]
  /** True when GitHub answered 304 — the cache is already current. */
  notModified: boolean
  /** ETag to persist for the next conditional fetch. */
  etag?: string
  /** True when the page cap stopped the walk before GitHub ran out. */
  truncated: boolean
  /** Rate-limit budget left, surfaced so callers can back off. */
  rateLimitRemaining?: number
}

/**
 * Normalise a request into a resolved result. Octokit throws for non-2xx by
 * default, and 304 is not an error here — it is the successful outcome of a
 * conditional request.
 */
async function safeRequest(
  octokit: OctokitLike,
  route: string,
  params: Record<string, unknown>
): Promise<{ status: number; headers: Record<string, string | undefined>; data: unknown }> {
  try {
    return await octokit.request(route, params)
  } catch (error) {
    const status =
      error !== null && typeof error === "object" && "status" in error
        ? Number((error as { status: unknown }).status)
        : NaN
    if (status === 304 || status === 404) {
      const headers =
        error !== null && typeof error === "object" && "response" in error
          ? ((error as { response?: { headers?: Record<string, string | undefined> } }).response
              ?.headers ?? {})
          : {}
      return { status, headers, data: [] }
    }
    throw error
  }
}

interface RawGithubIssue {
  number: number
  title: string
  body?: string | null
  state: string
  state_reason?: string | null
  html_url: string
  comments?: number
  created_at: string
  updated_at: string
  closed_at?: string | null
  user?: { login?: string } | null
  assignees?: Array<{ login?: string } | null> | null
  labels?: Array<{ name?: string; color?: string } | string | null> | null
  /** Present iff this "issue" is actually a pull request. */
  pull_request?: unknown
}

function toEpoch(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

function normalizeState(state: string): GithubIssueState {
  return state === "closed" ? "closed" : "open"
}

function normalizeStateReason(
  value: string | null | undefined
): GithubIssueStateReason | undefined {
  if (value === "completed" || value === "not_planned" || value === "reopened") return value
  return undefined
}

/** Project one API issue into a mirror row. Exported for direct unit testing. */
export function toMirrorRow(
  raw: RawGithubIssue,
  context: { repoFullName: string; issueProjectId?: string; etag?: string; syncedAt: number }
): GithubIssueMirrorRow {
  const labels = (raw.labels ?? [])
    .map((label) => {
      if (typeof label === "string") return { name: label }
      if (label && typeof label.name === "string") {
        return label.color ? { name: label.name, color: label.color } : { name: label.name }
      }
      return null
    })
    .filter((label): label is { name: string; color?: string } => label !== null)

  return {
    id: githubMirrorId(context.repoFullName, raw.number),
    repoFullName: context.repoFullName,
    number: raw.number,
    ...(context.issueProjectId ? { issueProjectId: context.issueProjectId } : {}),
    title: raw.title,
    ...(raw.body ? { body: raw.body } : {}),
    state: normalizeState(raw.state),
    ...(normalizeStateReason(raw.state_reason)
      ? { stateReason: normalizeStateReason(raw.state_reason) }
      : {}),
    ...(raw.user?.login ? { authorLogin: raw.user.login } : {}),
    assigneeLogins: (raw.assignees ?? [])
      .map((assignee) => assignee?.login)
      .filter((login): login is string => Boolean(login)),
    labels,
    htmlUrl: raw.html_url,
    commentCount: raw.comments ?? 0,
    createdAt: toEpoch(raw.created_at) ?? context.syncedAt,
    updatedAt: toEpoch(raw.updated_at) ?? context.syncedAt,
    ...(toEpoch(raw.closed_at) !== undefined ? { closedAt: toEpoch(raw.closed_at) } : {}),
    syncedAt: context.syncedAt,
    ...(context.etag ? { etag: context.etag } : {}),
  }
}

/** Does the Link header advertise another page? */
export function hasNextPage(link: string | undefined): boolean {
  return typeof link === "string" && /<[^>]+>;\s*rel="next"/.test(link)
}

/**
 * Fetch a repo's issues, walking pages until GitHub runs out or the cap hits.
 *
 * The ETag is only meaningful for the FIRST page — that is what a conditional
 * request revalidates. A 304 there means nothing changed since `since`, so the
 * walk short-circuits and the caller keeps its cache untouched.
 */
export async function fetchRepoIssues(
  octokit: OctokitLike,
  options: FetchRepoIssuesOptions
): Promise<FetchRepoIssuesResult> {
  const [owner, repo] = options.repoFullName.split("/")
  if (!owner || !repo) {
    throw new Error(`Invalid repository: ${options.repoFullName}`)
  }

  const syncedAt = options.now ?? Date.now()
  const rows: GithubIssueMirrorRow[] = []
  let pageEtag: string | undefined
  let rateLimitRemaining: number | undefined
  let truncated = false

  for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
    const conditional = page === 1 && options.etag ? { "if-none-match": options.etag } : {}
    const response = await safeRequest(octokit, "GET /repos/{owner}/{repo}/issues", {
      owner,
      repo,
      state: "all",
      per_page: ISSUES_PER_PAGE,
      page,
      ...(options.since ? { since: options.since } : {}),
      headers: { ...conditional },
    })

    const remaining = response.headers["x-ratelimit-remaining"]
    if (remaining !== undefined) rateLimitRemaining = Number(remaining)

    if (page === 1) {
      if (response.status === 304) {
        return {
          rows: [],
          notModified: true,
          ...(options.etag ? { etag: options.etag } : {}),
          truncated: false,
          ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
        }
      }
      pageEtag = response.headers.etag
    }

    const batch = Array.isArray(response.data) ? (response.data as RawGithubIssue[]) : []
    for (const raw of batch) {
      // GitHub's issues endpoint returns pull requests too; they belong to the
      // PR surface, not the issue board.
      if (raw.pull_request) continue
      rows.push(
        toMirrorRow(raw, {
          repoFullName: options.repoFullName,
          ...(options.issueProjectId ? { issueProjectId: options.issueProjectId } : {}),
          ...(pageEtag ? { etag: pageEtag } : {}),
          syncedAt,
        })
      )
    }

    if (!hasNextPage(response.headers.link)) {
      return {
        rows,
        notModified: false,
        ...(pageEtag ? { etag: pageEtag } : {}),
        truncated: false,
        ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
      }
    }
    truncated = page === MAX_ISSUE_PAGES
  }

  return {
    rows,
    notModified: false,
    ...(pageEtag ? { etag: pageEtag } : {}),
    truncated,
    ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
  }
}
