import { parseOneBotEvent, clearAllVariantCaches } from "./parse"

beforeEach(() => {
  clearAllVariantCaches()
})

const V11_PRIVATE_MSG = {
  time: 1700000000,
  self_id: 100000,
  post_type: "message",
  message_type: "private",
  message_id: 1001,
  user_id: 200001,
  sender: { user_id: 200001, nickname: "Alice" },
  message: [{ type: "text", data: { text: "hello v11" } }],
}

const V12_PRIVATE_MSG = {
  id: "evt-001",
  time: 1700000000,
  type: "message",
  detail_type: "private",
  message_id: "m-1001",
  user_id: "200001",
  self: { platform: "qq", user_id: "100000" },
  sender: { user_id: "200001", nickname: "Bob" },
  message: [{ type: "text", data: { text: "hello v12" } }],
}

describe("parseOneBotEvent — variant detection", () => {
  it("detects v11 from message_type field", () => {
    const result = parseOneBotEvent("adapter-a", V11_PRIVATE_MSG)
    expect(result).not.toBeNull()
    expect(result!.variant).toBe("v11")
    expect(result!.parsed).not.toBeNull()
    expect(result!.parsed!.plainText).toBe("hello v11")
  })

  it("detects v12 from detail_type + self fields", () => {
    const result = parseOneBotEvent("adapter-b", V12_PRIVATE_MSG)
    expect(result).not.toBeNull()
    expect(result!.variant).toBe("v12")
    expect(result!.parsed).not.toBeNull()
    expect(result!.parsed!.plainText).toBe("hello v12")
  })

  it("returns null for unrecognised event shape", () => {
    const result = parseOneBotEvent("adapter-c", { foo: "bar" })
    expect(result).toBeNull()
  })

  it("caches variant — second event uses cached v11", () => {
    const first = parseOneBotEvent("adapter-d", V11_PRIVATE_MSG)
    expect(first!.variant).toBe("v11")

    // Second event — no message_type, but cache should still route to v11
    const secondMsg = {
      time: 1700000001,
      self_id: 100000,
      post_type: "message",
      message_type: "private",
      message_id: 1002,
      user_id: 200001,
      sender: { user_id: 200001, nickname: "Alice" },
      message: [{ type: "text", data: { text: "cached" } }],
    }
    const second = parseOneBotEvent("adapter-d", secondMsg)
    expect(second!.variant).toBe("v11")
    expect(second!.parsed!.plainText).toBe("cached")
  })

  it("caches variant — second event uses cached v12", () => {
    parseOneBotEvent("adapter-e", V12_PRIVATE_MSG)

    const secondMsg = {
      id: "evt-002",
      time: 1700000001,
      type: "message",
      detail_type: "private",
      message_id: "m-1002",
      user_id: "200001",
      self: { platform: "qq", user_id: "100000" },
      sender: { user_id: "200001", nickname: "Bob" },
      message: [{ type: "text", data: { text: "second v12" } }],
    }
    const result = parseOneBotEvent("adapter-e", secondMsg)
    expect(result!.variant).toBe("v12")
    expect(result!.parsed!.plainText).toBe("second v12")
  })

  it("returns parsed=null for non-message events (but correct variant)", () => {
    // Seed the cache with v11
    parseOneBotEvent("adapter-f", V11_PRIVATE_MSG)

    const noticeEvent = {
      time: 1700000001,
      self_id: 100000,
      post_type: "notice",
    }
    const result = parseOneBotEvent("adapter-f", noticeEvent)
    expect(result).not.toBeNull()
    expect(result!.variant).toBe("v11")
    expect(result!.parsed).toBeNull()
  })

  it("different adapterIds use independent caches", () => {
    parseOneBotEvent("a1", V11_PRIVATE_MSG)
    parseOneBotEvent("a2", V12_PRIVATE_MSG)

    const r1 = parseOneBotEvent("a1", V11_PRIVATE_MSG)
    const r2 = parseOneBotEvent("a2", V12_PRIVATE_MSG)
    expect(r1!.variant).toBe("v11")
    expect(r2!.variant).toBe("v12")
  })
})
