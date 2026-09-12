import { DEFAULT_CONFIG } from "../types"
import { beastReason, canAnswer, shouldForceAnswer } from "./budget"
import { initState, type ResearchState } from "./workspace"

function state(over: Partial<ResearchState> = {}): ResearchState {
  return {
    ...initState("q", { ...DEFAULT_CONFIG, maxSteps: 5, tokenBudget: 100, maxBadAttempts: 1 }),
    ...over,
  }
}

describe("shouldForceAnswer", () => {
  it("is false within all limits", () => {
    expect(shouldForceAnswer(state({ step: 1, tokensUsed: 10, badAttempts: 0 }))).toBe(false)
  })
  it("fires on token budget", () => {
    expect(shouldForceAnswer(state({ tokensUsed: 100 }))).toBe(true)
  })
  it("fires on step ceiling", () => {
    expect(shouldForceAnswer(state({ step: 5 }))).toBe(true)
  })
  it("fires AT max bad attempts — the count is rejections tolerated, not one past it", () => {
    // `badAttempts` counts rejected drafts; maxBadAttempts=1 means the loop
    // settles after one rejection, not two.
    expect(shouldForceAnswer(state({ badAttempts: 1 }))).toBe(true)
    expect(shouldForceAnswer(state({ badAttempts: 0 }))).toBe(false)
  })
})

describe("beastReason", () => {
  it("prioritises bad attempts, then tokens, then steps", () => {
    expect(beastReason(state({ badAttempts: 2 }))).toMatch(/failed answer/)
    expect(beastReason(state({ tokensUsed: 100 }))).toMatch(/token budget/)
    expect(beastReason(state({ step: 5 }))).toMatch(/step limit/)
    expect(beastReason(state())).toBe("forced")
  })
})

describe("canAnswer", () => {
  it("requires the flag AND some knowledge", () => {
    expect(canAnswer(state({ allowAnswer: true, knowledge: [] }))).toBe(false)
    expect(
      canAnswer(state({ allowAnswer: true, knowledge: [{ url: "u", title: "t", content: "c" }] }))
    ).toBe(true)
    expect(
      canAnswer(state({ allowAnswer: false, knowledge: [{ url: "u", title: "t", content: "c" }] }))
    ).toBe(false)
  })
})
