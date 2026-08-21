import { makeConversationLabel } from "./inbox"

describe("makeConversationLabel", () => {
  it("creates conversation-scoped labels and still honors explicit overrides", () => {
    expect(makeConversationLabel()).toMatchObject({ scope: "conversation", name: "follow-up" })
    expect(makeConversationLabel({ scope: "issue", name: "bug" })).toMatchObject({
      scope: "issue",
      name: "bug",
    })
  })
})
