import {
  ContextBudgetExceededError,
  estimateTokens,
  FetchBudget,
  selectContext,
  truncateUtf8,
  utf8Length,
  type ContextItem,
} from "./context-budget"

it("estimates tokens high for non-Latin text and never above the byte length", () => {
  expect(estimateTokens("abcd")).toBe(1)
  expect(estimateTokens("abcde")).toBe(2)
  expect(estimateTokens("字字")).toBe(2)
  for (const text of ["a", "字", "😀x", "mixed 文本 here"]) {
    expect(estimateTokens(text)).toBeLessThanOrEqual(utf8Length(text))
  }
})

it("cuts on character boundaries, marks the cut, and stays within the limit", () => {
  expect(truncateUtf8("short", 100)).toEqual({ text: "short", truncated: false, omittedBytes: 0 })
  const cut = truncateUtf8("字".repeat(100), 120)
  expect(cut.truncated).toBe(true)
  expect(utf8Length(cut.text)).toBeLessThanOrEqual(120)
  expect(cut.text).toMatch(/^字+\n…\[truncated \d+ bytes\]$/)
  expect(cut.omittedBytes + utf8Length(cut.text.split("\n")[0])).toBe(300)
  // Too small for the marker: an unmarked cut, still within the limit.
  expect(truncateUtf8("abcdefgh", 3)).toEqual({ text: "abc", truncated: true, omittedBytes: 5 })
})

it("bounds what collection reads by bytes, pages per kind, and time", () => {
  let now = 0
  const budget = new FetchBudget(
    { maxBytes: 100, maxPagesPerKind: 2, maxDurationMs: 50 },
    () => now
  )
  budget.charge("comments", 10)
  expect(budget.pagesLeft("comments")).toBe(1)
  budget.charge("comments", 10)
  expect(() => budget.charge("comments", 1)).toThrow(ContextBudgetExceededError)
  expect(() => budget.charge("files", 90)).toThrow(expect.objectContaining({ limit: "bytes" }))
  const timed = new FetchBudget({ maxBytes: 1e6, maxPagesPerKind: 9, maxDurationMs: 50 }, () => now)
  now = 51
  expect(() => timed.charge("x", 1)).toThrow(expect.objectContaining({ limit: "time", kind: "x" }))
  expect(budget.fetchedBytes).toBe(110)
})

const item = (over: Partial<ContextItem> & Pick<ContextItem, "id">): ContextItem => ({
  kind: "comment",
  source: `https://example/${over.id}`,
  priority: 5,
  text: "x".repeat(100),
  ...over,
})

it("selects by priority, keeps required items, and counts what it left out", () => {
  const selection = selectContext(
    [
      item({ id: "ci", kind: "ci", priority: 9, text: "c".repeat(900) }),
      item({ id: "old", priority: 6 }),
      item({ id: "instruction", kind: "command", priority: 0, required: true, text: "ask" }),
      item({ id: "parent", kind: "parent", priority: 1, text: "p".repeat(600) }),
    ],
    { maxBytes: 1000, maxTokens: 10_000, maxItemBytes: 700, minUsefulBytes: 400 }
  )
  expect(selection.items.map((entry) => entry.id)).toEqual(["instruction", "parent", "old"])
  expect(selection.omitted).toEqual({ ci: 1 })
  expect(selection.bytes).toBe(3 + 600 + 100)
  expect(selection.truncatedItems).toBe(0)
})

it("cuts an item to the room left when the room is still useful", () => {
  const selection = selectContext(
    [
      item({ id: "a", priority: 1, text: "a".repeat(700) }),
      item({ id: "b", priority: 2, text: "b".repeat(700) }),
    ],
    { maxBytes: 1000, maxTokens: 10_000, maxItemBytes: 1000, minUsefulBytes: 100 }
  )
  expect(selection.items[1]).toMatchObject({ id: "b", truncated: true })
  expect(selection.bytes).toBeLessThanOrEqual(1000)
  expect(selection.truncatedItems).toBe(1)
})

it("applies the per-item cap and the token ceiling", () => {
  const capped = selectContext([item({ id: "big", text: "z".repeat(5000), maxBytes: 300 })], {
    maxBytes: 10_000,
    maxTokens: 10_000,
    maxItemBytes: 1000,
  })
  expect(capped.items[0].bytes).toBeLessThanOrEqual(300)
  const dense = selectContext([item({ id: "cjk", text: "字".repeat(2000) })], {
    maxBytes: 100_000,
    maxTokens: 600,
    maxItemBytes: 100_000,
  })
  expect(dense.estimatedTokens).toBeLessThanOrEqual(600)
})

it("fails rather than silently drop a required item that has no room", () => {
  expect(() =>
    selectContext(
      [
        item({ id: "a", required: true, text: "a".repeat(100) }),
        item({ id: "b", required: true, kind: "parent", text: "b" }),
      ],
      { maxBytes: 100, maxTokens: 1000, maxItemBytes: 100 }
    )
  ).toThrow(expect.objectContaining({ kind: "parent" }))
})
