// Generic adapter contract suite for the Lark adapter — Task 91.
// Exercises every advertised capability flag end-to-end:
// build adapter → mock the Tauri HTTP wrapper → call the adapter method →
// assert the outbound HTTP request shape (URL + payload) matches what Lark expects.

import { invoke } from "@tauri-apps/api/core"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createLarkAdapter } from "./index"

const mockInvoke = invoke as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTatOkResp() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, tenant_access_token: "t-contract-tat", expire: 7200 }),
  }
}

function makeSendOkResp() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, data: { message_id: "om_ok" } }),
  }
}

function makeAdapter() {
  return createLarkAdapter({
    id: "lark-contract",
    displayName: "Contract Test Bot",
    appId: async () => "cli_contract_app",
    appSecret: async () => "contract-secret",
    verificationToken: async () => "contract-vtoken",
    selfBotOpenId: "ou_bot_contract",
    transport: "long-connection",
  })
}

/**
 * Pull the most recent connectors_http_request payload (excluding TAT fetches).
 */
function lastSendCall(): { url: string; method: string; body: Record<string, unknown> } {
  const calls = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === "connectors_http_request")
  // Last call is always the send/edit/delete call
  const last = calls[calls.length - 1]
  const req = (last[1] as { req: { url: string; method: string; body?: string } }).req
  return {
    url: req.url,
    method: req.method,
    body: req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {},
  }
}

describe("Lark adapter contract suite", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    // Default: first call returns TAT, subsequent calls return a generic OK
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") return "handle-id"
      if (cmd === "connectors_ws_send") return undefined
      if (cmd === "connectors_ws_close") return undefined
      // First HTTP call → TAT; subsequent → send OK
      return makeTatOkResp()
    })
  })

  // -------------------------------------------------------------------------
  // send.text
  // -------------------------------------------------------------------------

  describe("send.text capability", () => {
    it("plain text becomes POST /im/v1/messages with msg_type=text", async () => {
      mockInvoke
        .mockResolvedValueOnce(makeTatOkResp()) // TAT fetch
        .mockResolvedValueOnce(makeSendOkResp()) // send

      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "lark",
          adapterId: "lark-contract",
          channelId: "oc_chat_001",
        },
        segments: [{ type: "text", text: "hello world" }],
        metadata: { idempotencyKey: "k1" },
      }

      const result = await adapter.send(req)
      expect(result.ok).toBe(true)

      const call = lastSendCall()
      expect(call.url).toContain("/im/v1/messages")
      expect(call.method).toBe("POST")
      expect(call.body["msg_type"]).toBe("text")

      const content = JSON.parse(call.body["content"] as string) as { text: string }
      expect(content.text).toBe("hello world")
    })
  })

  // -------------------------------------------------------------------------
  // send.markdown
  // -------------------------------------------------------------------------

  describe("send.markdown capability", () => {
    it("markdown segment produces msg_type=interactive with lark_md", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "lark",
          adapterId: "lark-contract",
          channelId: "oc_chat_001",
        },
        segments: [{ type: "markdown", md: "**bold** text" }],
        metadata: { idempotencyKey: "k2" },
      }

      await adapter.send(req)
      const call = lastSendCall()
      expect(call.body["msg_type"]).toBe("interactive")
      const content = JSON.parse(call.body["content"] as string) as {
        elements: Array<{ text: { tag: string; content: string } }>
      }
      expect(content.elements[0].text.tag).toBe("lark_md")
      expect(content.elements[0].text.content).toContain("**bold**")
    })
  })

  // -------------------------------------------------------------------------
  // send.image
  // -------------------------------------------------------------------------

  describe("send.image capability", () => {
    it("image_key produces msg_type=image", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "lark",
          adapterId: "lark-contract",
          channelId: "oc_chat_001",
        },
        segments: [{ type: "image", url: "img_v3_abc123", alt: "photo" }],
        metadata: { idempotencyKey: "k3" },
      }

      await adapter.send(req)
      const call = lastSendCall()
      expect(call.body["msg_type"]).toBe("image")
      const content = JSON.parse(call.body["content"] as string) as { image_key: string }
      expect(content.image_key).toBe("img_v3_abc123")
    })
  })

  // -------------------------------------------------------------------------
  // send.file
  // -------------------------------------------------------------------------

  describe("send.file capability", () => {
    it("file segment produces msg_type=text with file link", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "lark",
          adapterId: "lark-contract",
          channelId: "oc_chat_001",
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
      const call = lastSendCall()
      expect(call.body["msg_type"]).toBe("text")
      const content = JSON.parse(call.body["content"] as string) as { text: string }
      expect(content.text).toContain("report.pdf")
    })
  })

  // -------------------------------------------------------------------------
  // send.reply (thread)
  // -------------------------------------------------------------------------

  describe("send.reply + send.thread capability", () => {
    it("threadTs becomes reply_in_thread=true + parent_id in payload", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "lark",
          adapterId: "lark-contract",
          channelId: "oc_chat_001",
          threadTs: "thr_root_001",
        },
        segments: [{ type: "text", text: "reply in thread" }],
        metadata: { idempotencyKey: "k5" },
      }

      await adapter.send(req)
      const call = lastSendCall()
      expect(call.body["reply_in_thread"]).toBe(true)
      expect(call.body["parent_id"]).toBe("thr_root_001")
    })
  })

  // -------------------------------------------------------------------------
  // send.mention
  // -------------------------------------------------------------------------

  describe("send.mention capability", () => {
    it("mention segment includes open_id in text", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "lark",
          adapterId: "lark-contract",
          channelId: "oc_chat_001",
        },
        segments: [{ type: "mention", userId: "ou_user_abc" }],
        metadata: { idempotencyKey: "k7" },
      }

      await adapter.send(req)
      const call = lastSendCall()
      const content = JSON.parse(call.body["content"] as string) as { text: string }
      expect(content.text).toContain("ou_user_abc")
    })
  })

  // -------------------------------------------------------------------------
  // edit
  // -------------------------------------------------------------------------

  describe("edit capability", () => {
    it("edit() PATCHes /im/v1/messages/<id> with msg_type and content", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter()
      const patch: OutboundRequest = {
        conversationRef: {
          platform: "lark",
          adapterId: "lark-contract",
          channelId: "oc_chat_001",
        },
        segments: [{ type: "text", text: "edited content" }],
        metadata: { idempotencyKey: "k8" },
      }

      const result = await adapter.edit!("om_msg_001", patch)
      expect(result.ok).toBe(true)

      const call = lastSendCall()
      expect(call.url).toContain("om_msg_001")
      expect(call.method).toBe("PATCH")
      expect(call.body["msg_type"]).toBe("text")
    })
  })

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  describe("delete capability", () => {
    it("delete() sends DELETE /im/v1/messages/<id>", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter()
      await adapter.delete!("om_msg_del_001")

      const call = lastSendCall()
      expect(call.url).toContain("om_msg_del_001")
      expect(call.method).toBe("DELETE")
    })
  })

  // -------------------------------------------------------------------------
  // send.reaction (addReaction)
  // -------------------------------------------------------------------------

  describe("send.reaction capability", () => {
    it("addReaction() POSTs to /im/v1/messages/<id>/reactions", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter() as ReturnType<typeof createLarkAdapter> & {
        addReaction: (messageId: string, emojiType: string) => Promise<void>
      }

      await adapter.addReaction("om_msg_react_001", "THUMBSUP")

      const call = lastSendCall()
      expect(call.url).toContain("/reactions")
      expect(call.url).toContain("om_msg_react_001")
      expect(call.method).toBe("POST")
      const rt = call.body["reaction_type"] as { emoji_type: string }
      expect(rt.emoji_type).toBe("THUMBSUP")
    })
  })

  // -------------------------------------------------------------------------
  // send.card
  // -------------------------------------------------------------------------

  describe("send.card / rich-card.lark capability", () => {
    it("card segment produces [card] placeholder text", async () => {
      mockInvoke.mockResolvedValueOnce(makeTatOkResp()).mockResolvedValueOnce(makeSendOkResp())

      const adapter = makeAdapter()
      const req: OutboundRequest = {
        conversationRef: {
          platform: "lark",
          adapterId: "lark-contract",
          channelId: "oc_chat_001",
        },
        segments: [{ type: "card", card: { kind: "block_kit", payload: {} } }],
        metadata: { idempotencyKey: "k11" },
      }

      await adapter.send(req)
      const call = lastSendCall()
      const content = JSON.parse(call.body["content"] as string) as { text: string }
      expect(content.text).toBe("[card]")
    })
  })

  // -------------------------------------------------------------------------
  // setTyping (no-op)
  // -------------------------------------------------------------------------

  describe("setTyping no-op", () => {
    it("setTyping() never calls the Lark API", async () => {
      const adapter = makeAdapter()
      await adapter.setTyping!("lark:lark-contract:oc_chat_001", true)
      await adapter.setTyping!("lark:lark-contract:oc_chat_001", false)

      const httpCalls = mockInvoke.mock.calls.filter(
        ([cmd]: [string]) => cmd === "connectors_http_request"
      )
      expect(httpCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // history.fetch (Phase 1 stub — empty)
  // -------------------------------------------------------------------------

  describe("history.fetch capability", () => {
    it("fetchHistory() returns empty async iterable in Phase 1", async () => {
      const adapter = makeAdapter()
      const events: unknown[] = []
      for await (const evt of adapter.fetchHistory!("lark:lark-contract:oc_chat_001", {})) {
        events.push(evt)
      }
      expect(events).toHaveLength(0)
    })
  })
})
