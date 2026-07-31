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
    const patchFor = (channelId: string): OutboundRequest => ({
      conversationRef: {
        platform: "slack",
        adapterId: "sl-contract",
        channelId,
      },
      segments: [{ type: "text", text: "edited content" }],
      metadata: { idempotencyKey: "k8" },
    })

    it("edit() with a bare ts falls back to conversationRef.channelId", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t8"))
      const adapter = makeAdapter()
      const result = await adapter.edit!("1600000001.000001", patchFor("C01EDIT"))
      expect(result.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.url).toContain("chat.update")
      expect(call.method).toBe("POST")
      expect(call.body["channel"]).toBe("C01EDIT")
      expect(call.body["ts"]).toBe("1600000001.000001")
    })

    it("edit() parses the composite id, preferring its channel", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t8b"))
      const adapter = makeAdapter()
      const result = await adapter.edit!("C77COMP:1600000001.000002", patchFor("C01EDIT"))
      expect(result.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.body["channel"]).toBe("C77COMP")
      expect(call.body["ts"]).toBe("1600000001.000002")
    })

    it("edit() returns a non-retryable validation error when no channel is derivable", async () => {
      const adapter = makeAdapter()
      const result = await adapter.edit!("1600000001.000003", patchFor(""))
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("validation")
      expect(result.error?.retryable).toBe(false)
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

    it("delete() throws (never silently no-ops) on a bare-ts id", async () => {
      const adapter = makeAdapter()
      await expect(adapter.delete!("1600000002.000002")).rejects.toThrow(/"<channelId>:<ts>"/)
      const httpCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_http_request"
      )
      expect(httpCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // send.reaction
  // -------------------------------------------------------------------------

  describe("send.reaction capability (addReaction / removeReaction)", () => {
    it("addReaction() takes the 2-arg contract shape and posts reactions.add", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      const ref = await adapter.addReaction!("C01:1600000003.000001", "thumbsup")
      const call = lastHttpCall()
      expect(call.url).toContain("reactions.add")
      expect(call.method).toBe("POST")
      expect(call.body["channel"]).toBe("C01")
      expect(call.body["timestamp"]).toBe("1600000003.000001")
      expect(call.body["name"]).toBe("thumbsup")
      // Slack reactions are keyed by emoji name — it rides back as the ref.
      expect(ref).toEqual({ reactionId: "thumbsup" })
    })

    it("addReaction() strips surrounding colons from the emoji name", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      await adapter.addReaction!("C01:1600000003.000002", ":thumbsup:")
      const call = lastHttpCall()
      expect(call.body["name"]).toBe("thumbsup")
    })

    it("addReaction() throws a clear error on a bare-ts message id", async () => {
      const adapter = makeAdapter()
      await expect(adapter.addReaction!("1600000003.000003", "thumbsup")).rejects.toThrow(
        /"<channelId>:<ts>"/
      )
      const httpCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_http_request"
      )
      expect(httpCalls).toHaveLength(0)
    })

    it("removeReaction() posts reactions.remove with the returned reactionId", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      await adapter.removeReaction!("C01:1600000003.000001", "thumbsup")
      const call = lastHttpCall()
      expect(call.url).toContain("reactions.remove")
      expect(call.body["channel"]).toBe("C01")
      expect(call.body["timestamp"]).toBe("1600000003.000001")
      expect(call.body["name"]).toBe("thumbsup")
    })
  })

  // -------------------------------------------------------------------------
  // pin capability (pinMessage / unpinMessage)
  // -------------------------------------------------------------------------

  describe("pin capability", () => {
    it("pinMessage() parses the composite id for channel + ts", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      await adapter.pinMessage!("slack:sl-contract:C99", "C01PIN:1600000004.000001")
      const call = lastHttpCall()
      expect(call.url).toContain("pins.add")
      expect(call.body["channel"]).toBe("C01PIN")
      expect(call.body["timestamp"]).toBe("1600000004.000001")
    })

    it("pinMessage() falls back to the conversationKey channel for a bare ts", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      await adapter.pinMessage!("slack:sl-contract:C99", "1600000004.000002")
      const call = lastHttpCall()
      expect(call.body["channel"]).toBe("C99")
      expect(call.body["timestamp"]).toBe("1600000004.000002")
    })

    it("unpinMessage() posts pins.remove from the composite id", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp())
      const adapter = makeAdapter()
      await adapter.unpinMessage!("C01PIN:1600000004.000001")
      const call = lastHttpCall()
      expect(call.url).toContain("pins.remove")
      expect(call.body["channel"]).toBe("C01PIN")
      expect(call.body["timestamp"]).toBe("1600000004.000001")
    })

    it("unpinMessage() throws on a bare-ts id (no channel context)", async () => {
      const adapter = makeAdapter()
      await expect(adapter.unpinMessage!("1600000004.000003")).rejects.toThrow(/"<channelId>:<ts>"/)
    })
  })

  // -------------------------------------------------------------------------
  // history.fetch
  // -------------------------------------------------------------------------

  describe("history.fetch capability", () => {
    it("fetchHistory() calls conversations.history and yields parsed messages", async () => {
      mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd !== "connectors_http_request") return makeSendOkResp()
        const req = (args as { req: { url: string } }).req
        if (req.url.includes("conversations.history")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              ok: true,
              messages: [
                {
                  type: "message",
                  user: "U222",
                  text: "contract history",
                  ts: "1700000002.000003",
                  channel_type: "channel",
                },
              ],
              response_metadata: { next_cursor: "" },
            }),
          }
        }
        return makeSendOkResp()
      })

      const adapter = makeAdapter()
      const events = []
      for await (const evt of adapter.fetchHistory!("slack:sl-contract:C01", { max: 1 })) {
        events.push(evt)
      }
      expect(events).toHaveLength(1)
      expect(events[0].messageId).toBe("1700000002.000003")
      expect(events[0].plainText).toBe("contract history")

      const call = lastHttpCall()
      expect(call.url).toContain("conversations.history")
      expect(call.method).toBe("GET")
      const url = new URL(call.url)
      expect(url.searchParams.get("channel")).toBe("C01")
      expect(url.searchParams.get("limit")).toBe("200")
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
