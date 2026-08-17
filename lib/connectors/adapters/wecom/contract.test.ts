// Adapter contract suite for WeCom (企业微信 智能机器人) — mirrors
// `telegram/contract.test.ts`. One `describe` per declared Capability: build
// adapter → drive the WS bridge mock → call the adapter method → assert the
// outbound FRAME shape matches the aibot protocol. Plus one "intentionally
// absent" case per mutation method the adapter does NOT declare.

import { listen } from "@tauri-apps/api/event"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createWeComAdapter } from "./index"
import { buildWeComTemplateCard } from "./a2ui-mapper"
import type { WeComConversationRef } from "./parse"

const mockWsOpen = jest.fn()
const mockWsSend = jest.fn()
const mockWsClose = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: (...a: unknown[]) => mockWsOpen(...a),
  connectorsWsSend: (...a: unknown[]) => mockWsSend(...a),
  connectorsWsClose: (...a: unknown[]) => mockWsClose(...a),
}))
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: jest.fn(async () => true),
}))
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({ dispatchConnectorCallback: jest.fn(async () => undefined) }),
}))
jest.mock("./a2ui-mapper", () => ({
  ...jest.requireActual("./a2ui-mapper"),
  buildWeComTemplateCard: jest.fn(async () => null),
}))
const mockBuildCard = buildWeComTemplateCard as jest.Mock
const mockListen = listen as jest.Mock

type Handler = (e: { payload: string }) => void
type SentFrame = { cmd?: string; headers?: { req_id?: string }; body?: Record<string, unknown> }

function listenBus() {
  const listeners = new Map<string, Handler[]>()
  const impl = jest.fn(async (topic: string, handler: Handler) => {
    if (!listeners.has(topic)) listeners.set(topic, [])
    listeners.get(topic)!.push(handler)
    return jest.fn()
  })
  const trigger = (topic: string, payload: string) => {
    for (const h of listeners.get(topic) ?? []) h({ payload })
  }
  return { impl, trigger }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function sentFrames(): SentFrame[] {
  return mockWsSend.mock.calls.map((c) => JSON.parse(c[1] as string))
}

function makeCtx(emit: jest.Mock): AdapterContext {
  return {
    emit: emit as unknown as AdapterContext["emit"],
    tauri: {} as AdapterContext["tauri"],
    secrets: {} as AdapterContext["secrets"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    adapterId: "wc-contract",
  }
}

async function startSubscribed(
  emit: jest.Mock = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
) {
  const bus = listenBus()
  mockListen.mockImplementation(bus.impl)
  mockWsOpen.mockResolvedValue("h1")
  const adapter = createWeComAdapter({
    id: "wc-contract",
    displayName: "Contract WeCom",
    botId: async () => "bot_x",
    secret: async () => "secret_y",
    _backoffBaseMs: 1,
  })
  const startP = adapter.start(makeCtx(emit))
  for (let i = 0; i < 30; i++) {
    await tick()
    const sub = sentFrames().find((f) => f.cmd === "aibot_subscribe")
    if (sub) {
      bus.trigger(
        "connectors://ws/h1/message",
        JSON.stringify({ headers: { req_id: sub.headers!.req_id }, errcode: 0, errmsg: "ok" })
      )
      break
    }
  }
  await startP
  mockWsSend.mockClear()
  return { adapter, bus, emit }
}

/** Ack every outbound frame in order until `promise` settles. */
async function settleWithAcks<T>(
  bus: ReturnType<typeof listenBus>,
  promise: Promise<T>,
  responder?: (f: SentFrame) => Record<string, unknown> | null
): Promise<T> {
  let done = false
  promise.then(
    () => (done = true),
    () => (done = true)
  )
  let cursor = 0
  for (let i = 0; i < 40 && !done; i++) {
    await tick()
    const frames = sentFrames()
    for (; cursor < frames.length; cursor++) {
      const f = frames[cursor]
      const rid = f.headers?.req_id
      if (!rid) continue
      const extra = responder ? responder(f) : {}
      if (extra === null) continue
      bus.trigger(
        "connectors://ws/h1/message",
        JSON.stringify({ headers: { req_id: rid }, errcode: 0, ...extra })
      )
    }
  }
  return promise
}

const PROACTIVE_REF: WeComConversationRef = {
  platform: "wecom",
  adapterId: "wc-contract",
  chatId: "u_alice",
  chatType: "single",
}

function req(
  segments: OutboundRequest["segments"],
  ref: OutboundRequest["conversationRef"] = PROACTIVE_REF
): OutboundRequest {
  return { conversationRef: ref, segments, metadata: { idempotencyKey: "k-contract" } }
}

const msgFrame = (reqId: string, content: string) =>
  JSON.stringify({
    cmd: "aibot_msg_callback",
    headers: { req_id: reqId },
    body: {
      msgid: `m-${reqId}`,
      aibotid: "self_bot",
      chatid: "c1",
      chattype: "single",
      from: { userid: "u_alice", name: "Alice" },
      msgtype: "text",
      text: { content },
    },
  })

beforeEach(() => {
  mockListen.mockReset()
  mockWsOpen.mockReset()
  mockWsSend.mockReset()
  mockWsClose.mockReset()
  mockBuildCard.mockReset()
  mockBuildCard.mockResolvedValue(null)
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
})

describe("WeCom adapter contract suite", () => {
  describe("send.text capability", () => {
    it("proactive text becomes an aibot_send_msg markdown frame (chatid + chat_type)", async () => {
      const { adapter, bus } = await startSubscribed()
      const res = await settleWithAcks(bus, adapter.send(req([{ type: "text", text: "hello" }])))
      expect(res.ok).toBe(true)
      const f = sentFrames().find((x) => x.cmd === "aibot_send_msg")
      expect(f!.body).toMatchObject({
        chatid: "u_alice",
        chat_type: 1,
        msgtype: "markdown",
        markdown: { content: "hello" },
      })
      await adapter.stop()
    })
  })

  describe("send.markdown capability + streamReply (live reply)", () => {
    it("streamReply pushes finish:false frames and send() finalises with finish:true on the live req", async () => {
      const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
      const { adapter, bus } = await startSubscribed(emit)
      bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
      await tick()
      const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
      await adapter.streamReply!({ conversationRef: ref, text: "partial" })
      const partial = sentFrames().find((x) => x.cmd === "aibot_respond_msg")
      expect(partial!.body).toMatchObject({
        msgtype: "stream",
        stream: { content: "partial", finish: false },
      })
      const res = await settleWithAcks(
        bus,
        adapter.send(req([{ type: "markdown", md: "**done**" }], ref))
      )
      expect(res.ok).toBe(true)
      const final = sentFrames()
        .filter((x) => x.cmd === "aibot_respond_msg")
        .at(-1)
      expect(final!.body).toMatchObject({
        msgtype: "stream",
        stream: { content: "**done**", finish: true },
      })
      await adapter.stop()
    })
  })

  describe("send.card capability", () => {
    it("a template_card-shaped card segment is pushed natively as msgtype template_card", async () => {
      const { adapter, bus } = await startSubscribed()
      const card = {
        card_type: "text_notice",
        main_title: { title: "Notice" },
        card_action: { type: 1, url: "https://x.dev" },
      }
      const res = await settleWithAcks(
        bus,
        adapter.send(req([{ type: "card", card: { kind: "wecom", payload: card } }]))
      )
      expect(res.ok).toBe(true)
      const f = sentFrames().find((x) => x.cmd === "aibot_send_msg")
      expect(f!.body).toMatchObject({
        chatid: "u_alice",
        msgtype: "template_card",
        template_card: card,
      })
      await adapter.stop()
    })
  })

  describe("send.a2ui capability", () => {
    it("an interactive A2UI surface is mapped to a template_card frame via the mapper", async () => {
      mockBuildCard.mockResolvedValue({
        card_type: "button_interaction",
        main_title: { title: "Pick" },
        button_list: [{ key: "a2ui:s1:b1:go", text: "Go", style: 1 }],
      })
      const { adapter, bus } = await startSubscribed()
      const res = await settleWithAcks(
        bus,
        adapter.send(
          req([
            {
              type: "a2ui",
              surfaceId: "s1",
              content: { components: {}, dataModel: {}, rootId: "root" } as never,
              plainTextMirror: "",
            },
          ])
        )
      )
      expect(res.ok).toBe(true)
      expect(mockBuildCard).toHaveBeenCalledWith(
        "wc-contract",
        expect.anything(),
        expect.anything()
      )
      const f = sentFrames().find((x) => x.cmd === "aibot_send_msg")
      expect(f!.body).toMatchObject({
        msgtype: "template_card",
        template_card: { card_type: "button_interaction" },
      })
      await adapter.stop()
    })
  })

  describe("send.image / send.voice / send.video / send.file capabilities", () => {
    it.each([
      ["image", { type: "image" as const, url: "https://cdn/p.png" }],
      ["voice", { type: "voice" as const, url: "https://cdn/v.amr" }],
      ["video", { type: "video" as const, url: "https://cdn/v.mp4" }],
      ["file", { type: "file" as const, url: "https://cdn/d.pdf", name: "d.pdf" }],
    ])(
      "%s segment goes through upload init/finish and a msgtype-keyed media frame",
      async (kind, seg) => {
        const realFetch = global.fetch
        global.fetch = jest.fn(async () => ({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        })) as unknown as typeof fetch
        try {
          const { adapter, bus } = await startSubscribed()
          const res = await settleWithAcks(
            bus,
            adapter.send(req([seg as OutboundRequest["segments"][number]])),
            (f) => {
              if (f.cmd === "aibot_upload_media_init") return { body: { upload_id: "up1" } }
              if (f.cmd === "aibot_upload_media_finish") return { body: { media_id: "mid-1" } }
              return {}
            }
          )
          expect(res.ok).toBe(true)
          const cmds = sentFrames().map((f) => f.cmd)
          expect(cmds).toEqual(
            expect.arrayContaining([
              "aibot_upload_media_init",
              "aibot_upload_media_finish",
              "aibot_send_msg",
            ])
          )
          const f = sentFrames().find((x) => x.cmd === "aibot_send_msg")
          expect(f!.body).toEqual({
            chatid: "u_alice",
            chat_type: 1,
            msgtype: kind,
            [kind]: { media_id: "mid-1" },
          })
          await adapter.stop()
        } finally {
          global.fetch = realFetch
        }
      }
    )
  })

  describe("edit / delete / typing / send.reaction / history.fetch (intentionally absent)", () => {
    it("declares none of them and implements no method for them (ADR-0036 non-goals)", async () => {
      const { adapter } = await startSubscribed()
      for (const cap of ["edit", "delete", "typing", "send.reaction", "history.fetch"] as const) {
        expect(adapter.meta.capabilities).not.toContain(cap)
      }
      expect(adapter.edit).toBeUndefined()
      expect(adapter.delete).toBeUndefined()
      expect(adapter.setTyping).toBeUndefined()
      expect(adapter.addReaction).toBeUndefined()
      expect(adapter.removeReaction).toBeUndefined()
      expect(adapter.fetchHistory).toBeUndefined()
      expect(adapter.fetchHistoryPage).toBeUndefined()
      await adapter.stop()
    })
  })
})
