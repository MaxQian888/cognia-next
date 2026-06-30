/**
 * @jest-environment jsdom
 */
import { act } from "@testing-library/react"

import { DIFF_REVIEW_FILE_CAP, useDiffReviewStore } from "./diff-review-store"

function reset() {
  useDiffReviewStore.setState({ decisions: {}, order: [] })
}

describe("useDiffReviewStore", () => {
  beforeEach(reset)

  it("records and reads a decision per (rootDir, reviewKey)", () => {
    act(() => useDiffReviewStore.getState().setDecision("/r", "a.ts", 0, "h0", "accepted"))
    const list = useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")
    expect(list).toEqual([{ hunkIndex: 0, hash: "h0", decision: "accepted" }])
  })

  it("upserts by hash (decision then comment on the same hunk)", () => {
    act(() => {
      useDiffReviewStore.getState().setDecision("/r", "a.ts", 0, "h0", "rejected")
      useDiffReviewStore.getState().setComment("/r", "a.ts", 0, "h0", "why?")
    })
    const list = useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")
    expect(list).toEqual([{ hunkIndex: 0, hash: "h0", decision: "rejected", comment: "why?" }])
  })

  it("isolates decisions across rootDirs", () => {
    act(() => {
      useDiffReviewStore.getState().setDecision("/r1", "a.ts", 0, "h", "accepted")
      useDiffReviewStore.getState().setDecision("/r2", "a.ts", 0, "h", "rejected")
    })
    expect(useDiffReviewStore.getState().getFileDecisions("/r1", "a.ts")[0].decision).toBe(
      "accepted"
    )
    expect(useDiffReviewStore.getState().getFileDecisions("/r2", "a.ts")[0].decision).toBe(
      "rejected"
    )
  })

  it("clears a file's decisions", () => {
    act(() => {
      useDiffReviewStore.getState().setDecision("/r", "a.ts", 0, "h", "accepted")
      useDiffReviewStore.getState().clearFile("/r", "a.ts")
    })
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")).toEqual([])
  })

  it("evicts the least-recently-touched file past the cap", () => {
    act(() => {
      for (let i = 0; i < DIFF_REVIEW_FILE_CAP + 5; i++) {
        useDiffReviewStore.getState().setDecision("/r", `f${i}.ts`, 0, "h", "accepted")
      }
    })
    const { order } = useDiffReviewStore.getState()
    expect(order.length).toBe(DIFF_REVIEW_FILE_CAP)
    // The first five files were evicted.
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "f0.ts")).toEqual([])
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "f4.ts")).toEqual([])
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "f5.ts").length).toBe(1)
  })
})
