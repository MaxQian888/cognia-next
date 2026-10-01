/** Shared review publication policy for the delivery plugin and repository review UI.
 * Transport and credentials remain owned by their existing callers.
 */
export type GithubReviewRequest = <T>(
  path: string,
  method?: string,
  body?: unknown
) => Promise<{ data: T }>

export async function publishGithubReview(
  input: Record<string, unknown> & { repoFullName: string; prNumber: number },
  request: GithubReviewRequest,
  options: { allowDraftComment?: boolean } = {}
): Promise<unknown> {
  const number = input.prNumber
  const comments = input.comments as
    Array<{ path: string; line: number; side: string; body: string }> | undefined
  if (
    comments !== undefined &&
    (!Array.isArray(comments) ||
      comments.length > 50 ||
      comments.some(
        (comment) =>
          !comment ||
          typeof comment.path !== "string" ||
          !comment.path ||
          comment.path.startsWith("/") ||
          comment.path.includes("\\") ||
          comment.path.split("/").includes("..") ||
          !Number.isSafeInteger(comment.line) ||
          comment.line < 1 ||
          !["LEFT", "RIGHT"].includes(comment.side) ||
          typeof comment.body !== "string" ||
          !comment.body.trim()
      ))
  )
    throw new Error("Invalid inline review comments")
  if (
    !(comments?.length && input.body === undefined) &&
    (typeof input.body !== "string" || !input.body.trim())
  )
    throw new Error("github-delivery requires body")
  const body = typeof input.body === "string" ? input.body : ""
  const event = input.event ?? "COMMENT"
  if (!["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(event as string))
    throw new Error("Invalid review event")
  if (event === "APPROVE" && comments?.length)
    throw new Error("Approval cannot include unresolved findings")
  if ((event !== "COMMENT" || comments?.length) && typeof input.commitId !== "string")
    throw new Error("A verdict or inline review requires an exact commitId")
  if (typeof input.commitId === "string") {
    const path = `/repos/${input.repoFullName}/pulls/${number}`
    const current = await request<{
      head: { sha: string }
      state: string
      draft?: boolean
      body?: string
      user?: { id: number }
    }>(path)
    if (
      current.data.state !== "open" ||
      (current.data.draft && !(options.allowDraftComment && event === "COMMENT")) ||
      current.data.head.sha !== input.commitId
    )
      throw new Error("Approved review target SHA changed or PR closed")
    if (event === "APPROVE") {
      if (current.data.body?.includes("<!-- cognia-github-devin:"))
        throw new Error("Cannot approve a Bot-produced pull request")
      // Identity is resolved by the provider, never supplied by the calling Bot.
      // If the credential cannot identify its actor, approval fails closed.
      const viewer = await request<{ id?: number }>("/user")
      if (!viewer.data.id || !current.data.user?.id)
        throw new Error("Cannot verify review actor identity")
      if (viewer.data.id === current.data.user.id)
        throw new Error("Cannot approve your own pull request")
    }
    // Review markers are stable per run. Search every page before retrying a POST.
    for (let page = 1; ; page += 1) {
      const reviews = await request<
        Array<{ id?: number; body?: string; commit_id?: string; state?: string }>
      >(`${path}/reviews?per_page=100&page=${page}`)
      const match = reviews.data.find(
        (review) =>
          review.body === body &&
          review.commit_id === input.commitId &&
          review.state ===
            (
              {
                COMMENT: "COMMENTED",
                REQUEST_CHANGES: "CHANGES_REQUESTED",
                APPROVE: "APPROVED",
              } as Record<string, string>
            )[event as string]
      )
      if (match) {
        if (comments?.length) {
          if (!match.id) throw new Error("Cannot verify existing inline review")
          const existingComments: typeof comments = []
          for (let commentPage = 1; ; commentPage++) {
            const page = await request<typeof comments>(
              `${path}/reviews/${match.id}/comments?per_page=100&page=${commentPage}`
            )
            existingComments.push(...page.data)
            if (page.data.length < 100) break
          }
          const canonical = (items: typeof comments) =>
            JSON.stringify(
              items
                .map((comment) => ({
                  path: comment.path,
                  line: comment.line,
                  side: comment.side,
                  body: comment.body,
                }))
                .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
            )
          if (canonical(existingComments) !== canonical(comments))
            throw new Error("Existing inline review content differs from approved content")
        }
        return match
      }
      if (reviews.data.length < 100) break
    }
  }
  return (
    await request(`/repos/${input.repoFullName}/pulls/${number}/reviews`, "POST", {
      event,
      body,
      ...(comments?.length ? { comments } : {}),
      ...(typeof input.commitId === "string" ? { commit_id: input.commitId } : {}),
    })
  ).data
}
