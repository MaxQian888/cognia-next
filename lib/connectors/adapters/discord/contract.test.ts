// Generic adapter contract suite for the Discord adapter.
// Exercises every advertised capability flag end-to-end:
// build adapter → mock the Tauri HTTP wrapper → call the adapter method →
// assert the outbound HTTP request shape (URL + payload) matches what Discord expects.

import { invoke } from "@tauri-apps/api/core"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createDiscordAdapter } from "./index"

const mockInvoke = invoke as jest.Mock

function makeSendOkResp(id = "msg-42") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ id }),
  }
}

function makeNoContentResp() {
  return { status: 204, headers: {}, body: "" }
}

function makeAdapter() {
  return createDiscordAdapter({
    id: "dc-contract",
    displayName: "Contract Test Bot",
    botToken: async () => "TOKEN",
    selfId: "bot-id-100",
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

describe("Discord adapter contract suite", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    // Default WS commands
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") return "handle-id"
      if (cmd === "connectors_ws_send") return undefined
      if (cmd === "connectors_ws_close") return undefined
      if (cmd === "connectors_discord_upload") return "upload-msg-id"
      return makeSendOkResp()
    })
  })

  /** Pull the most recent connectors_discord_upload request payload. */
  function lastUploadReq(): {
    channelId: string
    files: Array<{ sourceUrl: string; filename: string }>
  } {
    const calls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_discord_upload"
    )
    expect(calls.length).toBeGreaterThan(0)
    return (calls[calls.length - 1][1] as { req: ReturnType<typeof lastUploadReq> }).req
  }

  describe("send.text capability", () => {
    it("plain text segment becomes POST /channels/:id/messages with content", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t1"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "chan-123",
        },
        segments: [{ type: "text", text: "hello world" }],
        metadata: { idempotencyKey: "k1" },
      }
      const result = await adapter.send(req)
      expect(result.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.url).toContain("/channels/chan-123/messages")
      expect(call.method).toBe("POST")
      expect(call.body).toMatchObject({ content: "hello world" })
    })
  })

  describe("send.markdown capability", () => {
    it("markdown segment passes raw markdown as content", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t2"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "chan-1",
        },
        segments: [{ type: "markdown", md: "**bold** text" }],
        metadata: { idempotencyKey: "k2" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.body["content"]).toBe("**bold** text")
    })
  })

  describe("send.image capability", () => {
    it("image segment is uploaded as a real attachment via connectors_discord_upload", async () => {
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "chan-1",
        },
        segments: [{ type: "image", url: "https://example.com/img.png" }],
        metadata: { idempotencyKey: "k3" },
      }
      const result = await adapter.send(req)
      expect(result.platformMessageId).toBe("upload-msg-id")
      const upload = lastUploadReq()
      expect(upload.channelId).toBe("chan-1")
      expect(upload.files).toEqual([
        { sourceUrl: "https://example.com/img.png", filename: "img.png" },
      ])
    })
  })

  describe("send.reply capability", () => {
    it("OutboundRequest.replyTo becomes message_reference", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t4"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "chan-7",
        },
        segments: [{ type: "text", text: "ok" }],
        replyTo: { messageId: "9999999999999999999" },
        metadata: { idempotencyKey: "k4" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.body["message_reference"]).toMatchObject({
        message_id: "9999999999999999999",
        channel_id: "chan-7",
      })
    })
  })

  describe("send.thread capability", () => {
    it("posting to a thread channel uses thread channel_id in URL", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t5"))
      const adapter = makeAdapter()
      // In Discord, posting to a thread means posting to the thread's channel_id
      const req: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "thread-channel-id",
        },
        segments: [{ type: "text", text: "thread msg" }],
        metadata: { idempotencyKey: "k5" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.url).toContain("/channels/thread-channel-id/messages")
    })
  })

  describe("send.mention capability", () => {
    it("mention segment produces <@userId> content", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t6"))
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "chan-1",
        },
        segments: [{ type: "mention", userId: "111111111111111111" }],
        metadata: { idempotencyKey: "k6" },
      }
      await adapter.send(req)
      const call = lastHttpCall()
      expect(call.body["content"]).toBe("<@111111111111111111>")
    })
  })

  describe("send.file capability", () => {
    it("file segment is uploaded via connectors_discord_upload with its name + mime", async () => {
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "chan-1",
        },
        segments: [
          {
            type: "file",
            url: "https://example.com/file.pdf",
            name: "file.pdf",
            mimeType: "application/pdf",
            sizeBytes: 5000,
          },
        ],
        metadata: { idempotencyKey: "k7" },
      }
      await adapter.send(req)
      const upload = lastUploadReq()
      expect(upload.files).toEqual([
        {
          sourceUrl: "https://example.com/file.pdf",
          filename: "file.pdf",
          contentType: "application/pdf",
        },
      ])
    })
  })

  describe("edit capability", () => {
    it("edit() calls PATCH /channels/:channelId/messages/:messageId", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t8"))
      const adapter = makeAdapter()
      const patch: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "chan-11",
        },
        segments: [{ type: "text", text: "edited content" }],
        metadata: { idempotencyKey: "k8" },
      }
      await adapter.edit!("message-id-777", patch)
      const call = lastHttpCall()
      expect(call.url).toContain("/channels/chan-11/messages/message-id-777")
      expect(call.method).toBe("PATCH")
      expect(call.body).toMatchObject({ content: "edited content" })
    })
  })

  describe("delete capability", () => {
    it("delete() calls DELETE /channels/:channelId/messages/:messageId", async () => {
      mockInvoke.mockResolvedValueOnce(makeSendOkResp("t9"))
      const adapter = makeAdapter()
      // Discord delete format: "channelId:messageId"
      await adapter.delete!("chan-88:msg-88")
      const call = lastHttpCall()
      expect(call.url).toContain("/channels/chan-88/messages/msg-88")
      expect(call.method).toBe("DELETE")
    })
  })

  describe("typing capability", () => {
    it("setTyping(on=true) calls POST /channels/:id/typing", async () => {
      mockInvoke.mockResolvedValueOnce(makeNoContentResp())
      const adapter = makeAdapter()
      await adapter.setTyping!("discord:dc-contract:chan-42", true)
      const call = lastHttpCall()
      expect(call.url).toContain("/channels/chan-42/typing")
      expect(call.method).toBe("POST")
    })

    it("setTyping(on=false) is a no-op", async () => {
      const adapter = makeAdapter()
      await adapter.setTyping!("discord:dc-contract:chan-42", false)
      const httpCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_http_request"
      )
      expect(httpCalls).toHaveLength(0)
    })
  })

  describe("send.text + send.image (multi-segment)", () => {
    it("uploads the image and posts the text in one send", async () => {
      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "discord",
          adapterId: "dc-contract",
          channelId: "chan-1",
        },
        segments: [
          { type: "text", text: "look:" },
          { type: "image", url: "https://example.com/p.png" },
        ],
        metadata: { idempotencyKey: "k10" },
      }
      const result = await adapter.send(req)
      expect(result.ok).toBe(true)
      // Text → one JSON POST; image → one multipart upload.
      const httpCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_http_request"
      )
      const uploadCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_discord_upload"
      )
      expect(httpCalls).toHaveLength(1)
      expect(httpCalls[0][1]).toMatchObject({ req: { body: expect.stringContaining("look:") } })
      expect(uploadCalls).toHaveLength(1)
    })
  })
})
