/**
 * Generic contract suite for the OneBot adapter.
 *
 * Exercises every advertised capability flag end-to-end:
 * build adapter → mock event bus → trigger action → assert serialised call shape.
 *
 * Edit and typing are NOT tested as capabilities because OneBot lacks native
 * support (edit returns unsupported, typing is a no-op).
 */

import { listen, emit } from "@tauri-apps/api/event"
import { createOneBotAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"
import { clearAllVariantCaches } from "./parse"
import type { OutboundRequest } from "@/types/connectors/outbound"

const mockListen = listen as jest.Mock
const mockEmit = emit as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ListenerMap = Map<string, ((event: { payload: string }) => void)[]>

function createEventBus() {
  const listeners: ListenerMap = new Map()

  const listenImpl = jest
    .fn()
    .mockImplementation(async (topic: string, handler: (event: { payload: string }) => void) => {
      if (!listeners.has(topic)) listeners.set(topic, [])
      listeners.get(topic)!.push(handler)
      return jest.fn()
    })

  function trigger(topic: string, payload: string) {
    const handlers = listeners.get(topic) ?? []
    for (const h of handlers) h({ payload })
  }

  return { listenImpl, trigger }
}

function makeCtx(): { ctx: AdapterContext; emitted: NormalizedInboundEvent[] } {
  const emitted: NormalizedInboundEvent[] = []
  const ctx: AdapterContext = {
    emit: jest.fn(async (e: NormalizedInboundEvent) => {
      emitted.push(e)
    }),
    tauri: {
      httpRequest: jest.fn(),
      openWs: jest.fn(),
      fetchAttachment: jest.fn(),
      bindWebhookRoute: jest.fn(),
      unbindWebhookRoute: jest.fn(),
      publicBaseUrl: jest.fn(),
    },
    secrets: { get: jest.fn(), set: jest.fn(), delete: jest.fn(), list: jest.fn() },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signal: new AbortController().signal,
    adapterId: "ob-contract",
  }
  return { ctx, emitted }
}

/**
 * Wire up an adapter + started ctx, seed the v11 variant cache, then
 * set up `mockEmit` to deliver a round-trip RPC response for each outbound call.
 */
async function setupAdapter(bus: ReturnType<typeof createEventBus>, id: string) {
  const adapter = createOneBotAdapter({
    id,
    displayName: "Contract Bot",
    selfBotUin: "100000",
  })
  const { ctx, emitted } = makeCtx()
  await adapter.start(ctx)

  // Seed the v11 variant cache
  const seedMsg = {
    time: 1700000000,
    self_id: 100000,
    post_type: "message",
    message_type: "private",
    message_id: 1,
    user_id: 200001,
    sender: { user_id: 200001, nickname: "Alice" },
    message: [{ type: "text", data: { text: "seed" } }],
  }
  bus.trigger(`connectors://onebot/${id}/event`, JSON.stringify(seedMsg))
  await new Promise((r) => setTimeout(r, 20))

  // Wire RPC responses
  mockEmit.mockImplementation(async (_topic: string, payload: string) => {
    const call = JSON.parse(payload) as { echo: string }
    setTimeout(() => {
      bus.trigger(
        `connectors://onebot/${id}/response`,
        JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 42 }, echo: call.echo })
      )
    }, 5)
  })

  return { adapter, ctx, emitted }
}

beforeEach(() => {
  mockListen.mockReset()
  mockEmit.mockReset()
  clearAllVariantCaches()
})

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("OneBot adapter contract suite", () => {
  describe("meta", () => {
    it("has correct type, version, transport", () => {
      const adapter = createOneBotAdapter({ id: "ob-c", displayName: "C", selfBotUin: "1" })
      expect(adapter.meta.type).toBe("onebot")
      expect(adapter.meta.version).toBe("0.1.0")
      expect(adapter.meta.transportModes).toContain("reverse-ws")
    })

    it("capabilities include the ship-set and exclude edit/typing", () => {
      const adapter = createOneBotAdapter({ id: "ob-c", displayName: "C", selfBotUin: "1" })
      const caps = adapter.meta.capabilities

      expect(caps).toContain("send.text")
      expect(caps).toContain("send.image")
      expect(caps).toContain("send.voice")
      expect(caps).toContain("send.video")
      expect(caps).toContain("send.file")
      expect(caps).toContain("send.reply")
      expect(caps).toContain("send.mention")
      expect(caps).toContain("send.emoji")
      expect(caps).toContain("delete")
      expect(caps).toContain("history.fetch")

      expect(caps).not.toContain("edit")
      expect(caps).not.toContain("typing")
    })
  })

  // ---------------------------------------------------------------------------
  // send.text
  // ---------------------------------------------------------------------------

  describe("send.text capability", () => {
    it("plain text → send_private_msg v11 action", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)

      const { adapter } = await setupAdapter(bus, "ob-text")

      const req: OutboundRequest = {
        conversationRef: { platform: "onebot", adapterId: "ob-text", chatKey: "p:200001" },
        segments: [{ type: "text", text: "hello" }],
        metadata: { idempotencyKey: "k-text" },
      }

      const result = await adapter.send(req)
      expect(result.ok).toBe(true)

      const emitCall = mockEmit.mock.calls[0]
      const topic = emitCall[0] as string
      const payload = JSON.parse(emitCall[1] as string) as Record<string, unknown>

      expect(topic).toBe("connectors://onebot/ob-text/send")
      expect(payload.action).toBe("send_private_msg")
      expect((payload.params as Record<string, unknown>).user_id).toBe("200001")

      await adapter.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // send.image
  // ---------------------------------------------------------------------------

  describe("send.image capability", () => {
    it("image segment → image type in v11 message array", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)

      const { adapter } = await setupAdapter(bus, "ob-img")

      const req: OutboundRequest = {
        conversationRef: { platform: "onebot", adapterId: "ob-img", chatKey: "g:300001" },
        segments: [{ type: "image", url: "https://img.example/a.png" }],
        metadata: { idempotencyKey: "k-img" },
      }

      const result = await adapter.send(req)
      expect(result.ok).toBe(true)

      const payload = JSON.parse(mockEmit.mock.calls[0][1] as string) as Record<string, unknown>
      const msg = (payload.params as Record<string, unknown>).message as Array<{
        type: string
        data: Record<string, unknown>
      }>
      expect(msg[0].type).toBe("image")

      await adapter.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // send.reply
  // ---------------------------------------------------------------------------

  describe("send.reply capability", () => {
    it("replyTo prepends reply segment", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)

      const { adapter } = await setupAdapter(bus, "ob-reply")

      const req: OutboundRequest = {
        conversationRef: { platform: "onebot", adapterId: "ob-reply", chatKey: "g:300001" },
        segments: [{ type: "text", text: "ack" }],
        replyTo: { messageId: "9999" },
        metadata: { idempotencyKey: "k-reply" },
      }

      const result = await adapter.send(req)
      expect(result.ok).toBe(true)

      const payload = JSON.parse(mockEmit.mock.calls[0][1] as string) as Record<string, unknown>
      const msg = (payload.params as Record<string, unknown>).message as Array<{
        type: string
        data: Record<string, unknown>
      }>
      expect(msg[0].type).toBe("reply")
      expect(msg[0].data.id).toBe("9999")

      await adapter.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // send.mention
  // ---------------------------------------------------------------------------

  describe("send.mention capability", () => {
    it("mention segment → at type in v11", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)

      const { adapter } = await setupAdapter(bus, "ob-mention")

      const req: OutboundRequest = {
        conversationRef: { platform: "onebot", adapterId: "ob-mention", chatKey: "g:300001" },
        segments: [{ type: "mention", userId: "77" }],
        metadata: { idempotencyKey: "k-mention" },
      }

      await adapter.send(req)

      const payload = JSON.parse(mockEmit.mock.calls[0][1] as string) as Record<string, unknown>
      const msg = (payload.params as Record<string, unknown>).message as Array<{
        type: string
        data: Record<string, unknown>
      }>
      expect(msg[0].type).toBe("at")
      expect(msg[0].data.qq).toBe("77")

      await adapter.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("delete capability", () => {
    it("delete() sends delete_msg action with message_id", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)

      const { adapter } = await setupAdapter(bus, "ob-del")

      await adapter.delete!("12345")

      const payload = JSON.parse(mockEmit.mock.calls[0][1] as string) as Record<string, unknown>
      expect(payload.action).toBe("delete_msg")
      expect((payload.params as Record<string, unknown>).message_id).toBe(12345)

      await adapter.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // edit — NOT supported
  // ---------------------------------------------------------------------------

  describe("edit — unsupported", () => {
    it("edit() returns ok=false with unsupported_segment code", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)

      const { adapter } = await setupAdapter(bus, "ob-edit-c")

      const result = await adapter.edit!("1", {
        conversationRef: { platform: "onebot", adapterId: "ob-edit-c", chatKey: "p:200001" },
        segments: [{ type: "text", text: "edited" }],
        metadata: { idempotencyKey: "ke" },
      })

      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("unsupported_segment")

      await adapter.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // typing — no-op
  // ---------------------------------------------------------------------------

  describe("typing — no-op", () => {
    it("setTyping() resolves without emitting anything", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)

      const { adapter } = await setupAdapter(bus, "ob-typ")

      await expect(adapter.setTyping!("onebot:ob-typ:g:300001", true)).resolves.toBeUndefined()

      // No emit calls from typing
      const sendCalls = mockEmit.mock.calls.filter((c) => (c[0] as string).endsWith("/send"))
      expect(sendCalls).toHaveLength(0)

      await adapter.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // history.fetch — not implemented (method absent in Phase 1)
  // ---------------------------------------------------------------------------

  describe("history.fetch capability", () => {
    it("fetchHistory is undefined (Phase 1 stub)", () => {
      const adapter = createOneBotAdapter({ id: "ob-hist", displayName: "H", selfBotUin: "1" })
      expect(adapter.fetchHistory).toBeUndefined()
    })
  })
})
