import { invoke } from "@tauri-apps/api/core"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createQQOfficialAdapter } from "./index"
import { __resetQQMsgSeqForTesting, qqPassiveMsgSeq, qqPassiveReplyCount } from "./serialize"
import { startQQGateway } from "./gateway-client"

jest.mock("./gateway-client", () => ({
  startQQGateway: jest.fn(),
}))

// The at-gate reads adapter rows from Dexie; the adapter tests only care that
// the dispatch pipeline runs, so let every event through.
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: jest.fn(async () => true),
}))

const mockInvoke = invoke as jest.Mock
const mockStartGateway = startQQGateway as jest.Mock

function httpResp(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function adapter(extra: Partial<Parameters<typeof createQQOfficialAdapter>[0]> = {}) {
  return createQQOfficialAdapter({
    id: "qq-1",
    displayName: "QQ Bot",
    accessToken: async () => "tok",
    ...extra,
  })
}

/** All `connectors_http_request` invocations as `{ method, url, body }`. */
function httpCalls(): Array<{ method: string; url: string; body?: string }> {
  return mockInvoke.mock.calls
    .filter(([cmd]: [string]) => cmd === "connectors_http_request")
    .map((c) => (c[1] as { req: { method: string; url: string; body?: string } }).req)
}

/**
 * Start the adapter on a fake gateway that yields ONE dispatch and then hangs,
 * so `handleDispatch` populates the per-conversation last-inbound cache.
 */
async function startWithDispatch(a: ReturnType<typeof adapter>, dispatch: unknown) {
  let delivered = false
  mockStartGateway.mockReturnValue({
    selfId: "bot",
    dispatches: fakeDispatches(() => {
      if (!delivered) {
        delivered = true
        return Promise.resolve({ done: false, value: dispatch })
      }
      return new Promise(() => {})
    }),
  })
  await a.start(fakeCtx())
  await new Promise((r) => setTimeout(r, 0))
}

const C2C_DISPATCH = {
  op: 0,
  t: "C2C_MESSAGE_CREATE",
  d: { id: "in-1", content: "hi", author: { user_openid: "UO" } },
}

function sendReq(extra: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    conversationRef: {
      platform: "qq-official",
      adapterId: "qq-1",
      scene: "group",
      sceneId: "GO",
      msgId: "m1",
    },
    segments: [{ type: "text", text: "hello" }],
    metadata: { idempotencyKey: "k" },
    ...extra,
  }
}

function fakeCtx(): AdapterContext {
  return { emit: jest.fn() } as unknown as AdapterContext
}

/** Hand-rolled async iterable so tests control exactly how the stream ends. */
function fakeDispatches(next: () => Promise<IteratorResult<unknown>>) {
  const it = {
    [Symbol.asyncIterator]: () => it,
    next,
  }
  return it
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockStartGateway.mockReset()
  __resetQQMsgSeqForTesting()
})

describe("createQQOfficialAdapter", () => {
  it("exposes correct meta and initial health", () => {
    const a = adapter()
    expect(a.meta.type).toBe("qq-official")
    expect(a.meta.transportModes).toContain("gateway")
    expect(a.meta.capabilities).toContain("send.text")
    expect(a.health().state).toBe("starting")
  })

  it("send() POSTs a group message and returns the scene-qualified message id", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { id: "sent-1" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(true)
    // Composite `${scene}:${sceneId}:${id}` — delete/reactions need the scene.
    expect(res.platformMessageId).toBe("group:GO:sent-1")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/v2/groups/GO/messages")
    expect(req.headers.Authorization).toBe("QQBot tok")
    expect(JSON.parse(req.body)).toMatchObject({
      content: "hello",
      msg_type: 0,
      msg_id: "m1",
      msg_seq: qqPassiveMsgSeq("k"),
    })
  })

  it("send() returns no platformMessageId when the platform body carries no id", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, {}))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBeUndefined()
  })

  it("send() rejects an unaddressable ref", async () => {
    const res = await adapter().send({
      conversationRef: { platform: "qq-official", adapterId: "qq-1" },
      segments: [{ type: "text", text: "x" }],
      metadata: { idempotencyKey: "k" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
  })

  it("retries a 401 once with a fresh token and succeeds", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResp(401, { message: "token expired" }))
      .mockResolvedValueOnce(httpResp(200, { id: "sent-2" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBe("group:GO:sent-2")
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it("a 401 also evicts the injected token cache before the retry", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResp(401, { message: "token expired" }))
      .mockResolvedValueOnce(httpResp(200, { id: "sent-2" }))
    const clearTokenCache = jest.fn()
    const res = await adapter({ clearTokenCache }).send(sendReq())
    expect(res.ok).toBe(true)
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
  })

  it("maps a persistent 401 to a non-retryable auth_failed after one retry", async () => {
    mockInvoke.mockResolvedValue(httpResp(401, { message: "bad token", code: 11244 }))
    const a = adapter()
    const res = await a.send(sendReq())
    expect(res.error?.code).toBe("auth_failed")
    expect(res.error?.retryable).toBe(false)
    // Exactly one retry — not an infinite refresh loop.
    expect(mockInvoke).toHaveBeenCalledTimes(2)
    // The failure cause is surfaced through health() for the operator UI.
    expect(a.health().reason).toContain("failed: bad token")
  })

  it("maps a 429 to rate_limited", async () => {
    mockInvoke.mockResolvedValue(httpResp(429, { message: "slow" }))
    const res = await adapter().send(sendReq())
    expect(res.error?.code).toBe("rate_limited")
  })

  it("includes the platform code and X-Tps-trace-id in failure messages", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(400, { message: "bad payload", code: 5003 }, { "X-Tps-trace-id": "TRACE-1" })
    )
    const res = await adapter().send(sendReq())
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.message).toContain("(code 5003)")
    expect(res.error?.message).toContain("[trace TRACE-1]")
  })

  it("reads a lowercased x-tps-trace-id header too", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(400, { message: "bad", code: 1 }, { "x-tps-trace-id": "trace-lc" })
    )
    const res = await adapter().send(sendReq())
    expect(res.error?.message).toContain("[trace trace-lc]")
  })

  it("maps code 22009 on a passive reply to a distinct reply-window error", async () => {
    mockInvoke.mockResolvedValue(httpResp(400, { message: "msg limit exceed", code: 22009 }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.retryable).toBe(false)
    expect(res.error?.message).toContain("reply window")
  })

  it("keeps the generic mapping for code 22009 on a proactive send", async () => {
    mockInvoke.mockResolvedValue(httpResp(400, { message: "msg limit exceed", code: 22009 }))
    const res = await adapter().send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "group",
          sceneId: "GO",
        },
      })
    )
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.message).not.toContain("reply window")
  })
})

describe("createQQOfficialAdapter — delete", () => {
  it("recalls a group message via DELETE /v2/groups/{openid}/messages/{id}", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, ""))
    await adapter().delete!("group:GO:sent-1")
    const [call] = httpCalls()
    expect(call.method).toBe("DELETE")
    expect(call.url).toBe("https://api.sgroup.qq.com/v2/groups/GO/messages/sent-1")
    expect(call.body).toBeUndefined()
  })

  it("recalls c2c / channel / direct messages on their scene endpoints (hidetip on guild)", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, ""))
    const a = adapter()
    await a.delete!("c2c:UO:m1")
    await a.delete!("channel:CH:m2")
    await a.delete!("direct:GUILD:m3")
    const urls = httpCalls().map((c) => c.url.replace("https://api.sgroup.qq.com", ""))
    expect(urls).toEqual([
      "/v2/users/UO/messages/m1",
      "/channels/CH/messages/m2?hidetip=false",
      "/dms/GUILD/messages/m3?hidetip=false",
    ])
  })

  it("throws on a bare (undecodable) message id without calling the platform", async () => {
    await expect(adapter().delete!("sent-1")).rejects.toThrow(/scene:sceneId:id/)
    expect(httpCalls()).toHaveLength(0)
  })

  it("retries a 401 once with a fresh token, then surfaces the failure", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResp(401, { message: "expired" }))
      .mockResolvedValueOnce(httpResp(200, ""))
    await expect(adapter().delete!("group:GO:m1")).resolves.toBeUndefined()
    expect(httpCalls()).toHaveLength(2)

    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(httpResp(404, { message: "gone", code: 50006 }))
    await expect(adapter().delete!("group:GO:m1")).rejects.toThrow(/gone \(code 50006\)/)
  })
})

describe("createQQOfficialAdapter — reactions (channel scene only)", () => {
  it("addReaction PUTs /channels/{c}/messages/{m}/reactions/{type}/{id} and returns the emoji as reactionId", async () => {
    mockInvoke.mockResolvedValue(httpResp(204, ""))
    const ref = await adapter().addReaction!("channel:CH:m9", "1:4")
    const [call] = httpCalls()
    expect(call.method).toBe("PUT")
    expect(call.url).toBe("https://api.sgroup.qq.com/channels/CH/messages/m9/reactions/1/4")
    expect(ref).toEqual({ reactionId: "1:4" })
  })

  it("removeReaction DELETEs the same path", async () => {
    mockInvoke.mockResolvedValue(httpResp(204, ""))
    await adapter().removeReaction!("channel:CH:m9", "2:128512")
    const [call] = httpCalls()
    expect(call.method).toBe("DELETE")
    expect(call.url).toBe("https://api.sgroup.qq.com/channels/CH/messages/m9/reactions/2/128512")
  })

  it("throws unsupported for non-channel scenes and on malformed ids / emoji", async () => {
    const a = adapter()
    await expect(a.addReaction!("group:GO:m1", "1:4")).rejects.toThrow(/unsupported/)
    await expect(a.removeReaction!("c2c:UO:m1", "1:4")).rejects.toThrow(/unsupported/)
    await expect(a.addReaction!("m1", "1:4")).rejects.toThrow(/scene:sceneId:id/)
    await expect(a.addReaction!("channel:CH:m1", "👍")).rejects.toThrow(/<type>:<id>/)
    expect(httpCalls()).toHaveLength(0)
  })
})

describe("createQQOfficialAdapter — typing (c2c only)", () => {
  it("sends a msg_type 6 input_notify passive reply for a fresh c2c inbound", async () => {
    const a = adapter()
    await startWithDispatch(a, C2C_DISPATCH)
    mockInvoke.mockResolvedValue(httpResp(200, { id: "typing-ack" }))
    await a.setTyping!("qq-official:qq-1:UO", true)
    const [call] = httpCalls()
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://api.sgroup.qq.com/v2/users/UO/messages")
    const body = JSON.parse(call.body!) as Record<string, unknown>
    expect(body).toMatchObject({
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
      msg_id: "in-1",
    })
    expect(typeof body.msg_seq).toBe("number")
    // The indicator consumed one passive slot of the inbound msg_id …
    expect(qqPassiveReplyCount("in-1")).toBe(1)
    // … with a seq that cannot collide with a reply's idempotency-derived seq.
    expect(body.msg_seq).not.toBe(qqPassiveMsgSeq("k"))
    await a.stop()
  })

  it("is a no-op for on=false, unknown conversations and non-c2c scenes", async () => {
    const a = adapter()
    await startWithDispatch(a, {
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "g-1", content: "hi", group_openid: "GO" },
    })
    await a.setTyping!("qq-official:qq-1:GO", true)
    await a.setTyping!("qq-official:qq-1:UO", true)
    await a.setTyping!("qq-official:qq-1:UO", false)
    expect(httpCalls()).toHaveLength(0)
    await a.stop()
  })

  it("stops once 4 passive slots of the inbound msg_id are used and when the window has elapsed", async () => {
    const a = adapter()
    await startWithDispatch(a, C2C_DISPATCH)
    mockInvoke.mockResolvedValue(httpResp(200, {}))
    for (let i = 0; i < 6; i++) await a.setTyping!("qq-official:qq-1:UO", true)
    // Slots 1..4 fired; the 5th slot is reserved for the real reply.
    expect(httpCalls()).toHaveLength(4)
    expect(qqPassiveReplyCount("in-1")).toBe(4)

    // Fresh adapter, expired window → no-op.
    __resetQQMsgSeqForTesting()
    mockInvoke.mockReset()
    mockStartGateway.mockReset()
    const b = adapter()
    const now = Date.now()
    const dateSpy = jest.spyOn(Date, "now").mockReturnValue(now)
    await startWithDispatch(b, C2C_DISPATCH)
    dateSpy.mockReturnValue(now + 61 * 60_000)
    await b.setTyping!("qq-official:qq-1:UO", true)
    expect(httpCalls()).toHaveLength(0)
    dateSpy.mockRestore()
    await a.stop()
    await b.stop()
  })
})

describe("createQQOfficialAdapter — credentials", () => {
  it("refreshCredentials() evicts the injected token cache", async () => {
    const clearTokenCache = jest.fn()
    await adapter({ clearTokenCache }).refreshCredentials!()
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
    // Without an injected evictor it is a harmless no-op.
    await expect(adapter().refreshCredentials!()).resolves.toBeUndefined()
  })

  it("wires clearTokenCache into the gateway's onAuthInvalid", async () => {
    const clearTokenCache = jest.fn()
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => new Promise(() => {})),
    })
    const a = adapter({ clearTokenCache })
    await a.start(fakeCtx())
    const gatewayOpts = mockStartGateway.mock.calls[0][0] as { onAuthInvalid?: () => unknown }
    expect(typeof gatewayOpts.onAuthInvalid).toBe("function")
    await gatewayOpts.onAuthInvalid!()
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
    await a.stop()
  })

  it("declares delete / typing / send.reaction and no edit or history", () => {
    const a = adapter()
    expect(a.meta.capabilities).toEqual(
      expect.arrayContaining(["delete", "typing", "send.reaction"])
    )
    expect(a.meta.capabilities).not.toContain("edit")
    expect(a.meta.capabilities).not.toContain("history.fetch")
    expect(a.edit).toBeUndefined()
    expect(a.fetchHistory).toBeUndefined()
  })
})

describe("createQQOfficialAdapter — health reason", () => {
  it("marks degraded with a reason when the gateway loop throws", async () => {
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => Promise.reject(new Error("gateway blew up"))),
    })
    const a = adapter()
    await a.start(fakeCtx())
    await new Promise((r) => setTimeout(r, 0))
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toContain("gateway blew up")
  })

  it("marks down with a reason when the gateway stream ends without stop()", async () => {
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => Promise.resolve({ done: true, value: undefined })),
    })
    const a = adapter()
    await a.start(fakeCtx())
    await new Promise((r) => setTimeout(r, 0))
    expect(a.health().state).toBe("down")
    expect(a.health().reason).toContain("ended unexpectedly")
  })

  it("clears the reason on a clean stop() and on a later successful send", async () => {
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => new Promise(() => {})),
    })
    const a = adapter()
    await a.start(fakeCtx())
    expect(a.health().state).toBe("running")

    mockInvoke.mockResolvedValue(httpResp(401, { message: "rotated" }))
    await a.send(sendReq())
    expect(a.health().reason).toBeDefined()

    mockInvoke.mockResolvedValue(httpResp(200, { id: "ok-1" }))
    await a.send(sendReq())
    expect(a.health().reason).toBeUndefined()

    await a.stop()
    expect(a.health()).toMatchObject({ state: "down" })
    expect(a.health().reason).toBeUndefined()
  })
})
