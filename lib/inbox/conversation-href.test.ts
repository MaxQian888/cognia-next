import { inboxConversationHref } from "./conversation-href"

describe("inboxConversationHref", () => {
  it("encodes the conversation key", () => {
    expect(inboxConversationHref("telegram:a1:c/1")).toBe("/inbox/c?key=telegram%3Aa1%3Ac%2F1")
  })

  it("appends an encoded messageId only when given", () => {
    expect(inboxConversationHref("k", "m 1")).toBe("/inbox/c?key=k&messageId=m%201")
    expect(inboxConversationHref("k", undefined)).toBe("/inbox/c?key=k")
    expect(inboxConversationHref("k", "")).toBe("/inbox/c?key=k")
  })
})
