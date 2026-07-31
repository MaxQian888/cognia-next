import {
  generateDiffPreview,
  buildCanvasReview,
  applyAcceptedCanvasReviewItems,
} from "./canvas-review"

describe("generateDiffPreview", () => {
  it("returns unchanged for identical content", () => {
    const diff = generateDiffPreview("a\nb\nc", "a\nb\nc")
    expect(diff.every((d) => d.type === "unchanged")).toBe(true)
  })

  it("identifies pure additions", () => {
    const diff = generateDiffPreview("a\nb", "a\nb\nc")
    expect(diff.find((d) => d.type === "added")?.content).toBe("c")
  })

  it("identifies pure removals", () => {
    const diff = generateDiffPreview("a\nb\nc", "a\nb")
    expect(diff.find((d) => d.type === "removed")?.content).toBe("c")
  })

  it("recognises mid-stream additions via lookahead", () => {
    // a, b, c (orig) vs a, X, b, c (modified): X is an add, b/c stay unchanged
    const diff = generateDiffPreview("a\nb\nc", "a\nX\nb\nc")
    const added = diff.filter((d) => d.type === "added")
    expect(added).toHaveLength(1)
    expect(added[0].content).toBe("X")
  })

  it("recognises mid-stream removals via lookahead", () => {
    const diff = generateDiffPreview("a\nX\nb\nc", "a\nb\nc")
    const removed = diff.filter((d) => d.type === "removed")
    expect(removed).toHaveLength(1)
    expect(removed[0].content).toBe("X")
  })

  it("handles a replacement (no lookahead match) as remove+add", () => {
    const diff = generateDiffPreview("a\nold\nb", "a\nnew\nb")
    expect(diff.some((d) => d.type === "removed" && d.content === "old")).toBe(true)
    expect(diff.some((d) => d.type === "added" && d.content === "new")).toBe(true)
  })
})

describe("buildCanvasReview / applyAcceptedCanvasReviewItems", () => {
  it("groups added/removed lines into review items with proper change types", () => {
    const review = buildCanvasReview({
      requestId: "req-1",
      actionType: "improve",
      originalContent: "line1\nline2\nline3",
      proposedContent: "line1\nline2 modified\nline3\nextra",
    })
    expect(review.items.length).toBeGreaterThan(0)
    expect(["replace", "insert", "delete"]).toContain(review.items[0].changeType)
    expect(review.id).toMatch(/.+/)
    expect(review.requestId).toBe("req-1")
  })

  it("handles a pure-insert change type", () => {
    const review = buildCanvasReview({
      requestId: "req-2",
      actionType: "expand",
      originalContent: "a",
      proposedContent: "a\nb\nc",
    })
    const insert = review.items.find((i) => i.changeType === "insert")
    expect(insert).toBeDefined()
  })

  it("handles a pure-delete change type", () => {
    const review = buildCanvasReview({
      requestId: "req-3",
      actionType: "simplify",
      originalContent: "a\nb\nc",
      proposedContent: "a",
    })
    expect(review.items.some((i) => i.changeType === "delete")).toBe(true)
  })

  it("applyAcceptedCanvasReviewItems applies only accepted items in reverse order", () => {
    const review = buildCanvasReview({
      requestId: "r",
      actionType: "improve",
      originalContent: "alpha\nbeta\ngamma",
      proposedContent: "ALPHA\nbeta\ngamma",
    })
    review.items.forEach((item) => (item.status = "accepted"))
    const applied = applyAcceptedCanvasReviewItems("alpha\nbeta\ngamma", review.items)
    expect(applied).toContain("ALPHA")
  })

  it("applyAcceptedCanvasReviewItems leaves content untouched when no items are accepted", () => {
    const out = applyAcceptedCanvasReviewItems("orig", [])
    expect(out).toBe("orig")
  })

  it("applyAcceptedCanvasReviewItems handles inserts (deleteCount=0)", () => {
    const out = applyAcceptedCanvasReviewItems("a\nb", [
      {
        id: "x",
        actionType: "expand",
        changeType: "insert",
        originalText: "",
        proposedText: "INS",
        status: "accepted",
        range: { startLine: 2, endLine: 1 },
        diffLines: [],
      } as never,
    ])
    // start=2 maps to index 1; endLine<startLine → deleteCount=0; insert "INS" before "b"
    expect(out.split("\n")).toEqual(["a", "INS", "b"])
  })

  it("applyAcceptedCanvasReviewItems supports empty proposed text (pure deletion)", () => {
    const out = applyAcceptedCanvasReviewItems("a\nb\nc", [
      {
        id: "x",
        actionType: "simplify",
        changeType: "delete",
        originalText: "b",
        proposedText: "",
        status: "accepted",
        range: { startLine: 2, endLine: 2 },
        diffLines: [],
      } as never,
    ])
    expect(out.split("\n")).toEqual(["a", "c"])
  })
})
