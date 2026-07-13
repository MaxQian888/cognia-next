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
import { getAdapterInstance } from "@/lib/db/adapter-instances"

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  updateAdapterInstance: jest.fn(),
}))

const mockListen = listen as jest.Mock
const mockEmit = emit as jest.Mock
const mockGetAdapterInstance = getAdapterInstance as jest.Mock

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
  mockGetAdapterInstance.mockReset()
  // Default: unknown adapter row → undefined (mirrors a Dexie miss). The
  // inbound at-gate (`at-gate.ts`) calls `getAdapterInstance(id).catch(...)`
  // on every event, so the mock must always return a Promise. Reaction tests
  // override this with a row carrying `implMetadata.features`.
  mockGetAdapterInstance.mockResolvedValue(undefined)
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
      expect(adapter.meta.transportModes).toContain("forward-ws")
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
      // v11 types user_id as number — numeric chatKey ids are converted.
      expect((payload.params as Record<string, unknown>).user_id).toBe(200001)

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
  // send.reaction — NapCat set_msg_emoji_like (runtime feature-gated)
  // ---------------------------------------------------------------------------

  describe("send.reaction capability", () => {
    it("addReaction emits set_msg_emoji_like (set:true) and returns a ReactionRef", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      mockGetAdapterInstance.mockResolvedValue({
        implMetadata: { impl: "napcat", version: "4.x", features: ["set_msg_emoji_like"] },
      })

      const { adapter } = await setupAdapter(bus, "ob-react")

      const ref = await adapter.addReaction!("12345", "128077")

      // ReactionRef contract (types/connectors/adapter.ts): the returned
      // reactionId feeds removeReaction.
      expect(ref).toEqual({ reactionId: "128077" })

      const sendCall = mockEmit.mock.calls.find((c) => (c[0] as string).endsWith("/send"))
      expect(sendCall).toBeDefined()
      const payload = JSON.parse(sendCall![1] as string) as Record<string, unknown>
      expect(payload.action).toBe("set_msg_emoji_like")
      const params = payload.params as Record<string, unknown>
      expect(params.message_id).toBe(12345)
      expect(params.emoji_id).toBe("128077")
      expect(params.set).toBe(true)

      await adapter.stop()
    })

    it("removeReaction emits set_msg_emoji_like with set:false", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      mockGetAdapterInstance.mockResolvedValue({
        implMetadata: { impl: "llonebot", version: "3.x", features: ["set_msg_emoji_like"] },
      })

      const { adapter } = await setupAdapter(bus, "ob-react-rm")

      await adapter.removeReaction!("12345", "128077")

      const sendCall = mockEmit.mock.calls.find((c) => (c[0] as string).endsWith("/send"))
      expect(sendCall).toBeDefined()
      const payload = JSON.parse(sendCall![1] as string) as Record<string, unknown>
      expect(payload.action).toBe("set_msg_emoji_like")
      const params = payload.params as Record<string, unknown>
      expect(params.message_id).toBe(12345)
      expect(params.emoji_id).toBe("128077")
      expect(params.set).toBe(false)

      await adapter.stop()
    })

    it("addReaction and removeReaction throw (no emit) when the upstream lacks set_msg_emoji_like", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      mockGetAdapterInstance.mockResolvedValue({
        implMetadata: { impl: "lagrange", version: "0.x", features: [] },
      })

      const { adapter } = await setupAdapter(bus, "ob-react-no")

      await expect(adapter.addReaction!("1", "76")).rejects.toThrow(/set_msg_emoji_like/)
      await expect(adapter.removeReaction!("1", "76")).rejects.toThrow(/set_msg_emoji_like/)

      const sendCalls = mockEmit.mock.calls.filter((c) => (c[0] as string).endsWith("/send"))
      expect(sendCalls).toHaveLength(0)

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
  // history.fetch — v11 get_group_msg_history / get_friend_msg_history
  // ---------------------------------------------------------------------------

  describe("history.fetch capability", () => {
    it("fetchHistory is exposed on the adapter", () => {
      const adapter = createOneBotAdapter({ id: "ob-hist-decl", displayName: "H", selfBotUin: "1" })
      expect(adapter.fetchHistory).toBeDefined()
    })

    it("walks group history with message_seq cursor pagination", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      const { adapter } = await setupAdapter(bus, "ob-hist-g")

      // Each emit returns a 2-message page; second emit returns empty to stop.
      let call = 0
      mockEmit.mockImplementation(async (_topic: string, payload: string) => {
        const c = JSON.parse(payload) as {
          echo: string
          action: string
          params: { message_seq?: number }
        }
        expect(c.action).toBe("get_group_msg_history")
        call++
        const messages =
          call === 1
            ? [
                {
                  time: 1700000100,
                  self_id: 100000,
                  post_type: "message",
                  message_type: "group",
                  message_id: 11,
                  message_seq: 11,
                  group_id: 300001,
                  user_id: 200001,
                  sender: { user_id: 200001, nickname: "Alice" },
                  message: [{ type: "text", data: { text: "older-1" } }],
                },
                {
                  time: 1700000200,
                  self_id: 100000,
                  post_type: "message",
                  message_type: "group",
                  message_id: 12,
                  message_seq: 12,
                  group_id: 300001,
                  user_id: 200001,
                  sender: { user_id: 200001, nickname: "Alice" },
                  message: [{ type: "text", data: { text: "older-2" } }],
                },
              ]
            : []
        setTimeout(() => {
          bus.trigger(
            `connectors://onebot/ob-hist-g/response`,
            JSON.stringify({ status: "ok", retcode: 0, data: { messages }, echo: c.echo })
          )
        }, 0)
      })

      const collected: string[] = []
      for await (const ev of adapter.fetchHistory!(`onebot:ob-hist-g:g:300001`, {})) {
        collected.push(ev.plainText)
      }

      expect(collected).toEqual(["older-1", "older-2"])
      expect(call).toBe(2) // first page yields, second page empties → stops

      await adapter.stop()
    })

    it("walks friend history when conversationKey is p:<userId>", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      const { adapter } = await setupAdapter(bus, "ob-hist-p")

      const actions: string[] = []
      mockEmit.mockImplementation(async (_topic: string, payload: string) => {
        const c = JSON.parse(payload) as { echo: string; action: string }
        actions.push(c.action)
        setTimeout(() => {
          bus.trigger(
            `connectors://onebot/ob-hist-p/response`,
            JSON.stringify({ status: "ok", retcode: 0, data: { messages: [] }, echo: c.echo })
          )
        }, 0)
      })

      const events: unknown[] = []
      for await (const ev of adapter.fetchHistory!(`onebot:ob-hist-p:p:200001`, {})) {
        events.push(ev)
      }

      expect(actions).toEqual(["get_friend_msg_history"])
      expect(events).toHaveLength(0)

      await adapter.stop()
    })

    it("respects opts.max as a yield cap", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      const { adapter } = await setupAdapter(bus, "ob-hist-cap")

      mockEmit.mockImplementation(async (_topic: string, payload: string) => {
        const c = JSON.parse(payload) as { echo: string }
        setTimeout(() => {
          bus.trigger(
            `connectors://onebot/ob-hist-cap/response`,
            JSON.stringify({
              status: "ok",
              retcode: 0,
              data: {
                messages: [
                  {
                    time: 1700001000,
                    self_id: 100000,
                    post_type: "message",
                    message_type: "group",
                    message_id: 21,
                    message_seq: 21,
                    group_id: 300002,
                    user_id: 200002,
                    sender: { user_id: 200002, nickname: "Bob" },
                    message: [{ type: "text", data: { text: "m1" } }],
                  },
                  {
                    time: 1700001100,
                    self_id: 100000,
                    post_type: "message",
                    message_type: "group",
                    message_id: 22,
                    message_seq: 22,
                    group_id: 300002,
                    user_id: 200002,
                    sender: { user_id: 200002, nickname: "Bob" },
                    message: [{ type: "text", data: { text: "m2" } }],
                  },
                ],
              },
              echo: c.echo,
            })
          )
        }, 0)
      })

      const collected: string[] = []
      for await (const ev of adapter.fetchHistory!(`onebot:ob-hist-cap:g:300002`, { max: 1 })) {
        collected.push(ev.plainText)
      }
      expect(collected).toEqual(["m1"])

      await adapter.stop()
    })

    it("rejects v12 conversations (no portable history action)", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)

      const adapter = createOneBotAdapter({
        id: "ob-hist-v12",
        displayName: "V12",
        selfBotUin: "100000",
      })
      const { ctx } = makeCtx()
      await adapter.start(ctx)

      // Seed v12 variant cache
      const seedV12 = {
        time: 1700000000,
        type: "message",
        detail_type: "group",
        self: { platform: "qq", user_id: "100000" },
        id: "evt-1",
        message_id: "m-1",
        user_id: "200003",
        group_id: "300003",
        message: [{ type: "text", data: { text: "v12 seed" } }],
      }
      bus.trigger(`connectors://onebot/ob-hist-v12/event`, JSON.stringify(seedV12))
      await new Promise((r) => setTimeout(r, 20))

      const iter = adapter.fetchHistory!(`onebot:ob-hist-v12:g:300003`, {})
      // Generator throws on first .next()
      await expect(
        (async () => {
          for await (const _ of iter) void _
        })()
      ).rejects.toThrow(/v12 does not define a portable message-history/)

      await adapter.stop()
    })

    it("rejects conversationKey without chatType:chatId encoding", async () => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      const { adapter } = await setupAdapter(bus, "ob-hist-bad")

      const iter = adapter.fetchHistory!(`onebot:ob-hist-bad:malformed`, {})
      await expect(
        (async () => {
          for await (const _ of iter) void _
        })()
      ).rejects.toThrow(/must encode chatType:chatId/)

      await adapter.stop()
    })
  })
})
