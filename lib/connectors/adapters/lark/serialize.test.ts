import {
  serializeSend,
  serializeOutboundAsync,
  serializeEdit,
  serializeDelete,
  serializeReaction,
} from "./serialize"
import type { OutboundRequest } from "@/types/connectors/outbound"

function makeReq(opts: { channelId: string; threadTs?: string; text?: string }): OutboundRequest {
  return {
    conversationRef: {
      platform: "lark",
      adapterId: "lark-1",
      channelId: opts.channelId,
      ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
    },
    segments: [{ type: "text", text: opts.text ?? "hello" }],
    metadata: { idempotencyKey: "k1" },
  }
}

describe("serializeSend", () => {
  it("sends to chat_id for oc_ prefixed chat", () => {
    const call = serializeSend(makeReq({ channelId: "oc_chat_001" }))
    expect(call.method).toBe("POST")
    expect(call.url).toContain("/im/v1/messages")
    expect(call.url).toContain("receive_id_type=chat_id")
    expect(call.payload["receive_id"]).toBe("oc_chat_001")
    expect(call.payload["msg_type"]).toBe("text")
  })

  it("sends to open_id for ou_ prefixed id", () => {
    const call = serializeSend(makeReq({ channelId: "ou_user_abc" }))
    expect(call.url).toContain("receive_id_type=open_id")
    expect(call.payload["receive_id"]).toBe("ou_user_abc")
  })

  it("includes reply_in_thread and parent_id when threadTs present", () => {
    const call = serializeSend(makeReq({ channelId: "oc_chat_001", threadTs: "thr_root_001" }))
    expect(call.payload["reply_in_thread"]).toBe(true)
    expect(call.payload["parent_id"]).toBe("thr_root_001")
  })

  it("does not include reply_in_thread when no threadTs", () => {
    const call = serializeSend(makeReq({ channelId: "oc_chat_001" }))
    expect(call.payload["reply_in_thread"]).toBeUndefined()
    expect(call.payload["parent_id"]).toBeUndefined()
  })

  it("content is JSON-stringified", () => {
    const call = serializeSend(makeReq({ channelId: "oc_chat_001", text: "test text" }))
    const content = JSON.parse(call.payload["content"] as string) as { text: string }
    expect(content.text).toBe("test text")
  })

  // A4 — Phase 2 marker closed: serializer now honours explicit
  // receiveIdType + receiveId / openId / userId / email on the ref so the
  // caller can target a user by user_id or email without an open_id.
  it("honours explicit receiveIdType + receiveId on the conversation ref", () => {
    const call = serializeSend({
      conversationRef: {
        platform: "lark",
        adapterId: "lark-1",
        channelId: "ignored",
        receiveIdType: "email",
        receiveId: "alice@example.com",
      } as unknown as OutboundRequest["conversationRef"],
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: "k1" },
    })
    expect(call.url).toContain("receive_id_type=email")
    expect(call.payload["receive_id"]).toBe("alice@example.com")
  })

  it("infers receive_id_type=user_id when ref carries .userId", () => {
    const call = serializeSend({
      conversationRef: {
        platform: "lark",
        adapterId: "lark-1",
        channelId: "ignored",
        userId: "u12345",
      } as unknown as OutboundRequest["conversationRef"],
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: "k1" },
    })
    expect(call.url).toContain("receive_id_type=user_id")
    expect(call.payload["receive_id"]).toBe("u12345")
  })

  it("infers receive_id_type=email when ref carries .email", () => {
    const call = serializeSend({
      conversationRef: {
        platform: "lark",
        adapterId: "lark-1",
        channelId: "ignored",
        email: "bob@example.com",
      } as unknown as OutboundRequest["conversationRef"],
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: "k1" },
    })
    expect(call.url).toContain("receive_id_type=email")
    expect(call.payload["receive_id"]).toBe("bob@example.com")
  })

  it("falls back to chat_id prefix sniff when no explicit type set (legacy)", () => {
    const call = serializeSend(makeReq({ channelId: "oc_chat_legacy" }))
    expect(call.url).toContain("receive_id_type=chat_id")
    expect(call.payload["receive_id"]).toBe("oc_chat_legacy")
  })
})

// The production adapter `send()` uses `serializeOutboundAsync`, not the sync
// `serializeSend`. Before the fix it passed only the chat id to
// `buildReceiveIdParams`, so open_id / user_id / email routing (the A4 marker)
// was silently dropped on the actual send path. These guard that regression.
describe("serializeOutboundAsync (explicit recipient routing)", () => {
  const ADAPTER = "lark-1"

  it("honours explicit receiveIdType + receiveId on the async path", async () => {
    const call = await serializeOutboundAsync(
      {
        conversationRef: {
          platform: "lark",
          adapterId: ADAPTER,
          channelId: "ignored",
          receiveIdType: "email",
          receiveId: "alice@example.com",
        } as unknown as OutboundRequest["conversationRef"],
        segments: [{ type: "text", text: "hi" }],
        metadata: { idempotencyKey: "k1" },
      },
      ADAPTER
    )
    expect(call.method).toBe("POST")
    expect(call.url).toContain("receive_id_type=email")
    expect(call.payload["receive_id"]).toBe("alice@example.com")
  })

  it("infers user_id from ref.userId instead of collapsing to chat_id", async () => {
    const call = await serializeOutboundAsync(
      {
        conversationRef: {
          platform: "lark",
          adapterId: ADAPTER,
          channelId: "ignored",
          userId: "u999",
        } as unknown as OutboundRequest["conversationRef"],
        segments: [{ type: "text", text: "hi" }],
        metadata: { idempotencyKey: "k1" },
      },
      ADAPTER
    )
    expect(call.url).toContain("receive_id_type=user_id")
    expect(call.payload["receive_id"]).toBe("u999")
  })

  it("sniffs open_id from an ou_ prefixed chat id on the async path", async () => {
    const call = await serializeOutboundAsync(makeReq({ channelId: "ou_user_abc" }), ADAPTER)
    expect(call.url).toContain("receive_id_type=open_id")
    expect(call.payload["receive_id"]).toBe("ou_user_abc")
  })

  it("falls back to chat_id prefix sniff on the async path (legacy)", async () => {
    const call = await serializeOutboundAsync(makeReq({ channelId: "oc_chat_legacy" }), ADAPTER)
    expect(call.url).toContain("receive_id_type=chat_id")
    expect(call.payload["receive_id"]).toBe("oc_chat_legacy")
  })

  it("still threads reply_in_thread + parent_id on the async path", async () => {
    const call = await serializeOutboundAsync(
      makeReq({ channelId: "oc_chat_001", threadTs: "thr_root_001" }),
      ADAPTER
    )
    expect(call.payload["reply_in_thread"]).toBe(true)
    expect(call.payload["parent_id"]).toBe("thr_root_001")
  })
})

describe("serializeEdit", () => {
  const req = makeReq({ channelId: "oc_chat_001", text: "edited" })

  it("uses PATCH method", () => {
    const call = serializeEdit("om_msg_001", req)
    expect(call.method).toBe("PATCH")
  })

  it("url contains the message_id", () => {
    const call = serializeEdit("om_msg_001", req)
    expect(call.url).toContain("om_msg_001")
    expect(call.url).toContain("/im/v1/messages/")
  })

  it("payload contains msg_type and content", () => {
    const call = serializeEdit("om_msg_001", req)
    expect(call.payload["msg_type"]).toBe("text")
    const content = JSON.parse(call.payload["content"] as string) as { text: string }
    expect(content.text).toBe("edited")
  })

  it("URL-encodes special chars in message_id", () => {
    const call = serializeEdit("om/special:msg", req)
    expect(call.url).not.toContain("om/special:msg")
    expect(call.url).toContain("om%2Fspecial%3Amsg")
  })
})

describe("serializeDelete", () => {
  it("uses DELETE method", () => {
    const call = serializeDelete("om_msg_002")
    expect(call.method).toBe("DELETE")
  })

  it("url contains the message_id", () => {
    const call = serializeDelete("om_msg_002")
    expect(call.url).toContain("om_msg_002")
    expect(call.url).toContain("/im/v1/messages/")
  })

  it("payload is empty", () => {
    const call = serializeDelete("om_msg_002")
    expect(Object.keys(call.payload)).toHaveLength(0)
  })
})

describe("serializeReaction", () => {
  it("uses POST method", () => {
    const call = serializeReaction("om_msg_003", "THUMBSUP")
    expect(call.method).toBe("POST")
  })

  it("url contains reactions sub-path", () => {
    const call = serializeReaction("om_msg_003", "THUMBSUP")
    expect(call.url).toContain("/reactions")
    expect(call.url).toContain("om_msg_003")
  })

  it("payload contains reaction_type.emoji_type", () => {
    const call = serializeReaction("om_msg_003", "THUMBSUP")
    const reactionType = call.payload["reaction_type"] as { emoji_type: string }
    expect(reactionType.emoji_type).toBe("THUMBSUP")
  })
})
