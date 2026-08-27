import { listen } from "@tauri-apps/api/event"
import { createWeComAdapter, type WeComAdapterOptions } from "./index"
import { buildWeComTemplateCard } from "./a2ui-mapper"
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

// ── observe the live-connection registration ───────────────────────────────
// It is the one `await` that used to sit between `healthState = "running"` and
// the backoff reset, so it is the only place a test can act from inside that
// window. The real implementation still runs.
const onLiveRegister = { current: null as null | (() => void) }
jest.mock("./live-connection", () => ({
  ...jest.requireActual("./live-connection"),
  registerWeComLiveConnection: (...a: unknown[]) => {
    onLiveRegister.current?.()
    return (
      jest.requireActual("./live-connection") as typeof import("./live-connection")
    ).registerWeComLiveConnection(
      a[0] as Parameters<typeof import("./live-connection").registerWeComLiveConnection>[0]
    )
  },
}))

// ── mock the A2UI card builder (its binding writes hit Dexie) ──────────────
jest.mock("./a2ui-mapper", () => ({
  ...jest.requireActual("./a2ui-mapper"),
  buildWeComTemplateCard: jest.fn(async () => null),
}))
const mockBuildCard = buildWeComTemplateCard as jest.Mock

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

/**
 * Set by the heartbeat block, which is the only place here that fakes the clock.
 */
let fakeClock = false

/**
 * Yield long enough for the adapter's promise chain AND any due timer.
 *
 * On the real clock this must stay a `setTimeout` macrotask: several tests poll
 * `tick()` while waiting on a `delay(_backoffBaseMs)` reconnect, and only a
 * timer callback is guaranteed to run after the timer phase has advanced.
 * Swapping it for `setImmediate` — which runs in the check phase — let 200
 * ticks spin without the 1 ms backoff ever firing, and failed
 * "resets the backoff counter after a successful subscribe" in one contended
 * run out of two.
 *
 * Under fake timers there is no real clock to wait on, so advance the fake one
 * by nothing and let its microtask flush do the same job.
 */
const tick = (): Promise<unknown> =>
  fakeClock ? jest.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Typed emit mock so `emit.mock.calls[0][0]` narrows to the event. */
const makeEmit = () => jest.fn(async (_e: NormalizedInboundEvent) => undefined)

function makeCtx(emit: jest.Mock, signal?: AbortSignal): AdapterContext {
  return {
    emit: emit as unknown as AdapterContext["emit"],
    tauri: {} as AdapterContext["tauri"],
    secrets: {} as AdapterContext["secrets"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: signal ?? new AbortController().signal,
    adapterId: "wc1",
  }
}

type SentFrame = { cmd?: string; headers?: { req_id?: string }; body?: Record<string, unknown> }

function sentFrames(): SentFrame[] {
  return mockWsSend.mock.calls.map((c) => JSON.parse(c[1] as string))
}

/**
 * Per-FRAME ack pump — the real server acks every frame, including repeats of
 * the same req_id (fire-and-forget stream/card-update frames share the req_id
 * of later awaited requests). `responder` may override the ack payload per
 * frame; returning `null` skips acking that frame.
 */
function makeAcker(
  bus: ReturnType<typeof listenBus>,
  responder?: (f: SentFrame) => Record<string, unknown> | null
) {
  let cursor = 0
  return () => {
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
}

beforeEach(() => {
  mockListen.mockReset()
  mockWsOpen.mockReset()
  mockWsSend.mockReset()
  mockWsClose.mockReset()
  mockGate.mockClear()
  mockDispatch.mockClear()
  mockBuildCard.mockReset()
  mockBuildCard.mockResolvedValue(null)
  mockGate.mockResolvedValue(true)
  // The WS bridge commands return promises in production.
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
})

/** Start the adapter and complete the subscribe handshake. */
async function startSubscribed(
  emit: jest.Mock,
  settings?: Record<string, unknown>,
  extra?: { signal?: AbortSignal; adapter?: Partial<WeComAdapterOptions> }
) {
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
    ...extra?.adapter,
  })
  const startP = adapter.start(makeCtx(emit, extra?.signal))
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

/** Auto-ack every outbound frame (per frame, in order) until `promise` settles. */
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
  const ack = makeAcker(bus, responder)
  for (let i = 0; i < 40 && !done; i++) {
    await tick()
    ack()
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

const cardEventFrame = (reqId: string, eventKey: string, chatid = "c1") =>
  JSON.stringify({
    cmd: "aibot_event_callback",
    headers: { req_id: reqId },
    body: {
      aibotid: "self_bot",
      chatid,
      chattype: "single",
      from: { userid: "u_alice" },
      msgtype: "event",
      event: {
        eventtype: "template_card_event",
        template_card: { event_key: eventKey },
      },
    },
  })

const SAMPLE_CARD = {
  card_type: "button_interaction",
  main_title: { title: "Pick" },
  button_list: [{ key: "a2ui:s1:b1:go", text: "Go", style: 1 }],
}

const a2uiSegment = {
  type: "a2ui" as const,
  surfaceId: "s1",
  content: { components: {}, dataModel: {}, rootId: "root" },
  plainTextMirror: "",
}

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

  it("reports degraded AND closes the WS handle when the subscribe ack fails", async () => {
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
    // The failed handshake must not leak the Rust-side socket — WeCom allows
    // exactly ONE connection per bot; a leaked handle fights the next dial.
    expect(mockWsClose).toHaveBeenCalledWith("h1")
    await adapter.stop()
  })

  it("does not reset the backoff counter on socket-open — only after subscribe succeeds", async () => {
    const bus = listenBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")
    const attempts: number[] = []
    const adapter = createWeComAdapter({
      id: "wc1",
      displayName: "b",
      botId: async () => "x",
      secret: async () => "bad",
      _backoffBaseMs: 1,
      _onReconnectAttempt: (n) => attempts.push(n),
    })
    void adapter.start(makeCtx(jest.fn()))
    // Reject every subscribe attempt; the attempt counter must keep growing
    // (before the fix it snapped back to 0 on every socket open).
    const ack = makeAcker(bus, (f) =>
      f.cmd === "aibot_subscribe" ? { errcode: 60020, errmsg: "bad secret" } : null
    )
    for (let i = 0; i < 400 && attempts.length < 3; i++) {
      await tick()
      ack()
    }
    await adapter.stop()
    expect(attempts.slice(0, 3)).toEqual([1, 2, 3])
  })

  it("resets the backoff counter after a successful subscribe", async () => {
    const attempts: number[] = []
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit, undefined, {
      adapter: { _onReconnectAttempt: (n) => attempts.push(n) },
    })
    const ack = makeAcker(bus, (f) => (f.cmd === "aibot_subscribe" ? {} : null))
    // First drop → attempt 1 → resubscribe ok.
    bus.trigger("connectors://ws/h1/close", "")
    for (let i = 0; i < 200 && adapter.health().state !== "running"; i++) {
      await tick()
      ack()
    }
    expect(adapter.health().state).toBe("running")
    // Second drop → the attempt counter starts at 1 again (it was reset).
    bus.trigger("connectors://ws/h1/close", "")
    for (let i = 0; i < 200 && attempts.length < 2; i++) {
      await tick()
      ack()
    }
    await adapter.stop()
    expect(attempts.slice(0, 2)).toEqual([1, 1])
  })

  it("has already reset the backoff by the time health reads running", async () => {
    // The reset used to live in `connectOnce`, one `await` past the line that
    // flips health — so a drop landing in between counted as a SECOND
    // consecutive failure and backed off accordingly. Dropping the socket from
    // inside `registerWeComLiveConnection` is exactly that window; the attempt
    // it reports must still be 1.
    const attempts: number[] = []
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit, undefined, {
      adapter: { _onReconnectAttempt: (n) => attempts.push(n) },
    })
    const ack = makeAcker(bus, (f) => (f.cmd === "aibot_subscribe" ? {} : null))

    // First drop, reconnect, and close again from inside the window.
    onLiveRegister.current = () => {
      onLiveRegister.current = null
      expect(adapter.health().state).toBe("running")
      bus.trigger("connectors://ws/h1/close", "")
    }
    bus.trigger("connectors://ws/h1/close", "")
    for (let i = 0; i < 200 && attempts.length < 2; i++) {
      await tick()
      ack()
    }
    await adapter.stop()
    expect(attempts.slice(0, 2)).toEqual([1, 1])
  })

  it("aborting ctx.signal stops the adapter and closes the handle", async () => {
    const controller = new AbortController()
    const emit = makeEmit()
    const { adapter } = await startSubscribed(emit, undefined, { signal: controller.signal })
    expect(adapter.health().state).toBe("running")
    controller.abort()
    for (let i = 0; i < 20 && adapter.health().state !== "down"; i++) await tick()
    expect(adapter.health().state).toBe("down")
    expect(mockWsClose).toHaveBeenCalledWith("h1")
  })
})

describe("createWeComAdapter — heartbeat", () => {
  // The only two assertions in this file that are about a WALL-CLOCK window:
  // "the ack arrived inside `_pingTimeoutMs`" and "two pings expired in a row".
  // On real timers that makes them a bet on the scheduler — under a loaded
  // 16-worker run a `setTimeout(5)` lands well past 30 ms, the adapter
  // correctly declares the socket half-dead, and a test asserting "no close
  // happened" goes red on code that did exactly the right thing. Faking the
  // clock here means the window can only be crossed when this test crosses it.
  beforeEach(() => {
    jest.useFakeTimers()
    fakeClock = true
  })
  afterEach(() => {
    fakeClock = false
    jest.useRealTimers()
  })

  it("stays running while pings are acked", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit, undefined, {
      adapter: { _pingIntervalMs: 10, _pingTimeoutMs: 30 },
    })
    const ack = makeAcker(bus)
    // Six intervals, each acked well inside its own timeout. The ack has to do
    // real work for this to pass: drop it and the third interval is a second
    // consecutive miss, which closes the socket.
    for (let i = 0; i < 6; i++) {
      await jest.advanceTimersByTimeAsync(10)
      ack()
      await tick()
    }
    expect(sentFrames().filter((f) => f.cmd === "ping").length).toBeGreaterThanOrEqual(6)
    expect(mockWsClose).not.toHaveBeenCalled()
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("force-closes and reconnects after 2 missed ping acks (half-dead socket)", async () => {
    const emit = makeEmit()
    const { adapter } = await startSubscribed(emit, undefined, {
      adapter: { _pingIntervalMs: 15, _pingTimeoutMs: 5 },
    })
    // Never ack pings → each expires 5 ms after it is sent → 2 misses in a row
    // degrade, close and reconnect. One advance replaces a second of polling.
    await jest.advanceTimersByTimeAsync(100)
    expect(mockWsClose).toHaveBeenCalledWith("h1")
    expect(adapter.health().reason).toBe("heartbeat lost")
    // The reconnect loop kicked in (a fresh socket dial happened).
    await jest.advanceTimersByTimeAsync(100)
    expect(mockWsOpen.mock.calls.length).toBeGreaterThan(1)
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
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "markdown", md: "**done**" }],
        metadata: { idempotencyKey: "k1" },
      })
    )
    expect(res.ok).toBe(true)
    const f = sentFrames().find(
      (x) => x.cmd === "aibot_respond_msg" && (x.body as { msgtype?: string })?.msgtype === "stream"
    )
    expect(f!.body).toMatchObject({
      msgtype: "stream",
      stream: { content: "**done**", finish: true },
    })
    await adapter.stop()
  })

  it("a late ack for an earlier stream frame cannot resolve send()'s request (req_id aliasing)", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
    await tick()
    const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
    // Stream frame goes out fire-and-forget — its ack has NOT arrived yet.
    await adapter.streamReply!({ conversationRef: ref, text: "partial..." })
    const sendP = adapter.send({
      conversationRef: ref,
      segments: [{ type: "markdown", md: "final" }],
      metadata: { idempotencyKey: "k-alias" },
    })
    // Wait for the finish frame to be registered as pending.
    for (let i = 0; i < 20; i++) {
      await tick()
      if (sentFrames().filter((f) => f.cmd === "aibot_respond_msg").length >= 2) break
    }
    // The LATE ack for the stream frame arrives first — with a failure code.
    // It must be swallowed (owed ack), not resolve the pending finish request.
    bus.trigger(
      "connectors://ws/h1/message",
      JSON.stringify({ headers: { req_id: "r-live" }, errcode: 700, errmsg: "stream rejected" })
    )
    // Then the real ack for the finish frame.
    bus.trigger(
      "connectors://ws/h1/message",
      JSON.stringify({ headers: { req_id: "r-live" }, errcode: 0 })
    )
    const res = await sendP
    expect(res.ok).toBe(true)
    await adapter.stop()
  })

  it("closes an open stream with finish:true when the final reply has no text", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
    await tick()
    const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
    await adapter.streamReply!({ conversationRef: ref, text: "thinking..." })
    // Server acks the preview frame (consumes its owed ack), then we clear
    // the frame log so the acker's cursor realigns.
    bus.trigger(
      "connectors://ws/h1/message",
      JSON.stringify({ headers: { req_id: "r-live" }, errcode: 0 })
    )
    mockWsSend.mockClear()
    // Empty final (nothing serializable) — the stream must still be closed
    // so the platform preview doesn't hang in "generating".
    const res = await settleWithAcks(
      bus,
      adapter.send({ conversationRef: ref, segments: [], metadata: { idempotencyKey: "k2" } })
    )
    const finish = sentFrames().find(
      (f) =>
        f.cmd === "aibot_respond_msg" &&
        (f.body as { stream?: { finish?: boolean } })?.stream?.finish === true
    )
    expect(finish).toBeTruthy()
    expect((finish!.body as { stream: { content: string } }).stream.content).toBe("thinking...")
    // Still reported as an empty outbound to the queue.
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error!.code).toBe("validation")
    await adapter.stop()
  })
})

describe("createWeComAdapter — errcode handling", () => {
  it("surfaces a rejected reply ack as a non-retryable failure", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
    await tick()
    const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "text", text: "reply" }],
        metadata: { idempotencyKey: "k3" },
      }),
      (f) => (f.cmd === "aibot_respond_msg" ? { errcode: 95001, errmsg: "content blocked" } : {})
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error!.retryable).toBe(false)
      expect(res.error!.code).toBe("platform_4xx")
      expect(res.error!.message).toContain("95001")
      expect(res.error!.message).toContain("content blocked")
    }
    await adapter.stop()
  })

  it("a connection close mid-send fails the send as retryable (no silent ok)", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    const ref: WeComConversationRef = {
      platform: "wecom",
      adapterId: "wc1",
      chatId: "u_alice",
      chatType: "single",
    }
    const sendP = adapter.send({
      conversationRef: ref,
      segments: [{ type: "text", text: "hello" }],
      metadata: { idempotencyKey: "k4" },
    })
    for (let i = 0; i < 20; i++) {
      await tick()
      if (sentFrames().some((f) => f.cmd === "aibot_send_msg")) break
    }
    bus.trigger("connectors://ws/h1/close", "")
    const res = await sendP
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error!.retryable).toBe(true)
      expect(res.error!.code).toBe("platform_5xx")
      expect(res.error!.message).toContain("connection closed")
    }
    await adapter.stop()
  })

  it("surfaces a rejected proactive ack as a failure", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    const ref: WeComConversationRef = {
      platform: "wecom",
      adapterId: "wc1",
      chatId: "u_alice",
      chatType: "single",
    }
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "text", text: "push" }],
        metadata: { idempotencyKey: "k5" },
      }),
      (f) => (f.cmd === "aibot_send_msg" ? { errcode: 45033, errmsg: "quota" } : {})
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error!.retryable).toBe(false)
      expect(res.error!.message).toContain("45033")
    }
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

  it("keys proactive media frames by msgtype (not a generic `media` object)", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    const realFetch = global.fetch
    global.fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as typeof fetch
    try {
      const ref: WeComConversationRef = {
        platform: "wecom",
        adapterId: "wc1",
        chatId: "u_alice",
        chatType: "single",
      }
      const res = await settleWithAcks(
        bus,
        adapter.send({
          conversationRef: ref,
          segments: [{ type: "image", url: "https://cdn/pic.png" }],
          metadata: { idempotencyKey: "k6" },
        }),
        (f) => {
          if (f.cmd === "aibot_upload_media_init") return { body: { upload_id: "up1" } }
          if (f.cmd === "aibot_upload_media_finish") return { body: { media_id: "mid-1" } }
          return {}
        }
      )
      expect(res.ok).toBe(true)
      const f = sentFrames().find((x) => x.cmd === "aibot_send_msg")
      expect(f!.body).toEqual({
        chatid: "u_alice",
        chat_type: 1,
        msgtype: "image",
        image: { media_id: "mid-1" },
      })
      expect((f!.body as Record<string, unknown>).media).toBeUndefined()
    } finally {
      global.fetch = realFetch
    }
    await adapter.stop()
  })

  it("stamps lastActivityAt on a successful send", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    const before = adapter.health().lastActivityAt!
    await sleep(5)
    const ref: WeComConversationRef = {
      platform: "wecom",
      adapterId: "wc1",
      chatId: "u_alice",
      chatType: "single",
    }
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "text", text: "ping" }],
        metadata: { idempotencyKey: "k7" },
      })
    )
    expect(res.ok).toBe(true)
    expect(adapter.health().lastActivityAt!).toBeGreaterThan(before)
    await adapter.stop()
  })
})

describe("createWeComAdapter — stream_with_template_card", () => {
  it("sends text + template_card as ONE combined frame (finish:true), not two", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
    await tick()
    const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
    mockBuildCard.mockResolvedValue(SAMPLE_CARD)
    mockWsSend.mockClear()
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "markdown", md: "**done**" }, a2uiSegment],
        metadata: { idempotencyKey: "k8" },
      })
    )
    expect(res.ok).toBe(true)
    const responds = sentFrames().filter((f) => f.cmd === "aibot_respond_msg")
    expect(responds).toHaveLength(1)
    expect(responds[0].body).toEqual({
      msgtype: "stream_with_template_card",
      stream: { id: expect.any(String), content: "**done**", finish: true },
      template_card: SAMPLE_CARD,
    })
    await adapter.stop()
  })

  it("folds a card-only final after streamed frames into one combined frame with the last previewed text", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
    await tick()
    const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
    await adapter.streamReply!({ conversationRef: ref, text: "thinking..." })
    // Server acks the preview frame (consumes its owed ack) before we clear
    // the frame log, keeping the acker's cursor aligned.
    bus.trigger(
      "connectors://ws/h1/message",
      JSON.stringify({ headers: { req_id: "r-live" }, errcode: 0 })
    )
    mockBuildCard.mockResolvedValue(SAMPLE_CARD)
    mockWsSend.mockClear()
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [a2uiSegment],
        metadata: { idempotencyKey: "k9" },
      })
    )
    expect(res.ok).toBe(true)
    const responds = sentFrames().filter((f) => f.cmd === "aibot_respond_msg")
    expect(responds).toHaveLength(1)
    expect(responds[0].body).toEqual({
      msgtype: "stream_with_template_card",
      stream: { id: expect.any(String), content: "thinking...", finish: true },
      template_card: SAMPLE_CARD,
    })
    await adapter.stop()
  })

  it("still sends a plain template_card reply when no text was ever streamed", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", msgFrame("r-live", "hi"))
    await tick()
    const ref = (emit.mock.calls[0][0] as NormalizedInboundEvent).conversationRef
    mockBuildCard.mockResolvedValue(SAMPLE_CARD)
    mockWsSend.mockClear()
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [a2uiSegment],
        metadata: { idempotencyKey: "k10" },
      })
    )
    expect(res.ok).toBe(true)
    const responds = sentFrames().filter((f) => f.cmd === "aibot_respond_msg")
    expect(responds).toHaveLength(1)
    expect(responds[0].body).toEqual({ msgtype: "template_card", template_card: SAMPLE_CARD })
    await adapter.stop()
  })
})

describe("createWeComAdapter — events", () => {
  it("dispatches a template_card_event callback and acks the card", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    mockWsSend.mockClear()
    bus.trigger("connectors://ws/h1/message", cardEventFrame("rc", "a2ui:s1:b1:go"))
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

  it("an A2UI card click opens a reply window: the next send for that chat replies instead of pushing", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit)
    bus.trigger("connectors://ws/h1/message", cardEventFrame("r-card", "a2ui:s1:b1:go", "c1"))
    await tick()
    // The callback event carries no conversationRef (shared type) — the
    // turn's outbound ref has the chat but no reqId. It must still ride the
    // live reply window recorded for the click.
    const ref: WeComConversationRef = {
      platform: "wecom",
      adapterId: "wc1",
      chatId: "c1",
      chatType: "single",
    }
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "text", text: "card result" }],
        metadata: { idempotencyKey: "k11" },
      })
    )
    expect(res.ok).toBe(true)
    expect(sentFrames().some((f) => f.cmd === "aibot_send_msg")).toBe(false)
    const reply = sentFrames().find(
      (f) => f.cmd === "aibot_respond_msg" && f.headers?.req_id === "r-card"
    )
    expect(reply!.body).toMatchObject({
      msgtype: "stream",
      stream: { content: "card result", finish: true },
    })
    await adapter.stop()
  })

  it("menu-card quick command: the synthesized ref replies through the live req (no proactive dead-end)", async () => {
    const emit = makeEmit()
    const { adapter, bus } = await startSubscribed(emit, {
      quickCommands: [
        { triggerKey: "help", label: "Help", action: { type: "prompt", value: "show help" } },
      ],
    })
    bus.trigger("connectors://ws/h1/message", cardEventFrame("r-menu", "qc:help", "c1"))
    await tick()
    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0][0] as NormalizedInboundEvent
    const ref = ev.conversationRef as WeComConversationRef
    expect(ref.chatId).toBe("c1")
    expect(ref.reqId).toBe("r-menu")
    expect(ev.plainText).toBe("show help")
    const res = await settleWithAcks(
      bus,
      adapter.send({
        conversationRef: ref,
        segments: [{ type: "text", text: "here is help" }],
        metadata: { idempotencyKey: "k12" },
      })
    )
    expect(res.ok).toBe(true)
    expect(sentFrames().some((f) => f.cmd === "aibot_send_msg")).toBe(false)
    const reply = sentFrames().find(
      (f) => f.cmd === "aibot_respond_msg" && f.headers?.req_id === "r-menu"
    )
    expect(reply).toBeTruthy()
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
