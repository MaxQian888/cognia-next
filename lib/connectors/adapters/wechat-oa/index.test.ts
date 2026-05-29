import { invoke } from "@tauri-apps/api/core"
import { createWechatOaAdapter } from "./index"
import type { OutboundRequest } from "@/types/connectors/outbound"

const mockInvoke = invoke as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function adapter() {
  return createWechatOaAdapter({
    id: "wxoa-1",
    displayName: "OA Bot",
    accessToken: async () => "tok",
  })
}

function sendReq(openId: string | undefined = "oUser"): OutboundRequest {
  return {
    conversationRef: { platform: "wechat-oa", adapterId: "wxoa-1", openId },
    segments: [{ type: "text", text: "hi" }],
    metadata: { idempotencyKey: "k" },
  }
}

beforeEach(() => mockInvoke.mockReset())

describe("createWechatOaAdapter", () => {
  it("exposes correct meta and initial health", () => {
    const a = adapter()
    expect(a.meta.type).toBe("wechat-oa")
    expect(a.meta.transportModes).toContain("webhook")
    expect(a.meta.capabilities).toContain("send.text")
    expect(a.health().state).toBe("starting")
  })

  it("send() posts a 客服 message and reports success", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { errcode: 0, errmsg: "ok" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(true)
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/cgi-bin/message/custom/send?access_token=tok")
    expect(JSON.parse(req.body)).toEqual({
      touser: "oUser",
      msgtype: "text",
      text: { content: "hi" },
    })
  })

  it("send() maps the 48h-window errcode to a non-retryable validation error", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(200, { errcode: 45015, errmsg: "response out of time limit" })
    )
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
    expect(res.error?.retryable).toBe(false)
  })

  it("send() rejects a request without an openId", async () => {
    const res = await adapter().send({
      conversationRef: { platform: "wechat-oa", adapterId: "wxoa-1" },
      segments: [{ type: "text", text: "x" }],
      metadata: { idempotencyKey: "k" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
