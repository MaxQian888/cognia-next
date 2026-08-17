// Adapter contract suite for WeChat Official Account — mirrors
// `telegram/contract.test.ts`. One `describe` per declared Capability: build
// adapter → mock the Tauri HTTP wrapper → call the adapter method → assert the
// 客服 API request shape (URL + body). Plus one "intentionally absent" case per
// mutation method the adapter does NOT declare.

import { invoke } from "@tauri-apps/api/core"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createWechatOaAdapter } from "./index"
import { clearWechatOaTokenCache } from "./auth"

jest.mock("./transport-webhook", () => ({ startWechatOaWebhook: jest.fn() }))
jest.mock("@/lib/connectors/at-gate", () => ({ gateInboundEvent: jest.fn(async () => true) }))

const mockInvoke = invoke as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function makeAdapter() {
  return createWechatOaAdapter({
    id: "wxoa-contract",
    displayName: "Contract OA",
    accessToken: async () => "TOKEN",
  })
}

function req(segments: OutboundRequest["segments"], openId = "oUser"): OutboundRequest {
  return {
    conversationRef: { platform: "wechat-oa", adapterId: "wxoa-contract", openId },
    segments,
    metadata: { idempotencyKey: "k-contract" },
  }
}

function lastHttpCall(): { url: string; method: string; body: Record<string, unknown> } {
  const calls = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === "connectors_http_request")
  expect(calls.length).toBeGreaterThan(0)
  const r = (calls[calls.length - 1][1] as { req: { url: string; method: string; body?: string } })
    .req
  return { url: r.url, method: r.method, body: r.body ? JSON.parse(r.body) : {} }
}

describe("WeChat OA adapter contract suite", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(httpResp(200, { errcode: 0 }))
    clearWechatOaTokenCache()
  })

  describe("send.text capability", () => {
    it("text becomes POST /cgi-bin/message/custom/send { touser, msgtype: text }", async () => {
      const res = await makeAdapter().send(req([{ type: "text", text: "hello" }]))
      expect(res.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.method).toBe("POST")
      expect(call.url).toBe(
        "https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=TOKEN"
      )
      expect(call.body).toEqual({ touser: "oUser", msgtype: "text", text: { content: "hello" } })
    })

    it("markdown degrades to text (no send.markdown declared)", async () => {
      const adapter = makeAdapter()
      expect(adapter.meta.capabilities).not.toContain("send.markdown")
      await adapter.send(req([{ type: "markdown", md: "**bold**" }]))
      const call = lastHttpCall()
      expect(call.body.msgtype).toBe("text")
    })

    it("outside the 48h window (45015) is a non-retryable validation error", async () => {
      mockInvoke.mockResolvedValue(httpResp(200, { errcode: 45015, errmsg: "out of window" }))
      const res = await makeAdapter().send(req([{ type: "text", text: "late" }]))
      expect(res.ok).toBe(false)
      expect(res.error).toMatchObject({ code: "validation", retryable: false })
    })
  })

  describe("typing capability", () => {
    it("setTyping(on) POSTs custom/typing { touser, command: Typing }; off sends CancelTyping", async () => {
      const adapter = makeAdapter()
      await adapter.setTyping!("wechat-oa:wxoa-contract:oUser", true)
      let call = lastHttpCall()
      expect(call.url).toBe(
        "https://api.weixin.qq.com/cgi-bin/message/custom/typing?access_token=TOKEN"
      )
      expect(call.body).toEqual({ touser: "oUser", command: "Typing" })
      await adapter.setTyping!("wechat-oa:wxoa-contract:oUser", false)
      call = lastHttpCall()
      expect(call.body).toEqual({ touser: "oUser", command: "CancelTyping" })
    })

    it("swallows the 48h-window / quota errcodes as best-effort", async () => {
      mockInvoke.mockResolvedValue(httpResp(200, { errcode: 45047, errmsg: "over limit" }))
      await expect(
        makeAdapter().setTyping!("wechat-oa:wxoa-contract:oUser", true)
      ).resolves.toBeUndefined()
    })
  })

  describe("delete / edit / send.reaction / history.fetch (intentionally absent)", () => {
    it("declares none of them and implements no method for them (客服 messages cannot be recalled/edited)", () => {
      const adapter = makeAdapter()
      for (const cap of [
        "delete",
        "edit",
        "send.reaction",
        "history.fetch",
        "send.reply",
      ] as const) {
        expect(adapter.meta.capabilities).not.toContain(cap)
      }
      expect(adapter.delete).toBeUndefined()
      expect(adapter.edit).toBeUndefined()
      expect(adapter.addReaction).toBeUndefined()
      expect(adapter.removeReaction).toBeUndefined()
      expect(adapter.fetchHistory).toBeUndefined()
      expect(adapter.streamReply).toBeUndefined()
    })
  })
})
