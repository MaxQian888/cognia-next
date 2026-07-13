import {
  serializeOutboundV11,
  serializeOutboundV12,
  serializeDeleteV11,
  serializeDeleteV12,
  serializeEditV11,
  serializeEditV12,
  serializeTypingV11,
  serializeTypingV12,
  serializeSetMsgEmojiLike,
  serializeGetLoginInfoV11,
  serializeGetLoginInfoV12,
  serializeGetForwardMsgV11,
  serializeGetMsgV11,
  serializeSendForwardMsgV11,
  OneBotUnsupportedError,
  OneBotValidationError,
} from "./serialize"
import type { OutboundRequest } from "@/types/connectors/outbound"

function makePrivateReq(text: string): OutboundRequest {
  return {
    conversationRef: { platform: "onebot", adapterId: "ob-1", chatKey: "p:200001" },
    segments: [{ type: "text", text }],
    metadata: { idempotencyKey: "k1" },
  }
}

function makeGroupReq(text: string): OutboundRequest {
  return {
    conversationRef: { platform: "onebot", adapterId: "ob-1", chatKey: "g:300001" },
    segments: [{ type: "text", text }],
    metadata: { idempotencyKey: "k2" },
  }
}

// ---------------------------------------------------------------------------
// v11 serialiser
// ---------------------------------------------------------------------------

describe("serializeOutboundV11", () => {
  it("private text → send_private_msg with numeric user_id (v11 spec types it number)", () => {
    const calls = serializeOutboundV11(makePrivateReq("hello"), "100000")
    expect(calls).toHaveLength(1)
    expect(calls[0].action).toBe("send_private_msg")
    expect(calls[0].params.user_id).toBe(200001)
    expect(calls[0].params.message).toEqual([{ type: "text", data: { text: "hello" } }])
    expect(typeof calls[0].echo).toBe("string")
    expect(calls[0].echo.length).toBeGreaterThan(0)
  })

  it("group text → send_group_msg with numeric group_id", () => {
    const calls = serializeOutboundV11(makeGroupReq("group hi"), "100000")
    expect(calls).toHaveLength(1)
    expect(calls[0].action).toBe("send_group_msg")
    expect(calls[0].params.group_id).toBe(300001)
  })

  it("passes non-numeric ids through unchanged", () => {
    const req: OutboundRequest = {
      conversationRef: { platform: "onebot", adapterId: "ob-1", chatKey: "p:user-abc" },
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: "k-nonnum" },
    }
    const calls = serializeOutboundV11(req, "100000")
    expect(calls[0].params.user_id).toBe("user-abc")
  })

  it("throws OneBotValidationError when the conversationRef has no chat target", () => {
    const req: OutboundRequest = {
      conversationRef: { platform: "onebot", adapterId: "ob-1" },
      segments: [{ type: "text", text: "lost" }],
      metadata: { idempotencyKey: "k-notarget" },
    }
    expect(() => serializeOutboundV11(req, "100000")).toThrow(OneBotValidationError)
    expect(() => serializeOutboundV11(req, "100000")).toThrow(/no chat target/)
  })

  it("includes reply segment when replyTo is set", () => {
    const req: OutboundRequest = {
      ...makeGroupReq("ok"),
      replyTo: { messageId: "5555" },
    }
    const calls = serializeOutboundV11(req, "100000")
    expect(calls).toHaveLength(1)
    const msg = calls[0].params.message as Array<{ type: string; data: Record<string, unknown> }>
    expect(msg[0].type).toBe("reply")
    expect(msg[0].data.id).toBe("5555")
  })

  it("image segment", () => {
    const req: OutboundRequest = {
      conversationRef: { platform: "onebot", adapterId: "ob-1", chatKey: "p:200001" },
      segments: [{ type: "image", url: "https://img.example/a.png" }],
      metadata: { idempotencyKey: "k3" },
    }
    const calls = serializeOutboundV11(req, "100000")
    const msg = calls[0].params.message as Array<{ type: string; data: Record<string, unknown> }>
    expect(msg[0].type).toBe("image")
    expect(msg[0].data.file).toBe("https://img.example/a.png")
  })

  it("mention segment → at in v11", () => {
    const req: OutboundRequest = {
      conversationRef: { platform: "onebot", adapterId: "ob-1", chatKey: "g:300001" },
      segments: [{ type: "mention", userId: "42" }],
      metadata: { idempotencyKey: "k4" },
    }
    const calls = serializeOutboundV11(req, "100000")
    const msg = calls[0].params.message as Array<{ type: string; data: Record<string, unknown> }>
    expect(msg[0].type).toBe("at")
    expect(msg[0].data.qq).toBe("42")
  })

  it("returns empty array for empty segments", () => {
    const req: OutboundRequest = {
      conversationRef: { platform: "onebot", adapterId: "ob-1", chatKey: "p:200001" },
      segments: [],
      metadata: { idempotencyKey: "k5" },
    }
    expect(serializeOutboundV11(req, "100000")).toHaveLength(0)
  })

  it("echo strings are unique per call", () => {
    const calls1 = serializeOutboundV11(makePrivateReq("a"), "100000")
    const calls2 = serializeOutboundV11(makePrivateReq("b"), "100000")
    expect(calls1[0].echo).not.toBe(calls2[0].echo)
  })
})

// ---------------------------------------------------------------------------
// v12 serialiser
// ---------------------------------------------------------------------------

describe("serializeOutboundV12", () => {
  it("private text → send_message with detail_type=private", () => {
    const calls = serializeOutboundV12(makePrivateReq("hello v12"), "100000")
    expect(calls).toHaveLength(1)
    expect(calls[0].action).toBe("send_message")
    expect(calls[0].params.detail_type).toBe("private")
    expect(calls[0].params.user_id).toBe("200001")
    const msg = calls[0].params.message as Array<{ type: string; data: Record<string, unknown> }>
    expect(msg[0].type).toBe("text")
  })

  it("group text → send_message with detail_type=group", () => {
    const calls = serializeOutboundV12(makeGroupReq("group v12"), "100000")
    expect(calls).toHaveLength(1)
    expect(calls[0].params.detail_type).toBe("group")
    expect(calls[0].params.group_id).toBe("300001")
  })

  it("includes reply segment when replyTo is set (v12)", () => {
    const req: OutboundRequest = {
      ...makeGroupReq("yes"),
      replyTo: { messageId: "m-999" },
    }
    const calls = serializeOutboundV12(req, "100000")
    const msg = calls[0].params.message as Array<{ type: string; data: Record<string, unknown> }>
    expect(msg[0].type).toBe("reply")
    expect(msg[0].data.message_id).toBe("m-999")
  })

  it("mention segment uses user_id in v12", () => {
    const req: OutboundRequest = {
      conversationRef: { platform: "onebot", adapterId: "ob-1", chatKey: "g:300001" },
      segments: [{ type: "mention", userId: "77" }],
      metadata: { idempotencyKey: "k6" },
    }
    const calls = serializeOutboundV12(req, "100000")
    const msg = calls[0].params.message as Array<{ type: string; data: Record<string, unknown> }>
    expect(msg[0].type).toBe("mention")
    expect(msg[0].data.user_id).toBe("77")
  })

  it("keeps v12 ids as strings (v12 spec types them string)", () => {
    const calls = serializeOutboundV12(makePrivateReq("hello v12"), "100000")
    expect(calls[0].params.user_id).toBe("200001")
  })

  it("throws OneBotValidationError for v12 media segments (upload_file not implemented)", () => {
    for (const seg of [
      { type: "image" as const, url: "https://x.com/a.png" },
      { type: "voice" as const, url: "https://x.com/v.amr" },
      { type: "video" as const, url: "https://x.com/v.mp4" },
      {
        type: "file" as const,
        url: "https://x.com/f.pdf",
        name: "f.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
      },
    ]) {
      const req: OutboundRequest = {
        conversationRef: { platform: "onebot", adapterId: "ob-1", chatKey: "g:300001" },
        segments: [seg],
        metadata: { idempotencyKey: `k-media-${seg.type}` },
      }
      expect(() => serializeOutboundV12(req, "100000")).toThrow(OneBotValidationError)
      expect(() => serializeOutboundV12(req, "100000")).toThrow(/requires upload_file/)
    }
  })
})

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("serializeDeleteV11", () => {
  it("produces delete_msg action with numeric message_id", () => {
    const call = serializeDeleteV11("12345", "100000")
    expect(call.action).toBe("delete_msg")
    expect(call.params.message_id).toBe(12345)
  })
})

describe("serializeDeleteV12", () => {
  it("produces delete_message action with string message_id", () => {
    const call = serializeDeleteV12("m-999", "100000")
    expect(call.action).toBe("delete_message")
    expect(call.params.message_id).toBe("m-999")
  })
})

// ---------------------------------------------------------------------------
// reaction (NapCat set_msg_emoji_like)
// ---------------------------------------------------------------------------

describe("serializeSetMsgEmojiLike", () => {
  it("produces set_msg_emoji_like with numeric message_id and emoji_id (set defaults true)", () => {
    const call = serializeSetMsgEmojiLike("12345", "128077")
    expect(call.action).toBe("set_msg_emoji_like")
    expect(call.params.message_id).toBe(12345)
    expect(call.params.emoji_id).toBe("128077")
    expect(call.params.set).toBe(true)
  })

  it("set:false removes the reaction", () => {
    const call = serializeSetMsgEmojiLike("12345", "128077", false)
    expect(call.params.set).toBe(false)
    expect(call.params.emoji_id).toBe("128077")
  })

  it("echo strings are unique per call", () => {
    const a = serializeSetMsgEmojiLike("1", "76")
    const b = serializeSetMsgEmojiLike("1", "76")
    expect(a.echo).not.toBe(b.echo)
  })
})

// ---------------------------------------------------------------------------
// single-message fetch (get_msg)
// ---------------------------------------------------------------------------

describe("serializeGetMsgV11", () => {
  it("produces get_msg with a numeric message_id for numeric ids", () => {
    const call = serializeGetMsgV11("5555")
    expect(call.action).toBe("get_msg")
    expect(call.params.message_id).toBe(5555)
  })

  it("passes non-numeric message ids through unchanged", () => {
    const call = serializeGetMsgV11("m-abc")
    expect(call.params.message_id).toBe("m-abc")
  })
})

// ---------------------------------------------------------------------------
// edit (unsupported)
// ---------------------------------------------------------------------------

describe("serializeEditV11", () => {
  it("throws OneBotUnsupportedError", () => {
    const req = makeGroupReq("edited")
    expect(() => serializeEditV11("1", req)).toThrow(OneBotUnsupportedError)
  })
})

describe("serializeEditV12", () => {
  it("throws OneBotUnsupportedError", () => {
    const req = makeGroupReq("edited")
    expect(() => serializeEditV12("1", req)).toThrow(OneBotUnsupportedError)
  })
})

// ---------------------------------------------------------------------------
// typing (no-op)
// ---------------------------------------------------------------------------

describe("serializeTypingV11", () => {
  it("returns empty array (no-op)", () => {
    expect(serializeTypingV11("onebot:ob-1:g:300001", true)).toHaveLength(0)
    expect(serializeTypingV11("onebot:ob-1:g:300001", false)).toHaveLength(0)
  })
})

describe("serializeTypingV12", () => {
  it("returns empty array (no-op)", () => {
    expect(serializeTypingV12("onebot:ob-1:g:300001", true)).toHaveLength(0)
    expect(serializeTypingV12("onebot:ob-1:g:300001", false)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// identity probe (get_login_info / get_self_info)
// ---------------------------------------------------------------------------

describe("serializeGetLoginInfoV11", () => {
  it("produces get_login_info with empty params", () => {
    const call = serializeGetLoginInfoV11()
    expect(call.action).toBe("get_login_info")
    expect(call.params).toEqual({})
    expect(call.echo.length).toBeGreaterThan(0)
  })
})

describe("serializeGetLoginInfoV12", () => {
  it("produces get_self_info with empty params", () => {
    const call = serializeGetLoginInfoV12()
    expect(call.action).toBe("get_self_info")
    expect(call.params).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// merged-forward fetch (get_forward_msg)
// ---------------------------------------------------------------------------

describe("serializeGetForwardMsgV11", () => {
  it("produces get_forward_msg carrying the forward id under both keys", () => {
    const call = serializeGetForwardMsgV11("fwd-abc")
    expect(call.action).toBe("get_forward_msg")
    expect(call.params.id).toBe("fwd-abc")
    expect(call.params.message_id).toBe("fwd-abc")
  })
})

// ---------------------------------------------------------------------------
// merged-forward send (send_group/private_forward_msg)
// ---------------------------------------------------------------------------

describe("serializeSendForwardMsgV11", () => {
  it("group target → send_group_forward_msg with node segments", () => {
    const call = serializeSendForwardMsgV11({ messageIds: ["1", "2"], target: "g:300001" })
    expect(call).not.toBeNull()
    expect(call!.action).toBe("send_group_forward_msg")
    expect(call!.params.group_id).toBe(300001)
    expect(call!.params.messages).toEqual([
      { type: "node", data: { id: "1" } },
      { type: "node", data: { id: "2" } },
    ])
  })

  it("private target → send_private_forward_msg", () => {
    const call = serializeSendForwardMsgV11({ messageIds: ["9"], target: "p:200001" })
    expect(call!.action).toBe("send_private_forward_msg")
    expect(call!.params.user_id).toBe(200001)
  })

  it("accepts the full onebot conversation key as target", () => {
    const call = serializeSendForwardMsgV11({ messageIds: ["9"], target: "onebot:ob-1:g:300001" })
    expect(call!.action).toBe("send_group_forward_msg")
    expect(call!.params.group_id).toBe(300001)
  })

  it("falls back to a single messageId when messageIds is absent", () => {
    const call = serializeSendForwardMsgV11({ messageId: "7", target: "g:1" })
    expect(call!.params.messages).toEqual([{ type: "node", data: { id: "7" } }])
  })

  it("accepts the full onebot conversation key for a private target", () => {
    const call = serializeSendForwardMsgV11({ messageIds: ["9"], target: "onebot:ob-1:p:200001" })
    expect(call!.action).toBe("send_private_forward_msg")
    expect(call!.params.user_id).toBe(200001)
  })

  it("returns null for a 4-part onebot key with an unknown chat type", () => {
    expect(serializeSendForwardMsgV11({ messageIds: ["1"], target: "onebot:ob-1:x:1" })).toBeNull()
  })

  it("returns null for an unrecognised target", () => {
    expect(serializeSendForwardMsgV11({ messageIds: ["1"], target: "weird" })).toBeNull()
  })

  it("returns null when no message ids are provided", () => {
    expect(serializeSendForwardMsgV11({ target: "g:1" })).toBeNull()
  })
})
