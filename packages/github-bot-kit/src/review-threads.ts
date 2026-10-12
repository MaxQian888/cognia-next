/** One review comment as GitHub REST returns it (`/pulls/{n}/comments`). */
export interface ReviewCommentData {
  id?: number
  body?: string
  path?: string
  line?: number | null
  original_line?: number | null
  in_reply_to_id?: number | null
  user?: { login?: string; type?: string }
}

/** One normalized review comment inside a thread. */
export interface ReviewThreadComment {
  id: string
  author: string
  body: string
  isBot: boolean
}

/**
 * A normalized review thread. NOTE: GitHub's REST API does not expose
 * thread-resolution state (that is GraphQL-only), so `resolved` is best-effort
 * and defaults to false over REST. A reader that treats an unresolved,
 * non-bot comment as actionable therefore over-reports rather than drops
 * feedback — the safe direction.
 */
export interface ReviewThread {
  id: string
  path: string
  line: number
  resolved: boolean
  isBot: boolean
  comments: ReviewThreadComment[]
}

/** An App or machine account: GitHub's `type: "Bot"`, or the `[bot]` login suffix. */
export function isBotUser(user?: { login?: string; type?: string } | null): boolean {
  if (!user) return false
  if (user.type === "Bot") return true
  return typeof user.login === "string" && user.login.endsWith("[bot]")
}

/**
 * Group review comments into threads keyed by their root comment. GitHub REST
 * has no thread-resolution flag (GraphQL-only), so `resolved` stays false — the
 * reaction reducer treats unresolved non-bot comments as actionable, so this
 * over-reports rather than drops feedback.
 */
export function groupReviewThreads(comments: ReviewCommentData[]): ReviewThread[] {
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

  const threads = new Map<number, ReviewThread>()
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
    const thread = threads.get(rootId) as ReviewThread
    const bot = isBotUser(c.user)
    thread.comments.push({
      id: String(c.id),
      author: c.user?.login ?? "",
      body: c.body ?? "",
      isBot: bot,
    })
    if (!bot) thread.isBot = false
  }
  return order.map((id) => threads.get(id) as ReviewThread)
}
