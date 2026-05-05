// Generic adapter contract suite for the Slack adapter — Task 78.
// Exercises every advertised capability flag end-to-end:
// build adapter → mock the Tauri HTTP wrapper → call the adapter method →
// assert the outbound HTTP request shape (URL + payload) matches what Slack expects.

import { invoke } from "@tauri-apps/api/core"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createSlackAdapter } from "./index"

const mockInvoke = invoke as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSendOkResp(ts = "1234567890.123456") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, ts }),
  }
}

function makeAdapter() {
  return createSlackAdapter({
    id: "sl-contract",
    displayName: "Contract Test Bot",
    botToken: async () => "xoxb-TOKEN",
    appToken: async () => "xapp-TOKEN",
    signingSecret: async () => "signing-secret",
    selfId: "UBOT111",
    transport: "socket-mode",
  })
}

/**
 * Pull the most recent connectors_http_request payload from the mock.
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

describe("Slack adapter contract suite", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") return "handle-id"
      if (cmd === "connectors_ws_send") return undefined
      if (cmd === "connectors_ws_close") return undefined
      return makeSendOkResp()
    })
  })

  // -------------------------------------------------------------------------
  // send.text
  // -------------------------------------------------------------------------

  describe("send.text capability", () => {
    it("plain text becomes POST chat.postMessage with blocks containing mrkdwn text", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t1"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01ABCDEF",
        },
        segments: [{ type: "text", text: "hello world" }],
        metadata: { idempotencyKey: "k1" },
      }
      const result = await adapter.send(req)
      expect(result.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.url).toContain("chat.postMessage")
      expect(call.method).toBe("POST")
      const blocks = call.body["blocks"] as Array<{ type: string; text?: { text: string } }>
      expect(blocks).toBeDefined()
      expect(blocks[0].text?.text).toBe("hello world")
    })
  })

  // -------------------------------------------------------------------------
  // send.markdown
  // -------------------------------------------------------------------------

  describe("send.markdown capability", () => {
    it("mrkdwn escapes < > & in markdown text", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t2"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01",
        },
        segments: [{ type: "markdown", md: "<b>bold</b> & *italic*" }],
        metadata: { idempotencyKey: "k2" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      const blocks = call.body["blocks"] as Array<{ text?: { text: string; type: string } }>
      expect(blocks[0].text?.type).toBe("mrkdwn")
      // < and & should be escaped; * passes through
      expect(blocks[0].text?.text).toContain("&lt;b&gt;")
      expect(blocks[0].text?.text).toContain("&amp;")
      expect(blocks[0].text?.text).toContain("*italic*")
    })
  })

  // -------------------------------------------------------------------------
  // send.image
  // -------------------------------------------------------------------------

  describe("send.image capability", () => {
    it("image segment produces an image block in blocks[]", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t3"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01",
        },
        segments: [{ type: "image", url: "https://example.com/img.png", alt: "my image" }],
        metadata: { idempotencyKey: "k3" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      const blocks = call.body["blocks"] as Array<{
        type: string
        image_url?: string
        alt_text?: string
      }>
      expect(blocks[0].type).toBe("image")
      expect(blocks[0].image_url).toBe("https://example.com/img.png")
      expect(blocks[0].alt_text).toBe("my image")
    })
  })

  // -------------------------------------------------------------------------
  // send.file
  // -------------------------------------------------------------------------

  describe("send.file capability", () => {
    it("file segment produces a mrkdwn link block", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t4"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01",
        },
        segments: [
          {
            type: "file",
            url: "https://example.com/report.pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12345,
          },
        ],
        metadata: { idempotencyKey: "k4" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      const blocks = call.body["blocks"] as Array<{ text?: { text: string } }>
      expect(blocks[0].text?.text).toContain("https://example.com/report.pdf")
      expect(blocks[0].text?.text).toContain("report.pdf")
    })
  })

  // -------------------------------------------------------------------------
  // send.reply (thread_ts)
  // -------------------------------------------------------------------------

  describe("send.reply capability", () => {
    it("conversationRef.threadTs becomes thread_ts in the payload", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t5"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01",
          threadTs: "1600000000.000001",
        },
        segments: [{ type: "text", text: "replying in thread" }],
        metadata: { idempotencyKey: "k5" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.body["thread_ts"]).toBe("1600000000.000001")
      expect(call.body["channel"]).toBe("C01")
    })
  })

  // -------------------------------------------------------------------------
  // send.thread (posting to a thread channel)
  // -------------------------------------------------------------------------

  describe("send.thread capability", () => {
    it("posting with thread_ts uses that ts for thread routing", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t6"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01THREAD",
          threadTs: "1700000000.000002",
        },
        segments: [{ type: "text", text: "thread message" }],
        metadata: { idempotencyKey: "k6" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.url).toContain("chat.postMessage")
      expect(call.body["channel"]).toBe("C01THREAD")
      expect(call.body["thread_ts"]).toBe("1700000000.000002")
    })
  })

  // -------------------------------------------------------------------------
  // send.mention
  // -------------------------------------------------------------------------

  describe("send.mention capability", () => {
    it("mention segment produces <@userId> in mrkdwn block", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t7"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01",
        },
        segments: [{ type: "mention", userId: "UABC123" }],
        metadata: { idempotencyKey: "k7" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      const blocks = call.body["blocks"] as Array<{ text?: { text: string } }>
      expect(blocks[0].text?.text).toBe("<@UABC123>")
    })
  })

  // -------------------------------------------------------------------------
  // edit
  // -------------------------------------------------------------------------

  describe("edit capability", () => {
    it("edit() posts to chat.update with channel, ts, and blocks", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t8"))
      const adapter = makeAdapter()
      const patch: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01EDIT",
        },
        segments: [{ type: "text", text: "edited content" }],
        metadata: { idempotencyKey: "k8" },
      }
      const result = await adapter.edit!("1600000001.000001", patch)
      expect(result.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.url).toContain("chat.update")
      expect(call.method).toBe("POST")
      expect(call.body["channel"]).toBe("C01EDIT")
      expect(call.body["ts"]).toBe("1600000001.000001")
    })
  })

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  describe("delete capability", () => {
    it("delete() posts to chat.delete with channel and ts", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t9"))
      const adapter = makeAdapter()
      // Slack delete format: "channelId:ts"
      await adapter.delete!("C01CHAN:1600000002.000001")
      const call = lastHttpCall()
      expect(call.url).toContain("chat.delete")
      expect(call.method).toBe("POST")
      expect(call.body["channel"]).toBe("C01CHAN")
      expect(call.body["ts"]).toBe("1600000002.000001")
    })
  })

  // -------------------------------------------------------------------------
  // send.reaction
  // -------------------------------------------------------------------------

  describe("send.reaction capability (addReaction)", () => {
    it("addReaction() posts to reactions.add with channel, timestamp, name", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter() as ReturnType<typeof createSlackAdapter> & {
        addReaction: (channel: string, ts: string, name: string) => Promise<void>
      }
      await adapter.addReaction("C01", "1600000003.000001", "thumbsup")
      const call = lastHttpCall()
      expect(call.url).toContain("reactions.add")
      expect(call.method).toBe("POST")
      expect(call.body["channel"]).toBe("C01")
      expect(call.body["timestamp"]).toBe("1600000003.000001")
      expect(call.body["name"]).toBe("thumbsup")
    })
  })

  // -------------------------------------------------------------------------
  // history.fetch (Phase 1 stub — empty)
  // -------------------------------------------------------------------------

  describe("history.fetch capability", () => {
    it("fetchHistory() returns empty async iterable in Phase 1", async () => {
      const adapter = makeAdapter()
      const events: unknown[] = []
      for await (const evt of adapter.fetchHistory!("slack:sl-contract:C01", {})) {
        events.push(evt)
      }
      expect(events).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // rich-card.slack (Block Kit opaque payload)
  // -------------------------------------------------------------------------

  describe("send.card / rich-card.slack capability", () => {
    it("card segment produces a [card] placeholder section block", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t11"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01",
        },
        segments: [{ type: "card", card: { kind: "block_kit", payload: { type: "section" } } }],
        metadata: { idempotencyKey: "k11" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      const blocks = call.body["blocks"] as Array<{ text?: { text: string } }>
      expect(blocks[0].text?.text).toBe("[card]")
    })
  })

  // -------------------------------------------------------------------------
  // setTyping (no-op)
  // -------------------------------------------------------------------------

  describe("setTyping no-op", () => {
    it("setTyping() never calls the Slack API", async () => {
      const adapter = makeAdapter()
      await adapter.setTyping!("slack:sl-contract:C01", true)
      await adapter.setTyping!("slack:sl-contract:C01", false)
      const httpCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_http_request"
      )
      expect(httpCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // send.text + send.image (multi-segment)
  // -------------------------------------------------------------------------

  describe("multi-segment send", () => {
    it("text + image segments produce two blocks in a single postMessage", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("multi-1"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "slack",
          adapterId: "sl-contract",
          channelId: "C01",
        },
        segments: [
          { type: "text", text: "look at this:" },
          { type: "image", url: "https://example.com/p.png" },
        ],
        metadata: { idempotencyKey: "k-multi" },
      }
      const result = await adapter.send(req)
      expect(result.ok).toBe(true)
      const call = lastHttpCall()
      const blocks = call.body["blocks"] as unknown[]
      expect(blocks).toHaveLength(2)
    })
  })
})
