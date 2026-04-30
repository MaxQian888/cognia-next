import { selectToolsForTask, scoreTaskAwareToolCandidate } from "./task-aware-selection"

describe("selectToolsForTask", () => {
  it("returns up to maxSelected items", () => {
    const result = selectToolsForTask({
      available: ["a", "b", "c", "d"],
      maxSelected: 2,
    })
    expect(result).toEqual(["a", "b"])
  })

  it("returns all items when maxSelected is omitted", () => {
    const result = selectToolsForTask({ available: ["a", "b"] })
    expect(result).toEqual(["a", "b"])
  })

  it("returns empty array when available is empty", () => {
    expect(selectToolsForTask({ available: [] })).toEqual([])
  })

  it("clamps negative maxSelected to 0", () => {
    expect(selectToolsForTask({ available: ["x"], maxSelected: -5 })).toEqual([])
  })

  it("ignores task hint (stub does not rank)", () => {
    expect(selectToolsForTask({ available: ["a", "b"], task: "anything" })).toEqual(["a", "b"])
  })
})

describe("scoreTaskAwareToolCandidate", () => {
  it("produces a flat 0.5 score for a string id", () => {
    const score = scoreTaskAwareToolCandidate("tool-id")
    expect(score).toEqual({ toolId: "tool-id", score: 0.5, relevanceScore: 0.5 })
  })

  it("uses descriptor.id when provided", () => {
    const score = scoreTaskAwareToolCandidate({ id: "by-id", name: "by-name" })
    expect(score.toolId).toBe("by-id")
  })

  it("falls back to descriptor.name when id is absent", () => {
    const score = scoreTaskAwareToolCandidate({ name: "name-only" })
    expect(score.toolId).toBe("name-only")
  })

  it("falls back to 'unknown' when neither id nor name is present", () => {
    const score = scoreTaskAwareToolCandidate({})
    expect(score.toolId).toBe("unknown")
  })

  it("accepts an optional task context bag without erroring", () => {
    const score = scoreTaskAwareToolCandidate("x", {
      query: "what",
      conversationContext: "earlier",
      activeMode: "review",
    })
    expect(score.score).toBe(0.5)
    expect(score.relevanceScore).toBe(0.5)
  })

  it("accepts an optional task context as plain string", () => {
    const score = scoreTaskAwareToolCandidate({ id: "abc" }, "summarize")
    expect(score.toolId).toBe("abc")
  })
})
