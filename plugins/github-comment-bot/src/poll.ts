/**
 * Polling: the same commands, found without a public webhook.
 *
 * Neither Host exposes its integration router to the internet, so a Desktop
 * without an ingress URL can only poll. Three cursors, each an `updated`
 * lower bound the next scan starts from: conversation comments and line
 * comments have repository-wide `since` listings, reviews do not, so the
 * most recently updated pull requests are asked for theirs. Overlap between
 * scans is harmless: a version already handled is skipped, and the Bot
 * plane deduplicates the same command from webhook and poll by event id.
 * Polling cannot see deletions; the answer re-reads its command first.
 */

import type { GithubReader } from "@cognia/github-bot-kit"

import {
  fromIssueComment,
  fromReview,
  fromReviewComment,
  type IssueCommentPayload,
  type ReviewCommentPayload,
  type ReviewPayload,
} from "./command-source"
import type { Candidate } from "./receive"

export interface PollCursor {
  version: 1
  issueCommentsSince: string
  reviewCommentsSince: string
  reviewsSince: string
  issueCommentsEtag?: string
  reviewCommentsEtag?: string
  repositoryId?: string
  lastScanAt?: number
  retryAt?: number
}

/** Pages per listing per scan; a busier repository continues from where the scan stopped. */
export const POLL_MAX_PAGES = 10
/** Recently updated pull requests whose reviews are read each scan. */
export const POLL_REVIEW_PULLS = 30
/** With working webhooks, polling is only the safety net for missed deliveries. */
export const WEBHOOK_SAFETY_NET_MS = 300_000

export function initialCursor(watermark: number): PollCursor {
  const since = new Date(watermark).toISOString()
  return { version: 1, issueCommentsSince: since, reviewCommentsSince: since, reviewsSince: since }
}

interface Listing<T> {
  items: T[]
  notModified: boolean
  /** More pages remained; the next scan resumes from the last item read. */
  truncated: boolean
  etag?: string
}

async function listSince<T>(
  reader: GithubReader,
  path: string,
  etag?: string
): Promise<Listing<T>> {
  const items: T[] = []
  let firstEtag: string | undefined
  for (let page = 1; page <= POLL_MAX_PAGES; page += 1) {
    const response = await reader.request<T[]>(
      `${path}&per_page=100&page=${page}`,
      page === 1 ? etag : undefined
    )
    if (page === 1) {
      if (response.status === 304) return { items, notModified: true, truncated: false, etag }
      firstEtag = response.headers.etag
    }
    if (!Array.isArray(response.data)) throw new Error(`Invalid GitHub collection: ${path}`)
    items.push(...response.data)
    if (!/rel="next"/.test(response.headers.link ?? ""))
      return { items, notModified: false, truncated: false, etag: firstEtag }
  }
  return { items, notModified: false, truncated: true, etag: firstEtag }
}

/**
 * An empty listing keeps its URL (and so its ETag, and the next scan is a free
 * 304); anything read moves the bound forward and drops the ETag of the old URL.
 */
function advance(
  kind: "issueComments" | "reviewComments",
  listing: Listing<{ updated_at?: unknown }>,
  cursor: PollCursor,
  settled: string
): Partial<PollCursor> {
  const since = `${kind}Since` as const
  const etag = `${kind}Etag` as const
  if (!listing.items.length) return { [etag]: listing.etag }
  return {
    [since]: listing.truncated
      ? latest(
          listing.items.map((item) =>
            typeof item.updated_at === "string" ? item.updated_at : undefined
          ),
          cursor[since]
        )
      : latest([settled], cursor[since]),
    [etag]: undefined,
  }
}

const latest = (values: Array<string | undefined>, fallback: string) =>
  values.reduce<string>((max, value) => (value && value > max ? value : max), fallback)

export async function pollCandidates(
  reader: GithubReader,
  repository: { id: string; fullName: string },
  cursor: PollCursor,
  scanAt: number
): Promise<{ candidates: Candidate[]; next: PollCursor }> {
  const candidates: Candidate[] = []
  const next: PollCursor = { ...cursor }
  // A scan that read everything moves to just before it began; one that was
  // cut resumes from the newest version it saw.
  const settled = new Date(scanAt - 1000).toISOString()
  const push = (raw: ReturnType<typeof fromIssueComment>) => {
    if (raw) candidates.push({ action: "upsert", raw, ingress: "poll", repository })
  }

  const issueComments = await listSince<IssueCommentPayload>(
    reader,
    `/issues/comments?sort=updated&direction=asc&since=${encodeURIComponent(cursor.issueCommentsSince)}`,
    cursor.issueCommentsEtag
  )
  for (const comment of issueComments.items) push(fromIssueComment(comment))
  if (!issueComments.notModified)
    Object.assign(next, advance("issueComments", issueComments, cursor, settled))

  const reviewComments = await listSince<ReviewCommentPayload>(
    reader,
    `/pulls/comments?sort=updated&direction=asc&since=${encodeURIComponent(cursor.reviewCommentsSince)}`,
    cursor.reviewCommentsEtag
  )
  for (const comment of reviewComments.items) push(fromReviewComment(comment))
  if (!reviewComments.notModified)
    Object.assign(next, advance("reviewComments", reviewComments, cursor, settled))

  // A submitted review updates its pull request, so the newest pulls carry it.
  const pulls = (
    await reader.request<Array<{ number?: number; updated_at?: string }>>(
      `/pulls?state=all&sort=updated&direction=desc&per_page=${POLL_REVIEW_PULLS}&page=1`
    )
  ).data
  if (!Array.isArray(pulls)) throw new Error("Invalid GitHub pull request collection")
  for (const pull of pulls) {
    if (
      typeof pull.number !== "number" ||
      !pull.updated_at ||
      pull.updated_at < cursor.reviewsSince
    )
      continue
    const reviews = await reader.pageWindow<ReviewPayload>(`/pulls/${pull.number}/reviews`, {
      maxPages: 3,
    })
    for (const review of reviews.items) {
      if (typeof review.submitted_at === "string" && review.submitted_at >= cursor.reviewsSince)
        push(fromReview(review, pull.number))
    }
  }
  next.reviewsSince = latest([settled], cursor.reviewsSince)
  next.lastScanAt = scanAt
  delete next.retryAt
  return { candidates, next }
}
