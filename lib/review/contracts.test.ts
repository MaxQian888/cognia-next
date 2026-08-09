import { createReviewComment, remapReviewComment, reviewCommentContentHash } from "./contracts"

const anchor = {
  repositoryRoot: "C:\\repo",
  path: "src\\index.ts",
  hunkHash: "hunk-1",
  side: "after" as const,
  line: 12,
}

describe("unified review contracts", () => {
  it("creates deterministic content-addressed comments with normalized paths", async () => {
    const first = await createReviewComment({ anchor, body: "  Keep this guard.  ", createdAt: 1 })
    const second = await createReviewComment({ anchor, body: "Keep this guard.", createdAt: 2 })

    expect(first.id).toBe(second.id)
    expect(first.id).toMatch(/^review-comment:[0-9a-f]{64}$/)
    expect(first.anchor).toEqual(
      expect.objectContaining({ repositoryRoot: "c:/repo", path: "src/index.ts" })
    )
    expect(first.body).toBe("Keep this guard.")
  })

  it("changes identity when anchor content or feedback changes", async () => {
    const original = await reviewCommentContentHash(anchor, "Comment")
    await expect(
      reviewCommentContentHash({ ...anchor, hunkHash: "hunk-2" }, "Comment")
    ).resolves.not.toBe(original)
    await expect(reviewCommentContentHash(anchor, "Other comment")).resolves.not.toBe(original)
  })

  it("remaps uniquely matching hunks and marks ambiguous or missing anchors stale", async () => {
    const comment = await createReviewComment({ anchor, body: "Comment", createdAt: 1 })
    expect(remapReviewComment(comment, [{ hunkHash: "hunk-1", startLine: 30 }]).anchor.line).toBe(
      30
    )
    expect(
      remapReviewComment(comment, [
        { hunkHash: "hunk-1", startLine: 30 },
        { hunkHash: "hunk-1", startLine: 80 },
      ]).status
    ).toBe("stale")
    expect(remapReviewComment(comment, []).status).toBe("stale")
  })

  it("rejects empty feedback", async () => {
    await expect(createReviewComment({ anchor, body: "  ", createdAt: 1 })).rejects.toThrow(/empty/)
  })
})
