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

  it("preserves order when the task gives no lexical signal", () => {
    expect(selectToolsForTask({ available: ["a", "b"], task: "anything" })).toEqual(["a", "b"])
  })

  it("ranks lexically relevant tools first when the task matches", () => {
    const result = selectToolsForTask({
      available: ["weather_lookup", "search_files", "video_convert"],
      task: "search the project files for a pattern",
      maxSelected: 2,
    })
    expect(result[0]).toBe("search_files")
    expect(result).toHaveLength(2)
  })

  it("ranks descriptor objects by name + description overlap", () => {
    const tools = [
      { name: "screenshot", description: "capture the screen" },
      { name: "grep", description: "search text in files" },
    ]
    const result = selectToolsForTask({
      available: tools,
      task: "search for text in my files",
      maxSelected: 1,
    })
    expect(result[0]).toBe(tools[1])
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

  it("scores a no-overlap candidate below neutral when a task is present", () => {
    const score = scoreTaskAwareToolCandidate("x", {
      query: "what",
      conversationContext: "earlier",
      activeMode: "review",
    })
    expect(score.score).toBeLessThan(0.5)
    expect(score.reason).toBe("no-overlap")
  })

  it("scores overlapping candidates above no-overlap ones", () => {
    const relevant = scoreTaskAwareToolCandidate(
      { name: "search_files", description: "search text in files" },
      "search my files for text"
    )
    const irrelevant = scoreTaskAwareToolCandidate(
      { name: "screenshot", description: "capture the screen" },
      "search my files for text"
    )
    expect(relevant.score).toBeGreaterThan(irrelevant.score)
    expect(relevant.reason).toBe("lexical-overlap")
  })

  it("accepts an optional task context as plain string", () => {
    const score = scoreTaskAwareToolCandidate({ id: "abc" }, "summarize")
    expect(score.toolId).toBe("abc")
  })
})
