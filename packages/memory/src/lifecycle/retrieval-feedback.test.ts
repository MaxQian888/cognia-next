import type { Memory } from "../types/memory"
import {
  RETRIEVAL_FEEDBACK_VERDICTS,
  applyRetrievalFeedback,
  isRetrievalFeedbackVerdict,
} from "./retrieval-feedback"

function row(feedback?: Memory["retrievalFeedback"]): Pick<Memory, "retrievalFeedback"> {
  return feedback ? { retrievalFeedback: feedback } : {}
}

it("starts both counters from zero on a memory that never got a vote", () => {
  expect(applyRetrievalFeedback(row(), "helpful", 100).retrievalFeedback).toEqual({
    positive: 1,
    negative: 0,
    lastFeedbackAt: 100,
  })
})

it("counts helpful up and leaves negative alone", () => {
  const patch = applyRetrievalFeedback(row({ positive: 2, negative: 1 }), "helpful", 7)
  expect(patch.retrievalFeedback).toEqual({ positive: 3, negative: 1, lastFeedbackAt: 7 })
})

it.each(["wrong", "outdated"] as const)("counts %s as negative", (verdict) => {
  const patch = applyRetrievalFeedback(row({ positive: 2, negative: 1 }), verdict, 7)
  expect(patch.retrievalFeedback.positive).toBe(2)
  expect(patch.retrievalFeedback.negative).toBe(2)
})

it("marks an outdated memory stale, because that is a fact about the memory", () => {
  expect(applyRetrievalFeedback(row(), "outdated", 1).staleness).toBe("stale")
})

it("leaves staleness untouched for the other two verdicts", () => {
  // Absent, not `undefined`: writing `staleness: undefined` into a Dexie patch
  // would clear a value the re-check sweep had set.
  for (const verdict of ["helpful", "wrong"] as const) {
    const patch = applyRetrievalFeedback(row(), verdict, 1)
    expect("staleness" in patch).toBe(false)
  }
})

it("never produces a review status — a mis-click must not remove a memory from recall", () => {
  for (const verdict of RETRIEVAL_FEEDBACK_VERDICTS) {
    const patch = applyRetrievalFeedback(row(), verdict, 1) as Record<string, unknown>
    expect(patch.reviewStatus).toBeUndefined()
    expect(patch.status).toBeUndefined()
  }
})

it("clamps a corrupted negative count instead of letting the ratio exceed 1", () => {
  const patch = applyRetrievalFeedback(row({ positive: -5, negative: -3 }), "helpful", 1)
  expect(patch.retrievalFeedback).toEqual({ positive: 1, negative: 0, lastFeedbackAt: 1 })
})

it("recognises exactly the three verdicts", () => {
  for (const verdict of RETRIEVAL_FEEDBACK_VERDICTS) {
    expect(isRetrievalFeedbackVerdict(verdict)).toBe(true)
  }
  for (const other of ["conflict", "invalid", "", null, undefined, 1]) {
    expect(isRetrievalFeedbackVerdict(other)).toBe(false)
  }
})
