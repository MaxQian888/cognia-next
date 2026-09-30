/**
 * PR observation fetcher — the read half of the Agent Team PR feedback loop.
 * A TypeScript port of agent-orchestrator's SCM observer read path: for one PR
 * it fetches metadata + mergeability, CI check-runs/statuses (+ failing job log
 * tails), the review decision, and review-thread comments, then normalizes them
 * into a {@link PrObservation} and computes a semantic diff (`changed`) vs the
 * previous snapshot.
 *
 * Every endpoint is ETag-guarded: the prior observation's `etags` are sent as
 * `if-none-match`, and a 304 reuses the prior bucket instead of re-parsing. A
 * 404 (PR/repo gone) resolves to an unfetched observation rather than throwing,
 * so a transient miss never aborts the run.
 *
 * Pure w.r.t. Octokit: it takes an injected {@link OctokitLike}, so it is
 * decoupled from `@octokit/core` and fully mockable. The real runtime supplies a
 * `getOctokitForRepo(...)` instance through the team-runtime seam.
 */

import type {
  CiSummary,
  ObserveRef,
  ObserveRepo,
  OctokitLike,
  PrCheckObservation,
  PrCiObservation,
  PrMergeabilityObservation,
  PrMetaObservation,
  PrObservation,
  PrObserveEtags,
  PrReviewObservation,
  PrReviewThreadObservation,
  PrState,
  ReviewDecision,
} from "./types"
import { parseRepoFullName, unfetchedObservation } from "./types"
import { discoverOpenPrForBranch } from "./discover"

/**
 * Page cap for the paged lists (check-runs, reviews, review comments): 30 × 100
 * items. Reviews arrive oldest→newest, so a single page silently dropped the
 * NEWEST reviews of a long-lived PR and the decision was derived from stale
 * ones. Past the cap the walk stops (and keeps no ETag, so the next poll walks
 * again); 3,000 entries on one pull request is past anything the nudge loop
 * reasons about.
 */
const MAX_LIST_PAGES = 30

/** Max failing-check job logs fetched per poll (bounds API spend; noted, not silent). */
const MAX_LOG_FETCHES = 5
/** Lines of a failed job log kept as the tail. */
const LOG_TAIL_LINES = 20

// ── low-level request helper ────────────────────────────────────────────────

interface RawResponse {
  status: number
  headers: Record<string, string | undefined>
  data: unknown
}

/**
 * Request wrapper tolerant of both throw-based and resolve-based 304/404 (octokit
 * versions differ). 304/404 become a resolved response with that status and no
 * body; every other error propagates.
 */
async function safeRequest(
  octokit: OctokitLike,
  route: string,
  params: Record<string, unknown>
): Promise<RawResponse> {
  try {
    const res = await octokit.request(route, params)
    return { status: res.status, headers: res.headers ?? {}, data: res.data }
  } catch (err) {
    const status = (err as { status?: number })?.status
    if (status === 304 || status === 404) return { status, headers: {}, data: undefined }
    throw err
  }
}

function ifNoneMatch(etag?: string): Record<string, unknown> {
  return etag ? { headers: { "if-none-match": etag } } : {}
}

/**
 * `rel="next"` in a Link header. Same test as `hasNextPage` in
 * `lib/github/issues.ts`, kept local because that module pulls the Dexie
 * mirror in and this fetcher must stay storage-free.
 */
function hasNextLink(link: string | undefined): boolean {
  return typeof link === "string" && /<[^>]+>;\s*rel="next"/.test(link)
}

interface PagedResponse<T> {
  status: number
  /**
   * The first page's headers — except `etag`, which is kept ONLY when the
   * list fit on one page. A conditional request revalidates page 1 alone, and
   * on an ascending list (reviews) new items land on the last page: page 1
   * answers 304 while the list has changed. Dropping the tag forces a full walk
   * next time instead of reusing a stale bucket.
   */
  headers: Record<string, string | undefined>
  items: T[]
  /** True when the page cap stopped the walk before GitHub ran out. */
  truncated: boolean
}

/**
 * Walk every page of a list endpoint. A 304/404 on page 1 is returned as-is
 * with no items, so callers keep their existing "unchanged" / "gone" handling.
 */
async function requestAllPages<T>(
  octokit: OctokitLike,
  route: string,
  params: Record<string, unknown>,
  pick: (data: unknown) => T[],
  etag?: string
): Promise<PagedResponse<T>> {
  const first = await safeRequest(octokit, route, {
    ...params,
    per_page: 100,
    page: 1,
    ...ifNoneMatch(etag),
  })
  if (first.status === 304 || first.status === 404) {
    return { status: first.status, headers: first.headers, items: [], truncated: false }
  }
  const items = [...pick(first.data)]
  let link = first.headers.link
  let page = 1
  while (hasNextLink(link) && page < MAX_LIST_PAGES) {
    page += 1
    const next = await safeRequest(octokit, route, { ...params, per_page: 100, page })
    if (next.status !== 200) break
    items.push(...pick(next.data))
    link = next.headers.link
  }
  const truncated = hasNextLink(link)
  const headers = { ...first.headers }
  if (page > 1 || truncated) delete headers.etag
  return { status: first.status, headers, items, truncated }
}

function arrayOf<T>(data: unknown): T[] {
  return (Array.isArray(data) ? data : []) as T[]
}

// ── shared helpers ──────────────────────────────────────────────────────────

function isBotUser(user?: { login?: string; type?: string } | null): boolean {
  if (!user) return false
  if (user.type === "Bot") return true
  return typeof user.login === "string" && user.login.endsWith("[bot]")
}

function lastLines(text: string, n: number): string {
  if (!text) return ""
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.slice(Math.max(0, lines.length - n)).join("\n")
}

/** Parse the Actions job id from a check-run details/html URL (`/job/<id>`). */
export function extractJobId(url?: string): number | null {
  if (!url) return null
  const m = /\/job\/(\d+)/.exec(url)
  return m ? Number(m[1]) : null
}

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "cancelled"])

// ── PR metadata + mergeability ──────────────────────────────────────────────

export function mapMergeability(
  mergeable: boolean | null | undefined,
  mergeableState: string | undefined
): PrMergeabilityObservation {
  // `mergeable_state` is authoritative when present — GitHub also reports
  // mergeable=false for `behind`/`blocked`, not only conflicts, so the specific
  // state must be checked before the boolean fallback.
  const state = (mergeableState ?? "").toLowerCase()
  if (state === "dirty") {
    return { state: "conflicting", mergeable: false, conflict: true, behindBase: false }
  }
  if (state === "behind") {
    return { state: "behind", mergeable: false, conflict: false, behindBase: true }
  }
  if (state === "blocked") {
    return { state: "blocked", mergeable: mergeable === true, conflict: false, behindBase: false }
  }
  if (state === "clean" || state === "unstable" || state === "has_hooks") {
    return { state: "mergeable", mergeable: true, conflict: false, behindBase: false }
  }
  // No authoritative state (empty / "unknown") → fall back to the boolean.
  if (mergeable === false) {
    return { state: "conflicting", mergeable: false, conflict: true, behindBase: false }
  }
  if (mergeable === true) {
    return { state: "mergeable", mergeable: true, conflict: false, behindBase: false }
  }
  return { state: "unknown", mergeable: false, conflict: false, behindBase: false }
}

interface PrDetailData {
  number?: number
  state?: string
  draft?: boolean
  merged?: boolean
  merged_at?: string | null
  mergeable?: boolean | null
  mergeable_state?: string
  title?: string
  additions?: number
  deletions?: number
  html_url?: string
  url?: string
  user?: { login?: string }
  head?: { sha?: string; ref?: string }
  base?: { ref?: string }
}

function derivePrState(d: PrDetailData): PrState {
  if (d.merged || d.merged_at) return "merged"
  if (d.state === "closed") return "closed"
  if (d.draft) return "draft"
  return "open"
}

function toPrMeta(d: PrDetailData, fallbackUrl: string): PrMetaObservation {
  return {
    url: d.html_url ?? d.url ?? fallbackUrl,
    number: typeof d.number === "number" ? d.number : 0,
    state: derivePrState(d),
    draft: d.draft === true,
    merged: d.merged === true || Boolean(d.merged_at),
    closed: d.state === "closed" && !(d.merged || d.merged_at),
    sourceBranch: d.head?.ref ?? "",
    targetBranch: d.base?.ref ?? "",
    headSha: d.head?.sha ?? "",
    title: d.title ?? "",
    additions: d.additions ?? 0,
    deletions: d.deletions ?? 0,
    author: d.user?.login ?? "",
  }
}

// ── CI ───────────────────────────────────────────────────────────────────────

interface CheckRunData {
  name?: string
  status?: string
  conclusion?: string | null
  html_url?: string
  details_url?: string
  id?: number
}
interface CombinedStatusData {
  state?: string
  statuses?: Array<{ context?: string; state?: string; target_url?: string }>
}

/** Roll up check-runs + legacy commit statuses into a summary + failing set. */
export function summarizeCi(
  headSha: string,
  checkRuns: CheckRunData[],
  combined: CombinedStatusData | null
): PrCiObservation {
  const failedChecks: PrCheckObservation[] = []
  let anyPending = false
  let anyCheck = false

  for (const c of checkRuns) {
    anyCheck = true
    const status = c.status ?? "completed"
    if (status !== "completed") anyPending = true
    const conclusion = (c.conclusion ?? "").toLowerCase()
    if (status === "completed" && FAILING_CONCLUSIONS.has(conclusion)) {
      failedChecks.push({
        name: c.name ?? "(check)",
        status,
        conclusion,
        url: c.html_url ?? c.details_url,
        commitHash: headSha,
        providerId: c.id != null ? String(c.id) : undefined,
      })
    }
  }

  if (combined) {
    for (const s of combined.statuses ?? []) {
      anyCheck = true
      const st = (s.state ?? "").toLowerCase()
      if (st === "pending") anyPending = true
      if (st === "failure" || st === "error") {
        failedChecks.push({
          name: s.context ?? "(status)",
          status: "completed",
          conclusion: st,
          url: s.target_url,
          commitHash: headSha,
        })
      }
    }
    if ((combined.state ?? "").toLowerCase() === "pending") anyPending = true
  }

  let summary: CiSummary
  if (failedChecks.length > 0) summary = "failing"
  else if (anyPending) summary = "pending"
  else if (anyCheck) summary = "passing"
  else summary = "unknown"

  return { summary, headSha, failedChecks }
}

async function fetchJobLogTail(
  octokit: OctokitLike,
  repo: ObserveRepo,
  jobId: number
): Promise<string> {
  try {
    const res = await safeRequest(octokit, "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
      owner: repo.owner,
      repo: repo.name,
      job_id: jobId,
    })
    const text = typeof res.data === "string" ? res.data : ""
    return lastLines(text, LOG_TAIL_LINES)
  } catch {
    // Log fetch is best-effort (mirrors AO "when fetched"); a failure leaves the
    // tail empty and the nudge still names the failing check.
    return ""
  }
}

/** Attach best-effort job-log tails to the (bounded) set of failing checks. */
async function attachLogTails(
  octokit: OctokitLike,
  repo: ObserveRepo,
  ci: PrCiObservation
): Promise<void> {
  let fetched = 0
  for (const check of ci.failedChecks) {
    if (fetched >= MAX_LOG_FETCHES) break
    const jobId = extractJobId(check.url)
    if (jobId == null) continue
    check.logTail = await fetchJobLogTail(octokit, repo, jobId)
    fetched += 1
  }
}

// ── reviews ────────────────────────────────────────────────────────────────

interface ReviewData {
  id?: number
  state?: string
  submitted_at?: string
  user?: { login?: string; type?: string }
}

/** Effective decision: latest APPROVED/CHANGES_REQUESTED per non-bot author. */
export function deriveReviewDecision(reviews: ReviewData[]): ReviewDecision {
  const latestByAuthor = new Map<string, string>()
  for (const r of reviews) {
    if (isBotUser(r.user)) continue
    const state = (r.state ?? "").toUpperCase()
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue
    const author = r.user?.login ?? ""
    latestByAuthor.set(author, state) // reviews arrive oldest→newest; last write wins
  }
  const states = [...latestByAuthor.values()]
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested"
  if (states.includes("APPROVED")) return "approved"
  return "none"
}

interface ReviewCommentData {
  id?: number
  body?: string
  path?: string
  line?: number | null
  original_line?: number | null
  in_reply_to_id?: number | null
  user?: { login?: string; type?: string }
}

/**
 * Group review comments into threads keyed by their root comment. GitHub REST
 * has no thread-resolution flag (GraphQL-only), so `resolved` stays false — the
 * reaction reducer treats unresolved non-bot comments as actionable, so this
 * over-reports rather than drops feedback.
 */
export function groupReviewThreads(comments: ReviewCommentData[]): PrReviewThreadObservation[] {
  const byId = new Map<number, ReviewCommentData>()
  for (const c of comments) if (c.id != null) byId.set(c.id, c)

  const rootOf = (c: ReviewCommentData): ReviewCommentData => {
    let cur = c
    const seen = new Set<number>()
    while (
      cur.in_reply_to_id != null &&
      byId.has(cur.in_reply_to_id) &&
      !seen.has(cur.in_reply_to_id)
    ) {
      seen.add(cur.in_reply_to_id)
      cur = byId.get(cur.in_reply_to_id) as ReviewCommentData
    }
    return cur
  }

  const threads = new Map<number, PrReviewThreadObservation>()
  const order: number[] = []
  for (const c of comments) {
    if (c.id == null) continue
    const root = rootOf(c)
    const rootId = root.id ?? c.id
    if (!threads.has(rootId)) {
      threads.set(rootId, {
        id: String(rootId),
        path: root.path ?? "",
        line: root.line ?? root.original_line ?? 0,
        resolved: false,
        isBot: true,
        comments: [],
      })
      order.push(rootId)
    }
    const thread = threads.get(rootId) as PrReviewThreadObservation
    const bot = isBotUser(c.user)
    thread.comments.push({
      id: String(c.id),
      author: c.user?.login ?? "",
      body: c.body ?? "",
      isBot: bot,
    })
    if (!bot) thread.isBot = false
  }
  return order.map((id) => threads.get(id) as PrReviewThreadObservation)
}

// ── semantic diff ────────────────────────────────────────────────────────────

function ciFingerprint(ci: PrCiObservation): string {
  const checks = ci.failedChecks
    .map((c) => `${c.name}:${c.conclusion ?? ""}:${c.commitHash}`)
    .sort()
    .join("|")
  return `${ci.summary}#${checks}`
}

function reviewFingerprint(review: PrReviewObservation): string {
  const ids = review.threads
    .filter((t) => !t.resolved && !t.isBot)
    .flatMap((t) => t.comments.filter((c) => !c.isBot).map((c) => c.id))
    .sort()
    .join(",")
  return `${review.decision}#${ids}`
}

function metaFingerprint(pr: PrMetaObservation, m: PrMergeabilityObservation): string {
  return `${pr.state}:${pr.headSha}:${m.state}`
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Fetch one PR observation. `ref` is either an explicit PR number or a branch to
 * discover. `prev` supplies ETags for conditional requests and the baseline for
 * the `changed` diff. Returns `{ fetched: false }` when there is no PR to observe.
 */
export async function fetchPrObservation(
  octokit: OctokitLike,
  repo: string | ObserveRepo,
  ref: ObserveRef,
  prev: PrObservation | undefined,
  now: number
): Promise<PrObservation> {
  const r = typeof repo === "string" ? parseRepoFullName(repo) : repo

  // 1. Resolve the PR number.
  let prNumber: number
  let prUrlHint = ""
  if ("number" in ref) {
    prNumber = ref.number
    prUrlHint = ref.url ?? ""
  } else {
    const found = await discoverOpenPrForBranch(octokit, r, ref.branch)
    if (!found) return unfetchedObservation(r.fullName, now)
    prNumber = found.number
    prUrlHint = found.url
  }

  // 2. PR detail (ETag-guarded).
  const detail = await safeRequest(octokit, "GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: r.owner,
    repo: r.name,
    pull_number: prNumber,
    ...ifNoneMatch(prev?.etags?.pr),
  })
  if (detail.status === 404) return unfetchedObservation(r.fullName, now)

  const etags: PrObserveEtags = { ...prev?.etags }
  let pr: PrMetaObservation
  let mergeability: PrMergeabilityObservation
  if (detail.status === 304 && prev?.fetched) {
    pr = prev.pr
    mergeability = prev.mergeability
  } else {
    const d = (detail.data ?? {}) as PrDetailData
    pr = toPrMeta(d, prUrlHint)
    mergeability = mapMergeability(d.mergeable, d.mergeable_state)
    if (detail.headers.etag) etags.pr = detail.headers.etag
  }

  // A merged/closed PR needs no CI/review work — the controller reacts to the
  // terminal state (completion), not to nudges.
  if (pr.merged || pr.closed) {
    const changed = {
      metadata:
        !prev || metaFingerprint(pr, mergeability) !== metaFingerprint(prev.pr, prev.mergeability),
      ci: false,
      review: false,
    }
    return {
      fetched: true,
      observedAt: now,
      repo: r.fullName,
      pr,
      ci: prev?.ci ?? { summary: "unknown", headSha: pr.headSha, failedChecks: [] },
      review: prev?.review ?? { decision: "none", threads: [] },
      mergeability,
      changed,
      etags,
    }
  }

  // 3. CI, reviews, comments in parallel (each ETag-guarded, every page).
  const [checksRes, statusRes, reviewsRes, commentsRes] = await Promise.all([
    requestAllPages<CheckRunData>(
      octokit,
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      { owner: r.owner, repo: r.name, ref: pr.headSha },
      (data) => arrayOf<CheckRunData>((data as { check_runs?: unknown } | null)?.check_runs),
      prev?.etags?.checks
    ),
    safeRequest(octokit, "GET /repos/{owner}/{repo}/commits/{ref}/status", {
      owner: r.owner,
      repo: r.name,
      ref: pr.headSha,
      per_page: 100,
    }),
    requestAllPages<ReviewData>(
      octokit,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      { owner: r.owner, repo: r.name, pull_number: prNumber },
      arrayOf<ReviewData>,
      prev?.etags?.reviews
    ),
    requestAllPages<ReviewCommentData>(
      octokit,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      { owner: r.owner, repo: r.name, pull_number: prNumber },
      arrayOf<ReviewCommentData>,
      prev?.etags?.comments
    ),
  ])

  // CI (with best-effort log tails on newly parsed failing checks).
  let ci: PrCiObservation
  if (checksRes.status === 304 && prev?.fetched) {
    ci = prev.ci
  } else {
    const combined = statusRes.status === 304 ? null : (statusRes.data as CombinedStatusData | null)
    ci = summarizeCi(pr.headSha, checksRes.items, combined)
    await attachLogTails(octokit, r, ci)
    if (checksRes.headers.etag) etags.checks = checksRes.headers.etag
    else delete etags.checks
  }

  // Reviews + comments → review bucket.
  let review: PrReviewObservation
  const reviewsUnchanged = reviewsRes.status === 304
  const commentsUnchanged = commentsRes.status === 304
  if (reviewsUnchanged && commentsUnchanged && prev?.fetched) {
    review = prev.review
  } else {
    const decision =
      reviewsUnchanged && prev?.fetched
        ? prev.review.decision
        : deriveReviewDecision(reviewsRes.items)
    const threads =
      commentsUnchanged && prev?.fetched
        ? prev.review.threads
        : groupReviewThreads(commentsRes.items)
    review = { decision, threads }
    if (!reviewsUnchanged) {
      if (reviewsRes.headers.etag) etags.reviews = reviewsRes.headers.etag
      else delete etags.reviews
    }
    if (!commentsUnchanged) {
      if (commentsRes.headers.etag) etags.comments = commentsRes.headers.etag
      else delete etags.comments
    }
  }

  // 4. Semantic diff vs prev.
  const changed = prev?.fetched
    ? {
        metadata: metaFingerprint(pr, mergeability) !== metaFingerprint(prev.pr, prev.mergeability),
        ci: ciFingerprint(ci) !== ciFingerprint(prev.ci),
        review: reviewFingerprint(review) !== reviewFingerprint(prev.review),
      }
    : { metadata: true, ci: true, review: true }

  return {
    fetched: true,
    observedAt: now,
    repo: r.fullName,
    pr,
    ci,
    review,
    mergeability,
    changed,
    etags,
  }
}
