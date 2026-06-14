import { defineCompactionStrategy } from "./define-compaction-strategy"

describe("defineCompactionStrategy", () => {
  it("returns the strategy definition unchanged (pure pass-through)", () => {
    const def = defineCompactionStrategy({
      id: "keep-recent-8",
      label: "Keep recent 8",
      summaryPrompt: "Summarise the older turns.",
      keepRecent: 8,
      fraction: 0.5,
    })
    expect(def).toMatchObject({ id: "keep-recent-8", keepRecent: 8, fraction: 0.5 })
  })
})
