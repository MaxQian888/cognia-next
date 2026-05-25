import { buildWorkflowChatStarters } from "./workflow-chat-starters"

describe("buildWorkflowChatStarters", () => {
  // Echo the i18n key so we can assert which namespace entries are read.
  const t = (key: string) => `t:${key}`

  it("returns the four workflow starter cards in order", () => {
    const starters = buildWorkflowChatStarters(t)
    expect(starters.map((s) => s.key)).toEqual(["build", "explain", "validate", "suggest"])
  })

  it("pulls title/prompt from the starters.* namespace and attaches an icon", () => {
    const starters = buildWorkflowChatStarters(t)
    for (const s of starters) {
      expect(s.title).toBe(`t:starters.${s.key}Title`)
      expect(s.prompt).toBe(`t:starters.${s.key}Prompt`)
      expect(s.icon).toBeDefined()
    }
  })
})
