import { invoke } from "@tauri-apps/api/core"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createQQOfficialAdapter } from "./index"
import { __resetQQMsgSeqForTesting } from "./serialize"
import { startQQGateway } from "./gateway-client"

jest.mock("./gateway-client", () => ({
  startQQGateway: jest.fn(),
}))

const mockInvoke = invoke as jest.Mock
const mockStartGateway = startQQGateway as jest.Mock

function httpResp(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function adapter() {
  return createQQOfficialAdapter({
    id: "qq-1",
    displayName: "QQ Bot",
    accessToken: async () => "tok",
  })
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

  it("send() POSTs a group message and returns the message id", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { id: "sent-1" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBe("sent-1")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/v2/groups/GO/messages")
    expect(req.headers.Authorization).toBe("QQBot tok")
    expect(JSON.parse(req.body)).toMatchObject({
      content: "hello",
      msg_type: 0,
      msg_id: "m1",
      msg_seq: 1,
    })
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
    expect(res.platformMessageId).toBe("sent-2")
    expect(mockInvoke).toHaveBeenCalledTimes(2)
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
    expect(a.health().reason).toContain("QQ send failed")
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
        conversationRef: { platform: "qq-official", adapterId: "qq-1", scene: "group", sceneId: "GO" },
      })
    )
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.message).not.toContain("reply window")
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
