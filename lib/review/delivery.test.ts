import {
  publishReviewFeedback,
  retryableLegs,
  uncertainLegs,
  type ReviewDeliveryTarget,
} from "./delivery"
import { PullRequestProviderError } from "./github-provider"
import type {
  PullRequestProvider,
  PullRequestRef,
  ReviewComment,
  ReviewFeedbackBundle,
} from "@/types/review"

function pr(repository: string, number: number): PullRequestRef {
  return {
    provider: "github",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    headRef: "feature",
    baseRef: "main",
    title: "Change",
    state: "open",
  }
}

function comment(root: string, path: string, status: ReviewComment["status"] = "draft") {
  return {
    id: `c:${root}:${path}`,
    contentHash: `h:${root}:${path}`,
    anchor: { repositoryRoot: root, path, hunkHash: "hunk", side: "after" as const, line: 1 },
    body: "Fix this",
    createdAt: 1,
    updatedAt: 1,
    status,
  }
}

function bundle(comments: ReviewComment[]): ReviewFeedbackBundle {
  return {
    id: "bundle-1",
    sessionId: "s1",
    scope: "branch",
    repositoryRoots: ["/a", "/b"],
    comments,
    summary: "Summary",
    state: "draft",
    createdAt: 1,
    updatedAt: 1,
  }
}

const TARGETS: ReviewDeliveryTarget[] = [
  { repositoryRoot: "/a", pullRequest: pr("owner/a", 1) },
  { repositoryRoot: "/b", pullRequest: pr("owner/b", 2) },
]

function makeProvider(publishFeedback: jest.Mock): PullRequestProvider {
  return {
    id: "test",
    getAuthenticationState: async () => "authenticated",
    findForBranch: async () => null,
    resolveCheckout: async (_root, request) => ({
      provider: "test",
      ...request,
      fetchRef: `refs/pull/${request.number}/head`,
      headSha: "0123456789abcdef0123456789abcdef01234567",
    }),
    push: async () => undefined,
    create: async () => pr("owner/a", 1),
    publishFeedback,
  }
}

const TWO_ROOTS = bundle([comment("/a", "x.ts"), comment("/b", "y.ts")])

describe("publishReviewFeedback", () => {
  /** ADR-0111 §6: one PR per repository, grouped into one delivery unit. */
  it("publishes one review per repository, each with only its own comments", async () => {
    const publish = jest.fn().mockResolvedValue(undefined)
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: TWO_ROOTS,
      targets: TARGETS,
      now: 100,
    })

    expect(publish).toHaveBeenCalledTimes(2)
    const [[prA, sliceA], [prB, sliceB]] = publish.mock.calls
    expect(prA.repository).toBe("owner/a")
    expect(sliceA.repositoryRoots).toEqual(["/a"])
    expect(sliceA.comments.map((c: ReviewComment) => c.anchor.path)).toEqual(["x.ts"])
    expect(prB.repository).toBe("owner/b")
    expect(sliceB.comments.map((c: ReviewComment) => c.anchor.path)).toEqual(["y.ts"])
    expect(delivery.legs.map((l) => l.status)).toEqual(["succeeded", "succeeded"])
  })

  it("never throws a leg failure — the record of what succeeded is the point", async () => {
    const publish = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new PullRequestProviderError("rate limited", "feedback", true, {
          status: 429,
        })
      )
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: TWO_ROOTS,
      targets: TARGETS,
    })
    expect(delivery.legs[0]).toMatchObject({ repositoryRoot: "/a", status: "succeeded" })
    expect(delivery.legs[1]).toMatchObject({
      repositoryRoot: "/b",
      status: "failed",
      error: { message: "rate limited", recoverable: true },
    })
  })

  it("keeps publishing the remaining roots after one fails", async () => {
    const publish = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined)
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: TWO_ROOTS,
      targets: TARGETS,
    })
    expect(publish).toHaveBeenCalledTimes(2)
    expect(delivery.legs.map((l) => l.status)).toEqual(["failed", "succeeded"])
  })

  /** The acceptance criterion: retry touches only the failed repository. */
  it("carries succeeded legs forward on retry and re-sends only the failures", async () => {
    const first = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
    const before = await publishReviewFeedback({
      provider: makeProvider(first),
      bundle: TWO_ROOTS,
      targets: TARGETS,
    })

    const second = jest.fn().mockResolvedValue(undefined)
    const after = await publishReviewFeedback({
      provider: makeProvider(second),
      bundle: TWO_ROOTS,
      targets: TARGETS,
      previous: before,
    })

    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][1].repositoryRoots).toEqual(["/b"])
    expect(after.legs.map((l) => l.status)).toEqual(["succeeded", "succeeded"])
    expect(after.startedAt).toBe(before.startedAt)
  })

  it("skips a root with no pull request instead of failing the delivery", async () => {
    const publish = jest.fn().mockResolvedValue(undefined)
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: TWO_ROOTS,
      targets: [TARGETS[0]],
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(delivery.legs[1]).toMatchObject({ repositoryRoot: "/b", status: "skipped" })
    // A skip is not retryable — there is nothing to retry until a PR exists.
    expect(retryableLegs(delivery)).toEqual([])
  })

  it("publishes nothing for a root the user selected but never commented on", async () => {
    const publish = jest.fn().mockResolvedValue(undefined)
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: bundle([comment("/a", "x.ts")]),
      targets: TARGETS,
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(delivery.legs.map((l) => l.repositoryRoot)).toEqual(["/a"])
  })

  it("ignores stale comments when counting a leg", async () => {
    const publish = jest.fn().mockResolvedValue(undefined)
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: bundle([comment("/a", "x.ts"), comment("/a", "z.ts", "stale")]),
      targets: TARGETS,
    })
    expect(delivery.legs[0].commentCount).toBe(1)
  })

  /**
   * A response that never arrived is not a definite failure. Replaying it may
   * post the same review twice, so the delivery has to say so.
   */
  it("flags a leg whose request never got a response as uncertain", async () => {
    const publish = jest
      .fn()
      .mockRejectedValue(new PullRequestProviderError("network offline", "feedback", true))
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: bundle([comment("/a", "x.ts")]),
      targets: TARGETS,
    })
    expect(delivery.legs[0].outcomeUncertain).toBe(true)
    expect(uncertainLegs(delivery)).toHaveLength(1)
  })

  it("does not flag a leg that failed with a real HTTP status", async () => {
    const publish = jest
      .fn()
      .mockRejectedValue(
        new PullRequestProviderError("unprocessable", "feedback", false, { status: 422 })
      )
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: bundle([comment("/a", "x.ts")]),
      targets: TARGETS,
    })
    expect(delivery.legs[0].outcomeUncertain).toBeUndefined()
    expect(uncertainLegs(delivery)).toEqual([])
  })

  it("matches targets through path normalization", async () => {
    const publish = jest.fn().mockResolvedValue(undefined)
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: bundle([comment("C:\\repo", "x.ts")]),
      targets: [{ repositoryRoot: "c:/repo", pullRequest: pr("owner/a", 1) }],
    })
    expect(delivery.legs[0].status).toBe("succeeded")
  })

  it("reports an empty delivery for a bundle with nothing live in it", async () => {
    const publish = jest.fn()
    const delivery = await publishReviewFeedback({
      provider: makeProvider(publish),
      bundle: bundle([comment("/a", "x.ts", "stale")]),
      targets: TARGETS,
    })
    expect(publish).not.toHaveBeenCalled()
    expect(delivery.legs).toEqual([])
  })
})
