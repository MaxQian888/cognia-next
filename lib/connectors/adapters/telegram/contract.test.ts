// Generic adapter contract suite, parameterised on adapter factory + fixture
// set. Phase 1 only points it at the Telegram adapter; Phase 2 will reuse the
// same harness for Discord/Slack/Lark/OneBot.
//
// Each `it()` exercises one advertised capability flag end-to-end:
// build adapter → mock the Tauri HTTP wrapper → call the adapter method →
// assert the outbound HTTP request shape (URL + payload) matches what the
// platform expects.

import { invoke } from "@tauri-apps/api/core"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createTelegramAdapter } from "./index"

const mockInvoke = invoke as jest.Mock

function makeSendOkResp(messageId = 42) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, result: { message_id: messageId } }),
  }
}

function makeAdapter() {
  return createTelegramAdapter({
    id: "tg-contract",
    displayName: "Contract Test Bot",
    transport: "longpoll",
    botToken: async () => "TOKEN",
    selfId: "100",
  })
}

/**
 * Pull the most recent connectors_http_request payload out of the mock so we
 * can assert URL + body in one place per test.
 */
function lastHttpCall(): { url: string; method: string; body: Record<string, unknown> } {
  const calls = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === "connectors_http_request")
  expect(calls.length).toBeGreaterThan(0)
  const last = calls[calls.length - 1]
  const req = (last[1] as { req: { url: string; method: string; body?: string } }).req
  return {
    url: req.url,
    method: req.method,
    body: req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {},
  }
}

describe("Telegram adapter contract suite", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  describe("send.text capability", () => {
    it("plain text segment becomes sendMessage", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: { platform: "telegram", adapterId: "tg-contract", chatId: 123 },
        segments: [{ type: "text", text: "hello world" }],
        metadata: { idempotencyKey: "k1" },
      }
      const result = await adapter.send(req)
      expect(result.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.url).toMatch(/sendMessage$/)
      expect(call.method).toBe("POST")
      expect(call.body).toMatchObject({ chat_id: 123, text: "hello world" })
      expect(call.body.parse_mode).toBeUndefined()
    })
  })

  describe("send.markdown capability", () => {
    it("markdown segment with special chars escapes via MarkdownV2", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: { platform: "telegram", adapterId: "tg-contract", chatId: 1 },
        segments: [{ type: "markdown", md: "_bold_ + (parens) [link](url)" }],
        metadata: { idempotencyKey: "k2" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.body.parse_mode).toBe("MarkdownV2")
      // escaped: _ ( ) [ ]
      expect(call.body.text).toContain("\\_")
      expect(call.body.text).toContain("\\(")
      expect(call.body.text).toContain("\\)")
      expect(call.body.text).toContain("\\[")
      expect(call.body.text).toContain("\\]")
    })
  })

  describe("send.image capability", () => {
    it("image segment becomes sendPhoto", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: { platform: "telegram", adapterId: "tg-contract", chatId: 1 },
        segments: [{ type: "image", url: "https://example.com/p.png", alt: "pic" }],
        metadata: { idempotencyKey: "k3" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.url).toMatch(/sendPhoto$/)
      expect(call.body).toMatchObject({ chat_id: 1, photo: "https://example.com/p.png" })
    })
  })

  describe("send.reply capability", () => {
    it("OutboundRequest.replyTo becomes reply_to_message_id", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: { platform: "telegram", adapterId: "tg-contract", chatId: 7 },
        segments: [{ type: "text", text: "ok" }],
        replyTo: { messageId: "42" },
        metadata: { idempotencyKey: "k4" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.body.reply_to_message_id).toBe(42)
    })
  })

  describe("send.thread capability", () => {
    it("OutboundRequest.threadId becomes message_thread_id (forum topic)", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: { platform: "telegram", adapterId: "tg-contract", chatId: 9 },
        segments: [{ type: "text", text: "topic msg" }],
        threadId: "55",
        metadata: { idempotencyKey: "k5" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.body.message_thread_id).toBe(55)
    })
  })

  describe("edit capability", () => {
    it("edit() routes to editMessageText with message_id", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      const patch: OutboundRequest = {
        conversationRef: { platform: "telegram", adapterId: "tg-contract", chatId: 11 },
        segments: [{ type: "text", text: "edited" }],
        metadata: { idempotencyKey: "k6" },
      }
      await adapter.edit!("777", patch)
      const call = lastHttpCall()
      expect(call.url).toMatch(/editMessageText$/)
      expect(call.body).toMatchObject({ chat_id: 11, message_id: 777, text: "edited" })
    })
  })

  describe("delete capability", () => {
    it("delete() routes to deleteMessage", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp(0))
      const adapter = makeAdapter()
      await adapter.delete!("88")
      const call = lastHttpCall()
      expect(call.url).toMatch(/deleteMessage$/)
      expect(call.body.message_id).toBe(88)
    })
  })

  describe("typing capability", () => {
    it("setTyping(on=true) routes to sendChatAction", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp(0))
      const adapter = makeAdapter()
      await adapter.setTyping!("telegram:tg-contract:42", true)
      const call = lastHttpCall()
      expect(call.url).toMatch(/sendChatAction$/)
      expect(call.body).toMatchObject({ chat_id: "42", action: "typing" })
    })

    it("setTyping(on=false) is a no-op (Telegram has no stop-typing)", async () => {
      const adapter = makeAdapter()
      await adapter.setTyping!("telegram:tg-contract:42", false)
      expect(
        mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === "connectors_http_request")
      ).toHaveLength(0)
    })
  })

  describe("send.text + send.image sequence (mixed segments)", () => {
    it("emits multiple outbound calls in order", async () => {
      mockInvoke
        .mockResolvedValueOnce(makeSendOkResp(101))
        .mockResolvedValueOnce(makeSendOkResp(102))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: { platform: "telegram", adapterId: "tg-contract", chatId: 1 },
        segments: [
          { type: "text", text: "look:" },
          { type: "image", url: "https://example.com/p.png" },
        ],
        metadata: { idempotencyKey: "k7" },
      }
      const result = await adapter.send(req)
      expect(result.ok).toBe(true)
      const httpCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_http_request"
      )
      expect(httpCalls).toHaveLength(2)
      const urls = httpCalls.map((c) => (c[1] as { req: { url: string } }).req.url)
      expect(urls[0]).toMatch(/sendMessage$/)
      expect(urls[1]).toMatch(/sendPhoto$/)
    })
  })

  describe("history.fetch capability (intentionally absent)", () => {
    it("is NOT declared (Telegram Bot API exposes no chat-history endpoint)", () => {
      const adapter = makeAdapter()
      expect(adapter.meta.capabilities).not.toContain("history.fetch")
      expect(adapter.fetchHistory).toBeUndefined()
    })
  })
})
