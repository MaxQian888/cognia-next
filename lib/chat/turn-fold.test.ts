import { foldTurnParts, formatWorkedDuration } from "./turn-fold"

const text = (value: string) => ({ type: "text", text: value })
const tool = (state = "output-available") => ({ type: "tool-Read", state })

describe("foldTurnParts", () => {
  it("returns null for a plain answer with no process", () => {
    expect(foldTurnParts([text("hello")])).toBeNull()
  })

  it("folds reasoning, tools and narration, keeping the final prose", () => {
    const fold = foldTurnParts([
      { type: "step-start" },
      { type: "reasoning", text: "thinking" },
      text("Let me look."),
      tool(),
      tool("output-error"),
      { type: "step-start" },
      text("All done."),
      text("Second paragraph."),
    ])
    expect(fold).not.toBeNull()
    expect([...fold!.folded].sort()).toEqual([1, 2, 3, 4])
    expect(fold).toMatchObject({ toolCount: 2, failedCount: 1, reasoningCount: 1 })
  })

  it("keeps deliverables visible even when they sit mid-process", () => {
    const fold = foldTurnParts([
      tool(),
      { type: "artifact" },
      { type: "file", mediaType: "image/png" },
      tool(),
      text("Here it is."),
    ])
    expect([...fold!.folded].sort()).toEqual([0, 3])
  })

  it("treats an empty text part as transparent when finding the conclusion", () => {
    const fold = foldTurnParts([tool(), text("Result"), text("  ")])
    expect([...fold!.folded]).toEqual([0])
  })

  it("folds trailing tools that ran after the last prose", () => {
    const fold = foldTurnParts([text("Plan"), tool(), text("Done"), tool()])
    expect([...fold!.folded].sort()).toEqual([0, 1, 3])
  })

  it("folds everything when the turn has no prose at all", () => {
    const fold = foldTurnParts([tool(), tool()])
    expect([...fold!.folded].sort()).toEqual([0, 1])
  })

  it.each(["input-streaming", "input-available", "approval-requested"])(
    "refuses to fold while a tool is %s",
    (state) => {
      expect(foldTurnParts([tool(state), text("x")])).toBeNull()
    }
  )

  it("folds dynamic tools and process-only data parts", () => {
    const fold = foldTurnParts([
      { type: "dynamic-tool", state: "output-available" },
      { type: "data-tool-summary" },
      text("ok"),
    ])
    expect([...fold!.folded].sort()).toEqual([0, 1])
    expect(fold!.toolCount).toBe(1)
  })
})

describe("formatWorkedDuration", () => {
  it.each([
    [0, "1s"],
    [800, "1s"],
    [45_000, "45s"],
    [60_000, "1m"],
    [788_000, "13m 8s"],
    [3_600_000, "1h"],
    [3_720_000, "1h 2m"],
    [Number.NaN, "1s"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatWorkedDuration(ms)).toBe(expected)
  })
})
