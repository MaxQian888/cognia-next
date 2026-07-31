import {
  buildReviewerIntent,
  buildReviewerPrompt,
  createPrReviewer,
  REVIEWER_SYSTEM_PROMPT,
  reviewerVerdictSchema,
  type ReviewerVerdict,
} from "./reviewer"
import type { TeammatePrBinding } from "./binding"
import type { PrObservation } from "@/lib/github/pr-observe/types"

const ESC = String.fromCharCode(0x1b)

const binding: TeammatePrBinding = {
  runId: "run-1",
  teamId: "team-a",
  memberId: "m1",
  taskId: "t1",
  repo: "acme/app",
  branch: "agent/run-1/m1/t1",
}

function mkObs(over: Partial<PrObservation["pr"]> = {}): PrObservation {
  return {
    fetched: true,
    observedAt: 1,
    repo: "acme/app",
    pr: {
      url: "https://gh/acme/app/pull/5",
      number: 5,
      state: "open",
      draft: false,
      merged: false,
      closed: false,
      sourceBranch: "agent/run-1/m1/t1",
      targetBranch: "main",
      headSha: "deadbeef",
      title: "Add feature",
      additions: 1,
      deletions: 0,
      author: "dev",
      ...over,
    },
    ci: { summary: "passing", headSha: "deadbeef", failedChecks: [] },
    review: { decision: "none", threads: [] },
    mergeability: { state: "mergeable", mergeable: true, conflict: false, behindBase: false },
    changed: { metadata: true, ci: true, review: true },
  }
}

describe("REVIEWER_SYSTEM_PROMPT", () => {
  it("frames a review-only role", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toMatch(/review/i)
    expect(REVIEWER_SYSTEM_PROMPT).toMatch(/do not modify the branch/i)
  })
})

describe("buildReviewerPrompt", () => {
  it("includes PR identity, branches, sha, and the verdict instruction", () => {
    const p = buildReviewerPrompt(mkObs())
    expect(p).toContain("#5")
    expect(p).toContain("Add feature")
    expect(p).toContain("agent/run-1/m1/t1")
    expect(p).toContain("main")
    expect(p).toContain("deadbeef")
    expect(p).toContain("changes_requested")
  })

  it("sanitizes the PR title", () => {
    const p = buildReviewerPrompt(mkObs({ title: `bad${ESC}[31mtitle` }))
    expect(p).not.toContain(ESC)
    expect(p).toContain("badtitle")
  })
})

describe("reviewerVerdictSchema", () => {
  it("accepts a valid verdict", () => {
    expect(reviewerVerdictSchema.parse({ verdict: "approved", body: "lgtm" })).toEqual({
      verdict: "approved",
      body: "lgtm",
    })
  })
  it("rejects an unknown verdict", () => {
    expect(reviewerVerdictSchema.safeParse({ verdict: "meh", body: "x" }).success).toBe(false)
  })
})

describe("buildReviewerIntent", () => {
  it("returns null for an approved verdict", () => {
    expect(buildReviewerIntent(binding, mkObs(), { verdict: "approved", body: "lgtm" })).toBeNull()
  })

  it("builds a review intent for changes_requested with an AO-scoped key", () => {
    const intent = buildReviewerIntent(binding, mkObs(), {
      verdict: "changes_requested",
      body: "fix the null check",
    })
    expect(intent).not.toBeNull()
    expect(intent).toMatchObject({
      key: "review:https://gh/acme/app/pull/5:ao:run-1",
      category: "review",
      sig: "deadbeef#fix the null check",
    })
    expect(intent?.message).toContain("internal code reviewer requested changes")
    expect(intent?.message).toContain("fix the null check")
  })

  it("omits the review section when the body is empty", () => {
    const intent = buildReviewerIntent(binding, mkObs(), { verdict: "changes_requested", body: "" })
    expect(intent?.message).not.toContain("Review:")
    expect(intent?.sig).toBe("deadbeef#")
  })

  it("sanitizes the review body", () => {
    const intent = buildReviewerIntent(binding, mkObs(), {
      verdict: "changes_requested",
      body: `see ${ESC}[31mhere`,
    })
    expect(intent?.message).not.toContain(ESC)
    expect(intent?.message).toContain("see here")
  })
})

describe("createPrReviewer", () => {
  it("returns null when the review seam yields null", async () => {
    const reviewer = createPrReviewer(async () => null)
    expect(await reviewer(binding, mkObs())).toBeNull()
  })

  it("returns null for an approved verdict", async () => {
    const reviewer = createPrReviewer(
      async () => ({ verdict: "approved", body: "ok" }) as ReviewerVerdict
    )
    expect(await reviewer(binding, mkObs())).toBeNull()
  })

  it("maps a changes_requested verdict to an intent", async () => {
    const reviewer = createPrReviewer(
      async () => ({ verdict: "changes_requested", body: "nope" }) as ReviewerVerdict
    )
    const intent = await reviewer(binding, mkObs())
    expect(intent?.category).toBe("review")
    expect(intent?.message).toContain("nope")
  })
})
