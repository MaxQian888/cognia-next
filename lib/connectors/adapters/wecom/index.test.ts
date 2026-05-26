import { listen } from "@tauri-apps/api/event"
import { createWeComAdapter } from "./index"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { WeComConversationRef } from "./parse"

// ── mock the generic WS bridge ────────────────────────────────────────────
const mockWsOpen = jest.fn()
const mockWsSend = jest.fn()
const mockWsClose = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: (...a: unknown[]) => mockWsOpen(...a),
  connectorsWsSend: (...a: unknown[]) => mockWsSend(...a),
  connectorsWsClose: (...a: unknown[]) => mockWsClose(...a),
}))

// ── mock the at-gate + bus so no Dexie / real bus is touched ───────────────
const mockGate = jest.fn(async (..._a: unknown[]) => true)
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: (...a: unknown[]) => mockGate(...a),
}))
const mockDispatch = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({ dispatchConnectorCallback: mockDispatch }),
}))

const mockListen = listen as jest.Mock

type Handler = (e: { payload: string }) => void

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

/** Typed emit mock so `emit.mock.calls[0][0]` narrows to the event. */
const makeEmit = () => jest.fn(async (_e: NormalizedInboundEvent) => undefined)

function makeCtx(emit: jest.Mock): AdapterContext {
  return {
    emit: emit as unknown as AdapterContext["emit"],
    tauri: {} as AdapterContext["tauri"],
    secrets: {} as AdapterContext["secrets"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    adapterId: "wc1",
  }
}

function sentFrames(): Array<{ cmd?: string; headers?: { req_id?: string }; body?: unknown }> {
  return mockWsSend.mock.calls.map((c) => JSON.parse(c[1] as string))
}

beforeEach(() => {
  mockListen.mockReset()
  mockWsOpen.mockReset()
  mockWsSend.mockReset()
  mockWsClose.mockReset()
  mockGate.mockClear()
  mockDispatch.mockClear()
  mockGate.mockResolvedValue(true)
  // The WS bridge commands return promises in production.
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
})

/** Start the adapter and complete the subscribe handshake. */
async function startSubscribed(emit: jest.Mock, settings?: Record<string, unknown>) {
  const bus = listenBus()
  mockListen.mockImplementation(bus.impl)
  mockWsOpen.mockResolvedValue("h1")

  const adapter = createWeComAdapter({
    id: "wc1",
    displayName: "WeCom Bot",
    botId: async () => "bot_x",
    secret: async () => "secret_y",
    settings,
    _backoffBaseMs: 1,
  })
  const startP = adapter.start(makeCtx(emit))
  // Wait for the subscribe frame, then ack it.
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
  return { adapter, bus }
}

/** Auto-ack every outbound request frame until `promise` settles. */
async function settleWithAcks<T>(
  bus: ReturnType<typeof listenBus>,
  promise: Promise<T>
): Promise<T> {
  let done = false
  promise.then(
    () => (done = true),
    () => (done = true)
  )
  const acked = new Set<string>()
  for (let i = 0; i < 40 && !done; i++) {
    await tick()
    for (const f of sentFrames()) {
      const rid = f.headers?.req_id
      if (rid && !acked.has(rid)) {
        acked.add(rid)
        bus.trigger(
          "connectors://ws/h1/message",
          JSON.stringify({ headers: { req_id: rid }, errcode: 0 })
        )
      }
    }
  }
  return promise
}

const msgFrame = (reqId: string, content: string, over?: Record<string, unknown>) =>
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
      ...over,
    },
  })

describe("createWeComAdapter — lifecycle", () => {
  it("opens the WS, sends aibot_subscribe, and reports running after the ack", async () => {
    const emit = makeEmit()
    const { adapter } = await startSubscribed(emit)
    expect(mockWsOpen).toHaveBeenCalledWith("wss://openws.work.weixin.qq.com")
    expect(sentFrames().some((f) => f.cmd === "aibot_subscribe")).toBe(true)
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
    expect(mockWsClose).toHaveBeenCalledWith("h1")
    expect(adapter.health().state).toBe("down")
  })

  it("reports degraded when the subscribe ack carries a non-zero errcode", async () => {
    const bus = listenBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")
    const adapter = createWeComAdapter({
      id: "wc1",
      displayName: "b",
      botId: async () => "x",
      secret: async () => "bad",
      _backoffBaseMs: 1,
    })
    const startP = adapter.start(makeCtx(jest.fn()))
    for (let i = 0; i < 30; i++) {
      await tick()
      const sub = sentFrames().find((f) => f.cmd === "aibot_subscribe")
      if (sub) {
        bus.trigger(
          "connectors://ws/h1/message",
          JSON.stringify({
            headers: { req_id: sub.headers!.req_id },
            errcode: 60020,
            errmsg: "bad secret",
          })
        )
        break
      }
    }
    await startP
    expect(adapter.health().state).toBe("degraded")
    expect(adapter.health().reason).toContain("60020")
    await adapter.stop()
  })
})

describe("createWeComAdapter — inbound", () => {
  it("normalises an inbound text message and emits it through the gate", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hello bot"))
    await tick()
    expect(mockGate).toHaveBeenCalled()
    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0][0] as NormalizedInboundEvent
    expect(ev.platform).toBe("wecom")
    expect(ev.plainText).toBe("hello bot")
    expect((ev.conversationRef as WeComConversationRef).reqId).toBe("r-live")
    await adapter.stop()
  })

  it("does not emit when the gate denies", async () => {
    const emit = makeEmit()
    mockGate.mockResolvedValue(false)
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r1", "blocked"))
    await tick()
    expect(emit).not.toHaveBeenCalled()
    await adapter.stop()
  })
})

describe("createWeComAdapter — outbound reply (streaming)", () => {
  it("streamReply pushes a stream frame with finish:false for a live req", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
    await tick()
    const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
    mockWsSend.mockClear()
    await adapter.streamReply!({ conversationRef: ref, text: "partial..." })
    const f = sentFrames().find((x) => x.cmd === "aibot_respond_msg")
    expect(f).toBeTruthy()
    expect(f!.body).toMatchObject({
      msgtype: "stream",
      stream: { content: "partial...", finish: false },
    })
    await adapter.stop()
  })

  it("send finalises the stream with finish:true for a live req", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
    await tick()
    const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
    mockWsSend.mockClear()
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "markdown", md: "**done**" }],
        metadata: { idempotencyKey: "k1" },
      })
    )
    expect(res.ok).toBe(true)
    const f = sentFrames().find((x) => x.cmd === "aibot_respond_msg")
    expect(f!.body).toMatchObject({
      msgtype: "stream",
      stream: { content: "**done**", finish: true },
    })
    await adapter.stop()
  })
})

describe("createWeComAdapter — proactive push", () => {
  it("uses aibot_send_msg when the conversationRef has no live req", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    mockWsSend.mockClear()
    const ref: WeComConversationRef = {
      platform: "wecom",
      adapterId: "wc1",
      chatId: "u_alice",
      chatType: "single",
      // No reqId / not in the live map → proactive.
    }
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "text", text: "scheduled reminder" }],
        metadata: { idempotencyKey: "k2" },
      })
    )
    expect(res.ok).toBe(true)
    const f = sentFrames().find((x) => x.cmd === "aibot_send_msg")
    expect(f!.body).toMatchObject({
      chatid: "u_alice",
      chat_type: 1,
      msgtype: "markdown",
      markdown: { content: "scheduled reminder" },
    })
    await adapter.stop()
  })
})

describe("createWeComAdapter — events", () => {
  it("dispatches a template_card_event callback and acks the card", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    mockWsSend.mockClear()
    bus.trigger(
      "connectors://ws/h1/message",
      JSON.stringify({
        cmd: "aibot_event_callback",
        headers: { req_id: "rc" },
        body: {
          aibotid: "self_bot",
          chatid: "c1",
          from: { userid: "u_alice" },
          msgtype: "event",
          event: {
            eventtype: "template_card_event",
            template_card: { event_key: "a2ui:s1:b1:go" },
          },
        },
      })
    )
    await tick()
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(mockDispatch.mock.calls[0][0]).toMatchObject({
      triggerId: "a2ui:s1:b1:go",
      surfaceId: "s1",
      value: "go",
    })
    // Ack card update frame fired within the handler.
    expect(sentFrames().some((f) => f.cmd === "aibot_respond_update_msg")).toBe(true)
    await adapter.stop()
  })

  it("sends the configured welcome on enter_chat", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit, {
      welcomeMessage: "Hello! How can I help?",
    })
    mockWsSend.mockClear()
    bus.trigger(
      "connectors://ws/h1/message",
      JSON.stringify({
        cmd: "aibot_event_callback",
        headers: { req_id: "rw" },
        body: { aibotid: "self_bot", msgtype: "event", event: { eventtype: "enter_chat" } },
      })
    )
    await tick()
    const f = sentFrames().find((x) => x.cmd === "aibot_respond_welcome_msg")
    expect(f!.body).toMatchObject({ msgtype: "text", text: { content: "Hello! How can I help?" } })
    await adapter.stop()
  })
})
