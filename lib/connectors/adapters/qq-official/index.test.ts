import { invoke } from "@tauri-apps/api/core"
import { createQQOfficialAdapter } from "./index"
import type { OutboundRequest } from "@/types/connectors/outbound"

const mockInvoke = invoke as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function adapter() {
  return createQQOfficialAdapter({
    id: "qq-1",
    displayName: "QQ Bot",
    accessToken: async () => "tok",
  })
}

function sendReq(extra: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    conversationRef: {
      platform: "qq-official",
      adapterId: "qq-1",
      scene: "group",
      sceneId: "GO",
      msgId: "m1",
    },
    segments: [{ type: "text", text: "hello" }],
    metadata: { idempotencyKey: "k" },
    ...extra,
  }
}

beforeEach(() => mockInvoke.mockReset())

describe("createQQOfficialAdapter", () => {
  it("exposes correct meta and initial health", () => {
    const a = adapter()
    expect(a.meta.type).toBe("qq-official")
    expect(a.meta.transportModes).toContain("gateway")
    expect(a.meta.capabilities).toContain("send.text")
    expect(a.health().state).toBe("starting")
  })

  it("send() POSTs a group message and returns the message id", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { id: "sent-1" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBe("sent-1")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/v2/groups/GO/messages")
    expect(req.headers.Authorization).toBe("QQBot tok")
    expect(JSON.parse(req.body)).toMatchObject({ content: "hello", msg_type: 0, msg_id: "m1" })
  })

  it("send() rejects an unaddressable ref", async () => {
    const res = await adapter().send({
      conversationRef: { platform: "qq-official", adapterId: "qq-1" },
      segments: [{ type: "text", text: "x" }],
      metadata: { idempotencyKey: "k" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
  })

  it("maps a 401 to a non-retryable auth_failed", async () => {
    mockInvoke.mockResolvedValue(httpResp(401, { message: "bad token", code: 11244 }))
    const res = await adapter().send(sendReq())
    expect(res.error?.code).toBe("auth_failed")
    expect(res.error?.retryable).toBe(false)
  })

  it("maps a 429 to rate_limited", async () => {
    mockInvoke.mockResolvedValue(httpResp(429, { message: "slow" }))
    const res = await adapter().send(sendReq())
    expect(res.error?.code).toBe("rate_limited")
  })
})
