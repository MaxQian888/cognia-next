import { sha256Hex } from "@/lib/share/hash"
import type { ReviewComment, ReviewCommentAnchor } from "@/types/review"

function normalizeReviewPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^([A-Z]):\//, (_match, drive: string) => {
    return `${drive.toLowerCase()}:/`
  })
}

/** SHA-256 identity of the immutable comment anchor and authored body. */
export async function reviewCommentContentHash(
  anchor: ReviewCommentAnchor,
  body: string
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      repositoryRoot: normalizeReviewPath(anchor.repositoryRoot),
      path: normalizeReviewPath(anchor.path),
      hunkHash: anchor.hunkHash,
      side: anchor.side,
      line: anchor.line,
      commitSha: anchor.commitSha ?? null,
      body,
    })
  )
}

export async function createReviewComment(input: {
  anchor: ReviewCommentAnchor
  body: string
  createdAt: number
}): Promise<ReviewComment> {
  const body = input.body.trim()
  if (!body) throw new Error("Review comment body cannot be empty")
  const contentHash = await reviewCommentContentHash(input.anchor, body)
  return {
    id: `review-comment:${contentHash}`,
    contentHash,
    anchor: {
      ...input.anchor,
      repositoryRoot: normalizeReviewPath(input.anchor.repositoryRoot),
      path: normalizeReviewPath(input.anchor.path),
    },
    body,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    status: "draft",
  }
}

/**
 * Remap a comment only when its content hunk matches one current hunk exactly.
 * Ambiguous or vanished content becomes stale instead of guessing a line.
 */
export function remapReviewComment(
  comment: ReviewComment,
  currentHunks: ReadonlyArray<{ hunkHash: string; startLine: number }>
): ReviewComment {
  const matches = currentHunks.filter((hunk) => hunk.hunkHash === comment.anchor.hunkHash)
  if (matches.length !== 1) {
    return { ...comment, status: "stale" }
  }
  return {
    ...comment,
    anchor: { ...comment.anchor, line: matches[0].startLine },
    status: comment.status === "stale" ? "draft" : comment.status,
  }
}
