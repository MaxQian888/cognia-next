import { KNOWLEDGE_READING_BOUNDS, resolveKnowledgeReadingSettings } from "./reading-settings"

it("preserves compatible defaults and resolves app, character, then session overrides", () => {
  expect(resolveKnowledgeReadingSettings()).toMatchObject({
    enabled: false,
    retrievalStrategy: "vector",
    ragTokenBudget: 2000,
    topKPerBase: 5,
  })
  expect(
    resolveKnowledgeReadingSettings(
      { enabled: true, maxCalls: 10 },
      { maxCalls: 5 },
      { retrievalStrategy: "keyword", maxCalls: 2 }
    )
  ).toMatchObject({ enabled: true, maxCalls: 2, retrievalStrategy: "keyword" })
})
it("clamps budgets, rejects invalid numeric overrides and permits explicit zero budgets", () => {
  expect(
    resolveKnowledgeReadingSettings({
      maxCalls: 99999,
      totalReadChars: 0,
      ragTokenBudget: NaN,
      maxReadChars: -1,
    })
  ).toMatchObject({ maxCalls: 1000, totalReadChars: 0, ragTokenBudget: 2000, maxReadChars: 1 })
})

it("shares every numeric control bound with runtime clamping", () => {
  for (const [field, [min, max]] of Object.entries(KNOWLEDGE_READING_BOUNDS)) {
    expect(resolveKnowledgeReadingSettings({ [field]: -1 })).toHaveProperty(field, min)
    expect(resolveKnowledgeReadingSettings({ [field]: max + 1 })).toHaveProperty(field, max)
  }
})
