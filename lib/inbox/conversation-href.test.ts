import { inboxConversationHref, inboxScopeHref, inboxSessionHref } from "./conversation-href"

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

describe("inboxSessionHref", () => {
  it("names the exact session alongside the encoded key", () => {
    expect(inboxSessionHref("lark:a1:oc/x", "s 1")).toBe(
      "/inbox/c?key=lark%3Aa1%3Aoc%2Fx&sessionId=s%201"
    )
  })
})

describe("inboxScopeHref", () => {
  it("builds the adapter route", () => {
    expect(inboxScopeHref({ kind: "adapter", adapterId: "a/1" })).toBe(
      "/inbox/adapter?adapterId=a%2F1"
    )
  })

  it("builds the platform route with the route's `kind` param", () => {
    expect(inboxScopeHref({ kind: "platform", platform: "wechat-oa" })).toBe(
      "/inbox/platform?kind=wechat-oa"
    )
  })
})
