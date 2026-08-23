import { anchoredRoots, assertSingleRootBundle, sliceBundleByRoot } from "./bundle"
import type { ReviewComment, ReviewFeedbackBundle } from "@/types/review"

function comment(over: Partial<ReviewComment> & { root: string; path: string }): ReviewComment {
  const { root, path, ...rest } = over
  return {
    id: `c:${root}:${path}`,
    contentHash: `h:${root}:${path}`,
    anchor: {
      repositoryRoot: root,
      path,
      hunkHash: "hunk",
      side: "after",
      line: 1,
    },
    body: "Fix this",
    createdAt: 1,
    updatedAt: 1,
    status: "draft",
    ...rest,
  }
}

function bundle(comments: ReviewComment[], roots?: string[]): ReviewFeedbackBundle {
  return {
    id: "bundle-1",
    sessionId: "s1",
    scope: "branch",
    repositoryRoots: roots ?? [...new Set(comments.map((c) => c.anchor.repositoryRoot))],
    comments,
    summary: "Summary",
    state: "draft",
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("anchoredRoots", () => {
  /**
   * The selected-roots list records what the user had ticked when they opened
   * the review, not what they wrote about. Publishing from it opens an empty
   * review on a repository nobody commented on.
   */
  it("derives roots from the comments, not from the selection", () => {
    const b = bundle([comment({ root: "/a", path: "x.ts" })], ["/a", "/b", "/c"])
    expect(anchoredRoots(b)).toEqual(["/a"])
  })

  it("ignores stale comments", () => {
    const b = bundle([
      comment({ root: "/a", path: "x.ts" }),
      comment({ root: "/b", path: "y.ts", status: "stale" }),
    ])
    expect(anchoredRoots(b)).toEqual(["/a"])
  })

  it("normalizes so one repository is not counted as two", () => {
    const b = bundle([
      comment({ root: "C:\\repo", path: "x.ts" }),
      comment({ root: "c:/repo", path: "y.ts" }),
    ])
    expect(anchoredRoots(b)).toEqual(["c:/repo"])
  })
})

describe("sliceBundleByRoot", () => {
  it("gives each repository its own single-root bundle", () => {
    const slices = sliceBundleByRoot(
      bundle([
        comment({ root: "/a", path: "x.ts" }),
        comment({ root: "/b", path: "y.ts" }),
        comment({ root: "/a", path: "z.ts" }),
      ])
    )
    expect([...slices.keys()].sort()).toEqual(["/a", "/b"])
    expect(slices.get("/a")!.repositoryRoots).toEqual(["/a"])
    expect(slices.get("/a")!.comments).toHaveLength(2)
    expect(slices.get("/b")!.comments).toHaveLength(1)
  })

  it("keeps the shared summary and identity — it is still one review", () => {
    const slices = sliceBundleByRoot(
      bundle([comment({ root: "/a", path: "x.ts" }), comment({ root: "/b", path: "y.ts" })])
    )
    for (const slice of slices.values()) {
      expect(slice.summary).toBe("Summary")
      expect(slice.id).toBe("bundle-1")
    }
  })

  it("drops stale comments and the roots that only had stale ones", () => {
    const slices = sliceBundleByRoot(
      bundle([
        comment({ root: "/a", path: "x.ts" }),
        comment({ root: "/b", path: "y.ts", status: "stale" }),
      ])
    )
    expect([...slices.keys()]).toEqual(["/a"])
  })

  it("does not mutate the source bundle's comment array", () => {
    const source = bundle([
      comment({ root: "/a", path: "x.ts" }),
      comment({ root: "/a", path: "z.ts" }),
    ])
    sliceBundleByRoot(source)
    expect(source.comments).toHaveLength(2)
  })
})

describe("assertSingleRootBundle", () => {
  it("returns the live comments for a well-formed single-root bundle", () => {
    const b = bundle([
      comment({ root: "/a", path: "x.ts" }),
      comment({ root: "/a", path: "y.ts", status: "stale" }),
    ])
    expect(assertSingleRootBundle(b, "/a")).toHaveLength(1)
  })

  /** The exact shape that used to mis-post: two roots, first one wins. */
  it("refuses a multi-root bundle instead of picking the first root", () => {
    const b = bundle([comment({ root: "/a", path: "x.ts" }), comment({ root: "/b", path: "y.ts" })])
    expect(() => assertSingleRootBundle(b, "/a")).toThrow(/exactly one repository root/)
  })

  it("refuses when the declared root is not the publish target", () => {
    const b = bundle([comment({ root: "/a", path: "x.ts" })], ["/a"])
    expect(() => assertSingleRootBundle(b, "/b")).toThrow(/is for \/a, not \/b/)
  })

  /** A slice built by hand could still smuggle a foreign comment through. */
  it("refuses a single-root bundle carrying a comment anchored elsewhere", () => {
    const b = bundle(
      [comment({ root: "/a", path: "x.ts" }), comment({ root: "/b", path: "y.ts" })],
      ["/a"]
    )
    expect(() => assertSingleRootBundle(b, "/a")).toThrow(/anchored outside/)
  })

  it("does not count a stale foreign comment as a violation", () => {
    const b = bundle(
      [
        comment({ root: "/a", path: "x.ts" }),
        comment({ root: "/b", path: "y.ts", status: "stale" }),
      ],
      ["/a"]
    )
    expect(assertSingleRootBundle(b, "/a")).toHaveLength(1)
  })

  it("matches roots through normalization", () => {
    const b = bundle([comment({ root: "C:\\repo", path: "x.ts" })], ["C:\\repo"])
    expect(assertSingleRootBundle(b, "c:/repo")).toHaveLength(1)
  })
})
