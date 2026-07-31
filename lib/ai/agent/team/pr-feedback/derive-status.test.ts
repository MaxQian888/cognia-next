import { derivePrStatus } from "./derive-status"
import { unfetchedObservation } from "@/lib/github/pr-observe/types"
import type { PrObservation } from "@/lib/github/pr-observe/types"

/** A fully-open, green, no-review baseline observation to mutate per case. */
function baseline(): PrObservation {
  return {
    fetched: true,
    observedAt: 1,
    repo: "acme/app",
    pr: {
      url: "u",
      number: 5,
      state: "open",
      draft: false,
      merged: false,
      closed: false,
      sourceBranch: "b",
      targetBranch: "main",
      headSha: "s",
      title: "t",
      additions: 1,
      deletions: 0,
      author: "dev",
    },
    ci: { summary: "passing", headSha: "s", failedChecks: [] },
    review: { decision: "none", threads: [] },
    mergeability: { state: "mergeable", mergeable: true, conflict: false, behindBase: false },
    changed: { metadata: false, ci: false, review: false },
  }
}

describe("derivePrStatus", () => {
  it("returns none for a not-fetched observation", () => {
    expect(derivePrStatus(unfetchedObservation("acme/app", 1))).toBe("none")
  })

  it("returns none when there is no PR number", () => {
    const o = baseline()
    o.pr.number = 0
    expect(derivePrStatus(o)).toBe("none")
  })

  it("merged wins over everything", () => {
    const o = baseline()
    o.pr.merged = true
    o.ci.summary = "failing"
    expect(derivePrStatus(o)).toBe("merged")
  })

  it("closed (unmerged)", () => {
    const o = baseline()
    o.pr.closed = true
    expect(derivePrStatus(o)).toBe("closed")
  })

  it("draft", () => {
    const o = baseline()
    o.pr.draft = true
    expect(derivePrStatus(o)).toBe("draft")
  })

  it("ci_failed outranks review + conflict", () => {
    const o = baseline()
    o.ci.summary = "failing"
    o.review.decision = "changes_requested"
    o.mergeability = { state: "conflicting", mergeable: false, conflict: true, behindBase: false }
    expect(derivePrStatus(o)).toBe("ci_failed")
  })

  it("changes_requested via decision", () => {
    const o = baseline()
    o.review.decision = "changes_requested"
    expect(derivePrStatus(o)).toBe("changes_requested")
  })

  it("changes_requested via unresolved non-bot comment (no decision)", () => {
    const o = baseline()
    o.review.threads = [
      {
        id: "1",
        path: "x",
        line: 1,
        resolved: false,
        isBot: false,
        comments: [{ id: "1", author: "h", body: "fix", isBot: false }],
      },
    ]
    expect(derivePrStatus(o)).toBe("changes_requested")
  })

  it("merge_conflict outranks ci_pending", () => {
    const o = baseline()
    o.ci.summary = "pending"
    o.mergeability = { state: "conflicting", mergeable: false, conflict: true, behindBase: false }
    expect(derivePrStatus(o)).toBe("merge_conflict")
  })

  it("ci_pending", () => {
    const o = baseline()
    o.ci.summary = "pending"
    o.mergeability = { state: "unknown", mergeable: false, conflict: false, behindBase: false }
    expect(derivePrStatus(o)).toBe("ci_pending")
  })

  it("mergeable outranks approved", () => {
    const o = baseline()
    o.review.decision = "approved"
    expect(derivePrStatus(o)).toBe("mergeable")
  })

  it("approved when not yet mergeable", () => {
    const o = baseline()
    o.review.decision = "approved"
    o.mergeability = { state: "behind", mergeable: false, conflict: false, behindBase: true }
    expect(derivePrStatus(o)).toBe("approved")
  })

  it("review_pending when open, green, no review", () => {
    const o = baseline()
    o.mergeability = { state: "unknown", mergeable: false, conflict: false, behindBase: false }
    expect(derivePrStatus(o)).toBe("review_pending")
  })

  it("pr_open fallback (review_required decision, nothing else actionable)", () => {
    const o = baseline()
    o.review.decision = "review_required"
    o.mergeability = { state: "unknown", mergeable: false, conflict: false, behindBase: false }
    expect(derivePrStatus(o)).toBe("pr_open")
  })
})
