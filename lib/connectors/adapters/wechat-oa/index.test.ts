import { invoke } from "@tauri-apps/api/core"
import { createWechatOaAdapter } from "./index"
import { clearWechatOaTokenCache, getWechatOaAccessToken } from "./auth"
import { startWechatOaWebhook } from "./transport-webhook"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"

jest.mock("./transport-webhook", () => ({
  startWechatOaWebhook: jest.fn(),
}))
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: jest.fn(async () => true),
}))

const mockInvoke = invoke as jest.Mock
const mockWebhook = startWechatOaWebhook as jest.Mock
const mockGate = gateInboundEvent as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function adapter() {
  return createWechatOaAdapter({
    id: "wxoa-1",
    displayName: "OA Bot",
    accessToken: async () => "tok",
  })
}

function sendReq(openId: string | undefined = "oUser"): OutboundRequest {
  return {
    conversationRef: { platform: "wechat-oa", adapterId: "wxoa-1", openId },
    segments: [{ type: "text", text: "hi" }],
    metadata: { idempotencyKey: "k" },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  mockInvoke.mockReset()
  mockGate.mockReset()
  mockGate.mockResolvedValue(true)
  mockWebhook.mockReset()
  clearWechatOaTokenCache()
})

describe("createWechatOaAdapter", () => {
  it("exposes correct meta and initial health", () => {
    const a = adapter()
    expect(a.meta.type).toBe("wechat-oa")
    expect(a.meta.transportModes).toContain("webhook")
    expect(a.meta.capabilities).toContain("send.text")
    expect(a.health().state).toBe("starting")
  })

  it("does not require encodingAesKey (plaintext mode) but keeps it configurable", () => {
    const schema = adapter().meta.configSchema as {
      required: string[]
      properties: Record<string, { description?: string }>
    }
    expect(schema.required).toEqual(["appId", "appSecret", "token"])
    expect(schema.properties.encodingAesKey).toBeDefined()
    expect(schema.properties.encodingAesKey.description).toContain("safe")
  })

  it("send() posts a 客服 message with a 15s timeout and reports success", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { errcode: 0, errmsg: "ok" }))
    const a = adapter()
    const res = await a.send(sendReq())
    expect(res.ok).toBe(true)
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/cgi-bin/message/custom/send?access_token=tok")
    expect(req.timeoutMs).toBe(15_000)
    expect(JSON.parse(req.body)).toEqual({
      touser: "oUser",
      msgtype: "text",
      text: { content: "hi" },
    })
    expect(a.health().state).toBe("running")
  })

  it("send() maps the 48h-window errcode to a non-retryable validation error", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(200, { errcode: 45015, errmsg: "response out of time limit" })
    )
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
    expect(res.error?.retryable).toBe(false)
  })

  it.each([
    [48001, "api unauthorized"],
    [50002, "user block"],
  ])("send() maps permanent errcode %i to a non-retryable error", async (errcode, errmsg) => {
    mockInvoke.mockResolvedValue(httpResp(200, { errcode, errmsg }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.retryable).toBe(false)
    expect(res.error?.message).toContain(String(errcode))
  })

  it("send() keeps other platform errcodes retryable", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { errcode: 45002, errmsg: "message too long" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.retryable).toBe(true)
  })

  it("send() reports a retryable failure on an HTML gateway body (502)", async () => {
    mockInvoke.mockResolvedValue(httpResp(502, "<html><body>Bad Gateway</body></html>"))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_5xx")
    expect(res.error?.retryable).toBe(true)
    expect(res.error?.message).toContain("502")
  })

  it("send() reports a retryable failure on HTTP 500 even when the body parses", async () => {
    mockInvoke.mockResolvedValue(httpResp(500, {}))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_5xx")
    expect(res.error?.retryable).toBe(true)
    expect(res.error?.message).toContain("HTTP 500")
  })

  it("send() never reports success on an unparseable 200 body", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, "not json"))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.retryable).toBe(true)
    expect(res.error?.message).toContain("non-JSON")
  })

  it("send() rejects a request without an openId", async () => {
    const res = await adapter().send({
      conversationRef: { platform: "wechat-oa", adapterId: "wxoa-1" },
      segments: [{ type: "text", text: "x" }],
      metadata: { idempotencyKey: "k" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("send() clears the token cache and retries once on errcode 40001", async () => {
    // Wire the real token cache so we can observe the invalidation: the
    // second send attempt must carry a freshly minted token.
    let minted = 0
    mockInvoke.mockImplementation(async (_cmd: string, args: { req: { url: string } }) => {
      if (args.req.url.includes("/cgi-bin/stable_token")) {
        minted += 1
        return httpResp(200, { access_token: `tok${minted}`, expires_in: 7200 })
      }
      return args.req.url.includes("access_token=tok1")
        ? httpResp(200, { errcode: 40001, errmsg: "invalid credential" })
        : httpResp(200, { errcode: 0 })
    })
    const a = createWechatOaAdapter({
      id: "wxoa-1",
      displayName: "OA Bot",
      accessToken: () => getWechatOaAccessToken("app", "sec"),
    })
    const res = await a.send(sendReq())
    expect(res.ok).toBe(true)
    const sendCalls = mockInvoke.mock.calls.filter((c) => !c[1].req.url.includes("stable_token"))
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[1][1].req.url).toContain("access_token=tok2")
  })

  it.each([40014, 42001])(
    "send() surfaces auth_failed and degrades health when errcode %i persists after refresh",
    async (errcode) => {
      mockInvoke.mockResolvedValue(httpResp(200, { errcode, errmsg: "auth broken" }))
      const a = adapter()
      const res = await a.send(sendReq())
      expect(res.ok).toBe(false)
      expect(res.error?.code).toBe("auth_failed")
      expect(res.error?.retryable).toBe(false)
      expect(mockInvoke).toHaveBeenCalledTimes(2)
      expect(a.health()).toMatchObject({ state: "degraded", reason: "auth_failed" })

      // A later successful send restores the health state.
      mockInvoke.mockResolvedValue(httpResp(200, { errcode: 0 }))
      await a.send(sendReq())
      expect(a.health().state).toBe("running")
      expect(a.health().reason).toBeUndefined()
    }
  )

  it("send() maps a thrown transport error to a retryable platform_5xx", async () => {
    mockInvoke.mockRejectedValue(new Error("socket hang up"))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_5xx")
    expect(res.error?.retryable).toBe(true)
  })

  it("refreshCredentials() clears the cached access token", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { access_token: "tk", expires_in: 7200 }))
    await getWechatOaAccessToken("app", "sec")
    await adapter().refreshCredentials?.()
    await getWechatOaAccessToken("app", "sec")
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it("start() extracts ToUserName as the event selfId", async () => {
    mockWebhook.mockImplementation(async function* () {
      yield `<xml><ToUserName><![CDATA[gh_abc123]]></ToUserName><FromUserName><![CDATA[oUser]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content><MsgId>1</MsgId></xml>`
    })
    const a = adapter()
    const emit = jest.fn()
    await a.start({ emit } as unknown as AdapterContext)
    await flush()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({ selfId: "gh_abc123", plainText: "hello" })
    await a.stop()
  })
})
