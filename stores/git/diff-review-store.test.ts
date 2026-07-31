/**
 * @jest-environment jsdom
 */
import { act } from "@testing-library/react"

import {
  DIFF_REVIEW_FILE_CAP,
  migrateDiffReviewState,
  useDiffReviewStore,
} from "./diff-review-store"

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

  it("attaches an AI finding without clobbering an existing decision/comment", () => {
    act(() => {
      useDiffReviewStore.getState().setDecision("/r", "a.ts", 0, "h0", "accepted")
      useDiffReviewStore
        .getState()
        .setAiFinding("/r", "a.ts", 0, "h0", { severity: "warning", note: "leak" })
    })
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")).toEqual([
      { hunkIndex: 0, hash: "h0", decision: "accepted", ai: { severity: "warning", note: "leak" } },
    ])
  })

  it("removes an AI finding when passed null", () => {
    act(() => {
      useDiffReviewStore
        .getState()
        .setAiFinding("/r", "a.ts", 0, "h0", { severity: "info", note: "x" })
      useDiffReviewStore.getState().setAiFinding("/r", "a.ts", 0, "h0", null)
    })
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")[0].ai).toBeUndefined()
  })

  it("clearAiFindings strips ai but keeps human decisions, dropping empty entries", () => {
    act(() => {
      // Hunk 0: has a human decision + AI finding → keeps decision, loses AI.
      useDiffReviewStore.getState().setDecision("/r", "a.ts", 0, "h0", "accepted")
      useDiffReviewStore
        .getState()
        .setAiFinding("/r", "a.ts", 0, "h0", { severity: "info", note: "keep-decision" })
      // Hunk 1: AI-only → dropped entirely.
      useDiffReviewStore
        .getState()
        .setAiFinding("/r", "a.ts", 1, "h1", { severity: "critical", note: "ai-only" })
      useDiffReviewStore.getState().clearAiFindings("/r", "a.ts")
    })
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")).toEqual([
      { hunkIndex: 0, hash: "h0", decision: "accepted" },
    ])
  })

  it("clearAiFindings is a no-op for an unknown file", () => {
    act(() => useDiffReviewStore.getState().clearAiFindings("/r", "missing.ts"))
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "missing.ts")).toEqual([])
  })

  it("migrate is the identity — v1 state survives the v2 bump unchanged", () => {
    const v1 = {
      decisions: { "/r\na.ts": [{ hunkIndex: 0, hash: "h0", decision: "accepted" }] },
      order: ["/r\na.ts"],
    }
    expect(migrateDiffReviewState(v1, 1)).toBe(v1)
  })

  it("rehydrates a persisted v1 payload instead of discarding it", async () => {
    localStorage.setItem(
      "cognia-git-review",
      JSON.stringify({
        state: {
          decisions: { "/r\na.ts": [{ hunkIndex: 0, hash: "h0", decision: "rejected" }] },
          order: ["/r\na.ts"],
        },
        version: 1,
      })
    )
    await act(() => useDiffReviewStore.persist.rehydrate())
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")).toEqual([
      { hunkIndex: 0, hash: "h0", decision: "rejected" },
    ])
    localStorage.removeItem("cognia-git-review")
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
