/**
 * DingTalk adapter factory tests — mock the Stream transport + HTTP send +
 * at-gate, then assert meta/capability, the OpenAPI send routing (1:1 vs
 * group + validation), and that inbound frames are parsed and emitted.
 */

const mockHttp = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: (...a: unknown[]) => mockHttp(...a),
}))

let framesImpl: () => AsyncGenerator<{ topic: string; data: Record<string, unknown> }>
interface CapturedStreamOpts {
  onTransportState?: (state: { kind: "connected" } | { kind: "failure"; reason: string }) => void
}
let capturedStreamOpts: CapturedStreamOpts | null = null
jest.mock("./stream-client", () => ({
  TOPIC_BOT_MESSAGE: "/v1.0/im/bot/messages/get",
  startDingTalkStream: (opts: CapturedStreamOpts) => {
    capturedStreamOpts = opts
    return { frames: framesImpl() }
  },
}))

const mockClearTokenCache = jest.fn()
jest.mock("./auth", () => ({
  ...jest.requireActual("./auth"),
  clearDingTalkTokenCache: (...a: unknown[]) => mockClearTokenCache(...a),
}))

const gateInboundEvent = jest.fn(async (..._a: unknown[]) => true)
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: (...a: unknown[]) => gateInboundEvent(...(a as [string, never])),
}))

import { createDingTalkAdapter } from "./index"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"

function makeAdapter() {
  return createDingTalkAdapter({
    id: "ad_1",
    displayName: "DingTalk Bot",
    appKey: async () => "ak",
    appSecret: async () => "as",
    accessToken: async () => "tok",
    selfId: "self_bot",
  })
}

function okResp() {
  return { status: 200, headers: {}, body: JSON.stringify({ processQueryKey: "ok" }) }
}

function ref(over: Record<string, unknown> = {}) {
  return { platform: "dingtalk", adapterId: "ad_1", robotCode: "robot_1", ...over }
}

function req(conversationRef: Record<string, unknown>, text = "hello"): OutboundRequest {
  return {
    conversationRef: conversationRef as OutboundRequest["conversationRef"],
    segments: [{ type: "text", text }],
    metadata: { idempotencyKey: "k1" },
  }
}

function makeCtx(adapterId = "ad_1", onEmit?: (ev: unknown) => void): AdapterContext {
  return {
    emit: async (ev: unknown) => {
      onEmit?.(ev)
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    adapterId,
  } as unknown as AdapterContext
}

beforeEach(() => {
  jest.clearAllMocks()
  capturedStreamOpts = null
  framesImpl = async function* () {
    /* no frames by default */
  }
})

describe("createDingTalkAdapter — meta + capability", () => {
  it("exposes dingtalk meta, capability matrix, and empty skill capabilities", () => {
    const a = makeAdapter()
    expect(a.meta.type).toBe("dingtalk")
    expect(a.meta.capabilities).toContain("send.markdown")
    // Stream mode is a persistent outbound WebSocket — declared as "gateway".
    expect(a.meta.transportModes).toEqual(["gateway"])
    expect(a.a2uiCapability().Text).toBe("native")
    expect(a.platformSkillCapabilities?.()).toEqual([])
  })

  it("refreshCredentials is a no-op resolver", async () => {
    const a = makeAdapter()
    await expect(a.refreshCredentials?.()).resolves.toBeUndefined()
  })

  it("starts with an empty selfId when none is provided", async () => {
    framesImpl = async function* () {
      await new Promise<void>(() => {})
    }
    const a = createDingTalkAdapter({
      id: "ad_2",
      displayName: "No Self",
      appKey: async () => "ak",
      appSecret: async () => "as",
      accessToken: async () => "tok",
    })
    const ctx = {
      emit: async () => {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      adapterId: "ad_2",
    } as unknown as AdapterContext
    await a.start(ctx)
    expect(a.health().state).toBe("running")
    await a.stop()
  })
})

describe("send routing", () => {
  it("1:1 send posts to oToMessages/batchSend with the userId", async () => {
    mockHttp.mockResolvedValue(okResp())
    const a = makeAdapter()
    const res = await a.send(req(ref({ conversationType: "1", userId: "staff_1" })))
    expect(res.ok).toBe(true)
    const call = mockHttp.mock.calls[0][0]
    expect(call.url).toContain("/v1.0/robot/oToMessages/batchSend")
    const body = JSON.parse(call.body)
    expect(body.userIds).toEqual(["staff_1"])
    expect(body.robotCode).toBe("robot_1")
    expect(body.msgKey).toBe("sampleText")
    expect(JSON.parse(body.msgParam)).toEqual({ content: "hello" })
    expect(call.headers["x-acs-dingtalk-access-token"]).toBe("tok")
  })

  it("group send posts to groupMessages/send with the openConversationId", async () => {
    mockHttp.mockResolvedValue(okResp())
    const a = makeAdapter()
    const res = await a.send(req(ref({ conversationType: "2", openConversationId: "cid_1" })))
    expect(res.ok).toBe(true)
    const call = mockHttp.mock.calls[0][0]
    expect(call.url).toContain("/v1.0/robot/groupMessages/send")
    expect(JSON.parse(call.body).openConversationId).toBe("cid_1")
  })

  it("validates missing target ids", async () => {
    const a = makeAdapter()
    const r1 = await a.send(req(ref({ conversationType: "1" })))
    expect(r1.ok).toBe(false)
    expect(r1.error?.code).toBe("validation")
    const r2 = await a.send(req(ref({ conversationType: "2" })))
    expect(r2.error?.message).toContain("openConversationId")
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("returns ok:true with no HTTP call when there is nothing to send", async () => {
    const a = makeAdapter()
    const res = await a.send({
      conversationRef: ref({ conversationType: "1", userId: "s" }) as never,
      segments: [],
      metadata: { idempotencyKey: "k" },
    })
    expect(res.ok).toBe(true)
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("clears the token cache and retries once on a 401, then succeeds", async () => {
    mockHttp
      .mockResolvedValueOnce({
        status: 401,
        headers: {},
        body: JSON.stringify({ message: "token expired" }),
      })
      .mockResolvedValueOnce(okResp())
    const a = makeAdapter()
    const res = await a.send(req(ref({ conversationType: "1", userId: "staff_1" })))
    expect(res.ok).toBe(true)
    expect(mockClearTokenCache).toHaveBeenCalledTimes(1)
    expect(mockClearTokenCache).toHaveBeenCalledWith("ak", "as")
    expect(mockHttp).toHaveBeenCalledTimes(2)
  })

  it("maps a persistent 401 to auth_failed (non-retryable) after one retry", async () => {
    mockHttp.mockResolvedValue({
      status: 401,
      headers: {},
      body: JSON.stringify({ message: "bad token" }),
    })
    const a = makeAdapter()
    const res = await a.send(req(ref({ conversationType: "1", userId: "s" })))
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("auth_failed")
    expect(res.error?.retryable).toBe(false)
    // exactly one cache-clearing retry — no infinite loop
    expect(mockClearTokenCache).toHaveBeenCalledTimes(1)
    expect(mockHttp).toHaveBeenCalledTimes(2)
  })

  it("does not clear the token cache for non-auth failures", async () => {
    mockHttp.mockResolvedValueOnce({ status: 500, headers: {}, body: "boom" })
    const a = makeAdapter()
    await a.send(req(ref({ conversationType: "1", userId: "s" })))
    expect(mockClearTokenCache).not.toHaveBeenCalled()
    expect(mockHttp).toHaveBeenCalledTimes(1)
  })

  it("maps a 500 to platform_5xx (retryable) and 429 to rate_limited", async () => {
    mockHttp.mockResolvedValueOnce({ status: 500, headers: {}, body: "boom" })
    const a = makeAdapter()
    const r5 = await a.send(req(ref({ conversationType: "1", userId: "s" })))
    expect(r5.error?.code).toBe("platform_5xx")
    expect(r5.error?.retryable).toBe(true)
    mockHttp.mockResolvedValueOnce({
      status: 429,
      headers: {},
      body: JSON.stringify({ message: "slow" }),
    })
    const r429 = await a.send(req(ref({ conversationType: "1", userId: "s" })))
    expect(r429.error?.code).toBe("rate_limited")
  })

  it("maps a transport rejection to a retryable platform_5xx", async () => {
    mockHttp.mockRejectedValueOnce(new Error("network down"))
    const a = makeAdapter()
    const res = await a.send(req(ref({ conversationType: "1", userId: "s" })))
    expect(res.error?.code).toBe("platform_5xx")
    expect(res.error?.message).toContain("network down")
  })
})

describe("send — sessionWebhook fallback (no staffId)", () => {
  const WEBHOOK = "https://oapi.dingtalk.com/robot/sendBySession?session=s1"

  function unionRef(over: Record<string, unknown> = {}) {
    return ref({
      conversationType: "1",
      userId: "$:LWCP_v1:$abc==",
      sessionWebhook: WEBHOOK,
      sessionWebhookExpiredTime: Date.now() + 60_000,
      ...over,
    })
  }

  it("posts text to the unexpired session webhook instead of batchSend", async () => {
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ errcode: 0 }) })
    const a = makeAdapter()
    const res = await a.send(req(unionRef()))
    expect(res.ok).toBe(true)
    expect(mockHttp).toHaveBeenCalledTimes(1)
    const call = mockHttp.mock.calls[0][0]
    expect(call.url).toBe(WEBHOOK)
    // classic robot-webhook shape, no access-token header
    expect(call.headers["x-acs-dingtalk-access-token"]).toBeUndefined()
    expect(JSON.parse(call.body)).toEqual({ msgtype: "text", text: { content: "hello" } })
  })

  it("projects markdown onto the webhook markdown shape", async () => {
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ errcode: 0 }) })
    const a = makeAdapter()
    const res = await a.send({
      conversationRef: unionRef() as OutboundRequest["conversationRef"],
      segments: [{ type: "markdown", md: "# Title\nbody" }],
      metadata: { idempotencyKey: "k2" },
    })
    expect(res.ok).toBe(true)
    const body = JSON.parse(mockHttp.mock.calls[0][0].body)
    expect(body.msgtype).toBe("markdown")
    expect(body.markdown.text).toContain("# Title")
    expect(body.markdown.title).toBeTruthy()
  })

  it("returns a non-retryable validation error when the webhook is expired", async () => {
    const a = makeAdapter()
    const res = await a.send(
      req(unionRef({ sessionWebhookExpiredTime: Date.now() - 1000 }))
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
    expect(res.error?.retryable).toBe(false)
    expect(res.error?.message).toContain("staffId")
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("returns a validation error when there is no webhook at all", async () => {
    const a = makeAdapter()
    const res = await a.send(
      req(unionRef({ sessionWebhook: undefined, sessionWebhookExpiredTime: undefined }))
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
    expect(res.error?.message).toContain("staffId")
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("surfaces a webhook body errcode as a non-retryable platform_4xx", async () => {
    mockHttp.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ errcode: 300001, errmsg: "session expired" }),
    })
    const a = makeAdapter()
    const res = await a.send(req(unionRef()))
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.retryable).toBe(false)
    expect(res.error?.message).toContain("session expired")
  })

  it("keeps the staffId path on batchSend (behavior unchanged)", async () => {
    mockHttp.mockResolvedValue(okResp())
    const a = makeAdapter()
    // a staff id present alongside a webhook still routes through batchSend
    const res = await a.send(req(unionRef({ userId: "staff_1" })))
    expect(res.ok).toBe(true)
    const call = mockHttp.mock.calls[0][0]
    expect(call.url).toContain("/v1.0/robot/oToMessages/batchSend")
    expect(JSON.parse(call.body).userIds).toEqual(["staff_1"])
  })
})

describe("start — inbound", () => {
  it("parses a bot-message frame and emits it after the at-gate passes", async () => {
    framesImpl = async function* () {
      yield {
        topic: "/v1.0/im/bot/messages/get",
        data: {
          msgId: "m1",
          conversationId: "c1",
          conversationType: "1",
          senderStaffId: "staff_1",
          msgtype: "text",
          text: { content: "hi bot" },
        },
      }
    }
    const emitted: Array<{ plainText: string }> = []
    const ctx = {
      emit: async (ev: { plainText: string }) => {
        emitted.push(ev)
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      adapterId: "ad_1",
    } as unknown as AdapterContext

    const a = makeAdapter()
    await a.start(ctx)
    // allow the async inbound loop to drain the generator
    await new Promise((r) => setTimeout(r, 10))
    await a.stop()

    expect(gateInboundEvent).toHaveBeenCalled()
    expect(emitted).toHaveLength(1)
    expect(emitted[0].plainText).toBe("hi bot")
  })

  it("skips non-bot-message topics, null parses, and gate-rejected events", async () => {
    framesImpl = async function* () {
      yield { topic: "/v1.0/card/instances/callback", data: { x: 1 } } // not a bot message
      yield { topic: "/v1.0/im/bot/messages/get", data: { msgtype: "text" } } // parse → null (no ids)
      yield {
        topic: "/v1.0/im/bot/messages/get",
        data: {
          msgId: "m2",
          conversationId: "c2",
          conversationType: "1",
          msgtype: "text",
          text: { content: "blocked" },
        },
      }
    }
    gateInboundEvent.mockResolvedValue(false)
    const emitted: unknown[] = []
    const ctx = {
      emit: async (e: unknown) => {
        emitted.push(e)
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      adapterId: "ad_1",
    } as unknown as AdapterContext
    const a = makeAdapter()
    await a.start(ctx)
    await new Promise((r) => setTimeout(r, 10))
    await a.stop()
    expect(emitted).toHaveLength(0)
  })

  it("sets health to degraded when the stream loop throws", async () => {
    framesImpl = async function* () {
      throw new Error("stream blew up")
    }
    const ctx = {
      emit: async () => {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      adapterId: "ad_1",
    } as unknown as AdapterContext
    const a = makeAdapter()
    await a.start(ctx)
    await new Promise((r) => setTimeout(r, 10))
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("transport_error")
  })

  it("sets health to down with 'no_data' when the stream ends without frames", async () => {
    framesImpl = async function* () {
      /* completes immediately — no frames */
    }
    const ctx = {
      emit: async () => {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      adapterId: "ad_1",
    } as unknown as AdapterContext
    const a = makeAdapter()
    await a.start(ctx)
    await new Promise((r) => setTimeout(r, 10))
    expect(a.health().state).toBe("down")
    expect(a.health().reason).toBe("no_data")
  })

  it("is idempotent on double start (second start is a no-op)", async () => {
    framesImpl = async function* () {
      await new Promise<void>(() => {})
    }
    const ctx = {
      emit: async () => {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      adapterId: "ad_1",
    } as unknown as AdapterContext
    const a = makeAdapter()
    await a.start(ctx)
    await a.start(ctx)
    expect(a.health().state).toBe("running")
    await a.stop()
  })

  it("learns selfId from the first frame's chatbotUserId and keeps it for later frames", async () => {
    // an earlier test flips the gate to false; clearAllMocks does not restore it
    gateInboundEvent.mockResolvedValue(true)
    framesImpl = async function* () {
      yield {
        topic: "/v1.0/im/bot/messages/get",
        data: {
          msgId: "m1",
          conversationId: "c1",
          conversationType: "1",
          chatbotUserId: "learned_bot",
          msgtype: "text",
          text: { content: "first" },
        },
      }
      // second frame omits chatbotUserId — the learned selfId must persist
      yield {
        topic: "/v1.0/im/bot/messages/get",
        data: {
          msgId: "m2",
          conversationId: "c1",
          conversationType: "1",
          msgtype: "text",
          text: { content: "second" },
        },
      }
    }
    const emitted: Array<{ selfId: string }> = []
    const a = createDingTalkAdapter({
      id: "ad_no_self",
      displayName: "No Self",
      appKey: async () => "ak",
      appSecret: async () => "as",
      accessToken: async () => "tok",
    })
    await a.start(makeCtx("ad_no_self", (ev) => emitted.push(ev as { selfId: string })))
    await new Promise((r) => setTimeout(r, 10))
    await a.stop()
    expect(emitted).toHaveLength(2)
    expect(emitted[0].selfId).toBe("learned_bot")
    expect(emitted[1].selfId).toBe("learned_bot")
  })

  it("health reflects starting → running → down across the lifecycle", async () => {
    // A live stream never completes (it reconnects forever), so block here to
    // hold the adapter in "running" until stop() aborts it.
    framesImpl = async function* () {
      await new Promise<void>(() => {})
    }
    const a = makeAdapter()
    expect(a.health().state).toBe("starting")
    const ctx = {
      emit: async () => {},
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      adapterId: "ad_1",
    } as unknown as AdapterContext
    await a.start(ctx)
    expect(a.health().state).toBe("running")
    await a.stop()
    expect(a.health().state).toBe("down")
  })
})

describe("transport health (register/ws-open failures)", () => {
  async function startedAdapter() {
    framesImpl = async function* () {
      await new Promise<void>(() => {})
    }
    const a = makeAdapter()
    await a.start(makeCtx())
    const onTransportState = capturedStreamOpts?.onTransportState
    expect(onTransportState).toBeDefined()
    return { a, onTransportState: onTransportState! }
  }

  it("degrades to the failure reason after 3 consecutive failures", async () => {
    const { a, onTransportState } = await startedAdapter()
    onTransportState({ kind: "failure", reason: "auth_failed" })
    onTransportState({ kind: "failure", reason: "auth_failed" })
    // below the threshold — still running
    expect(a.health().state).toBe("running")
    onTransportState({ kind: "failure", reason: "auth_failed" })
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("auth_failed")
    await a.stop()
  })

  it("carries register_failed for non-auth register failures", async () => {
    const { a, onTransportState } = await startedAdapter()
    for (let i = 0; i < 3; i++) onTransportState({ kind: "failure", reason: "register_failed" })
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("register_failed")
    await a.stop()
  })

  it("recovers to running (and clears the reason) once a connection lands", async () => {
    const { a, onTransportState } = await startedAdapter()
    for (let i = 0; i < 3; i++) onTransportState({ kind: "failure", reason: "register_failed" })
    expect(a.health().state).toBe("degraded")
    onTransportState({ kind: "connected" })
    expect(a.health().state).toBe("running")
    expect(a.health().reason).toBeUndefined()
    // the failure streak was reset — two more failures do not degrade
    onTransportState({ kind: "failure", reason: "register_failed" })
    onTransportState({ kind: "failure", reason: "register_failed" })
    expect(a.health().state).toBe("running")
    await a.stop()
  })

  it("ignores transport callbacks after stop()", async () => {
    const { a, onTransportState } = await startedAdapter()
    await a.stop()
    for (let i = 0; i < 3; i++) onTransportState({ kind: "failure", reason: "auth_failed" })
    expect(a.health().state).toBe("down")
    onTransportState({ kind: "connected" })
    expect(a.health().state).toBe("down")
  })
})
