import { isContextCommentAnchorStale } from "./context-comment"

describe("isContextCommentAnchorStale", () => {
  it("keeps legacy anchors conservative", () => {
    expect(
      isContextCommentAnchorStale(
        { anchor: { kind: "text-range", start: 0, end: 1, revision: "old" } },
        "new"
      )
    ).toBe(true)
    expect(
      isContextCommentAnchorStale({ anchor: { kind: "resource", revision: "new" } }, "new")
    ).toBe(false)
    expect(isContextCommentAnchorStale({ anchor: { kind: "resource" } }, "new")).toBe(false)
  })
  it("leaves versioned project anchors and CRDT anchors to their resolvers", () => {
    expect(
      isContextCommentAnchorStale(
        { anchor: { kind: "text-range", start: 0, end: 1, revision: "old", anchorVersion: 1 } },
        "new"
      )
    ).toBe(false)
    expect(
      isContextCommentAnchorStale(
        {
          anchor: {
            kind: "text-range",
            start: 0,
            end: 1,
            revision: "old",
            crdt: { anchor: "a", head: "b" },
          },
        },
        "new"
      )
    ).toBe(false)
  })
})
