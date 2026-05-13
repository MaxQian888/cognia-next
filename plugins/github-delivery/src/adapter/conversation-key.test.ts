import {
  buildRemoteChatId,
  decodeConversationKey,
  encodeConversationKey,
  parseRemoteChatId,
} from "./conversation-key"

describe("buildRemoteChatId", () => {
  it("formats PR refs as <owner>/<repo>#pr-<n>", () => {
    expect(buildRemoteChatId({ owner: "octo", repo: "hello", kind: "pr", number: 42 })).toBe(
      "octo/hello#pr-42"
    )
  })
  it("formats issue refs as <owner>/<repo>#issue-<n>", () => {
    expect(buildRemoteChatId({ owner: "octo", repo: "hello", kind: "issue", number: 7 })).toBe(
      "octo/hello#issue-7"
    )
  })
})

describe("encodeConversationKey round-trips through decodeConversationKey", () => {
  it("preserves owner/repo/kind/number across encode → decode", () => {
    const coords = { owner: "octo", repo: "hello-world", kind: "pr" as const, number: 99 }
    const encoded = encodeConversationKey(coords)
    expect(encoded).toBe("github:github-delivery:octo/hello-world#pr-99")
    expect(decodeConversationKey(encoded)).toEqual(coords)
  })
})

describe("decodeConversationKey", () => {
  it("returns null for non-github platforms", () => {
    expect(decodeConversationKey("telegram:tg-abc:chat-1")).toBeNull()
  })
  it("returns null for a different adapterId", () => {
    expect(decodeConversationKey("github:some-other:octo/hello#pr-1")).toBeNull()
  })
  it("returns null for malformed keys", () => {
    expect(decodeConversationKey("not a key")).toBeNull()
    expect(decodeConversationKey("github:github-delivery:")).toBeNull()
  })
  it("returns null for issue/pr numbers that are not positive integers", () => {
    expect(decodeConversationKey("github:github-delivery:o/r#pr-0")).toBeNull()
    expect(decodeConversationKey("github:github-delivery:o/r#pr-NaN")).toBeNull()
  })
})

describe("parseRemoteChatId", () => {
  it("rejects shapes without the # separator", () => {
    expect(parseRemoteChatId("octo/hello")).toBeNull()
  })
  it("rejects shapes without a kind-<n> tail", () => {
    expect(parseRemoteChatId("octo/hello#")).toBeNull()
    expect(parseRemoteChatId("octo/hello#pr-")).toBeNull()
    expect(parseRemoteChatId("octo/hello#-7")).toBeNull()
  })
  it("rejects unknown kinds", () => {
    expect(parseRemoteChatId("octo/hello#release-1")).toBeNull()
  })
  it("rejects shapes without an owner / repo separator", () => {
    expect(parseRemoteChatId("hello#pr-1")).toBeNull()
    expect(parseRemoteChatId("/repo#pr-1")).toBeNull()
    expect(parseRemoteChatId("owner/#pr-1")).toBeNull()
  })
})
