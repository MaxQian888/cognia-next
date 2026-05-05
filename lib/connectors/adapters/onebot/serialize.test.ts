import {
  serializeOutboundV11,
  serializeOutboundV12,
  serializeDeleteV11,
  serializeDeleteV12,
  serializeEditV11,
  serializeEditV12,
  serializeTypingV11,
  serializeTypingV12,
  OneBotUnsupportedError,
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
  it("private text → send_private_msg", () => {
    const calls = serializeOutboundV11(makePrivateReq("hello"), "100000")
    expect(calls).toHaveLength(1)
    expect(calls[0].action).toBe("send_private_msg")
    expect(calls[0].params.user_id).toBe("200001")
    expect(calls[0].params.message).toEqual([{ type: "text", data: { text: "hello" } }])
    expect(typeof calls[0].echo).toBe("string")
    expect(calls[0].echo.length).toBeGreaterThan(0)
  })

  it("group text → send_group_msg", () => {
    const calls = serializeOutboundV11(makeGroupReq("group hi"), "100000")
    expect(calls).toHaveLength(1)
    expect(calls[0].action).toBe("send_group_msg")
    expect(calls[0].params.group_id).toBe("300001")
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
