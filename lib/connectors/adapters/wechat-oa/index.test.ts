import { invoke } from "@tauri-apps/api/core"
import { createWechatOaAdapter } from "./index"
import { clearWechatOaTokenCache, getWechatOaAccessToken } from "./auth"
import { startWechatOaWebhook } from "./transport-webhook"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { isTauri } from "@/lib/tauri"
import {
  setConnectorCommandInvoker,
  type ConnectorCommandInvoker,
} from "@/lib/connectors/tauri/commands"

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
  it.each(["image", "voice", "video"])(
    "resolves %s media in the active headless receive loop through its injected native bridge",
    async (type) => {
      const globals = globalThis as Record<string, unknown>
      const previousHeadless = globals.__COGNIA_HEADLESS__
      globals.__COGNIA_HEADLESS__ = true
      expect(isTauri()).toBe(false)
      const encoded =
        type === "image"
          ? "/9j/"
          : type === "voice"
            ? btoa("#!AMR\npayload")
            : btoa("\0\0\0\x18ftypmp42payload")
      let reads = 0
      const xml = `<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>${type}</MsgType><MediaId>media1</MediaId><MsgId>1</MsgId></xml>`
      const native = jest.fn(async (name: string) => {
        if (name === "connectors_wechat_oa_inbound_list")
          return [{ id: "headless-media", xml, receivedAt: 1 }]
        if (name === "connectors_wechat_oa_inbound_claim") return true
        if (name === "connectors_attachment_read") return ++reads === 1 ? null : encoded
        if (name === "connectors_attachment_fetch") return { sizeBytes: atob(encoded).length }
        if (name === "connectors_http_request")
          return httpResp(200, { video_url: "https://cdn.example.com/video.mp4" })
        return undefined
      })
      const previousInvoker = setConnectorCommandInvoker(native as ConnectorCommandInvoker)
      const a = adapter()
      const emit = jest.fn()
      mockWebhook.mockImplementation(async function* () {
        yield {
          ingressId: "headless-media",
          xml,
        }
      })
      try {
        await a.start({ emit } as unknown as AdapterContext)
        await flush()
        expect(emit).toHaveBeenCalledTimes(1)
        const segment = emit.mock.calls[0][0].segments[0]
        if (type === "image")
          expect(segment).toMatchObject({ dataBase64: encoded, mimeType: "image/jpeg" })
        else
          expect(segment.url).toBe(
            `data:${type === "voice" ? "audio/amr" : "video/mp4"};base64,${encoded}`
          )
        expect(segment.rawUrl).toBe("wxmedia://media1")
        expect(native).toHaveBeenCalledWith(
          "connectors_attachment_fetch",
          expect.objectContaining({ adapterId: "wxoa-1", remoteRef: "wechat-oa:media:media1" })
        )
        expect(native).toHaveBeenLastCalledWith("connectors_wechat_oa_inbound_ack", {
          adapterId: "wxoa-1",
          id: "headless-media",
        })
        expect(mockInvoke).not.toHaveBeenCalled()
      } finally {
        await a.stop()
        setConnectorCommandInvoker(previousInvoker)
        if (previousHeadless === undefined) delete globals.__COGNIA_HEADLESS__
        else globals.__COGNIA_HEADLESS__ = previousHeadless
      }
    }
  )

  it("preserves unsupported rich content with explicit text downgrades", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { errcode: 0 }))
    const req = sendReq()
    req.segments = [
      { type: "mention", userId: "u", displayName: "Alice" },
      { type: "location", name: "Office", lat: 1, lon: 2 },
      { type: "poll", question: "Pick", options: ["A", "B"] },
      { type: "reply", messageId: "m", snippet: "original" },
    ]
    const result = await adapter().send(req)
    expect(result.ok).toBe(true)
    expect(result.downgrades).toEqual(
      req.segments.map((segment) => ({
        from: segment.type,
        to: "text",
        reason: "wechat_oa_text_alternative",
      }))
    )
    expect(JSON.parse(mockInvoke.mock.calls[0][1].req.body).text.content).toBe(
      "@Alice\nOffice: 1,2\nPick\n1. A\n2. B\n> original"
    )
  })
  it("rejects opaque cards before uploading preceding media", async () => {
    const req = sendReq()
    req.segments = [
      { type: "image", url: "file:///tmp/photo.jpg" },
      { type: "card", card: { kind: "unknown", payload: { title: "lost" } } },
    ]
    expect(await adapter().send(req)).toMatchObject({
      ok: false,
      error: { code: "validation", retryable: false },
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })
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

  it("uploads images and sends native customer-service media payloads", async () => {
    mockInvoke.mockImplementation(async (cmd: string) =>
      cmd === "connectors_media_upload"
        ? JSON.stringify(httpResp(200, { media_id: "media-1" }))
        : httpResp(200, { errcode: 0 })
    )
    const req = sendReq()
    req.segments = [{ type: "image", url: "file:///tmp/photo.jpg", mimeType: "image/jpeg" }]
    expect((await adapter().send(req)).ok).toBe(true)
    expect(mockInvoke.mock.calls[0][0]).toBe("connectors_media_upload")
    expect(mockInvoke.mock.calls[0][1].req).toMatchObject({
      localPath: "/tmp/photo.jpg",
      responseMode: "http",
      multipart: { fieldName: "media", filename: "photo.jpg" },
    })
    expect(JSON.parse(mockInvoke.mock.calls[1][1].req.body)).toEqual({
      touser: "oUser",
      msgtype: "image",
      image: { media_id: "media-1" },
    })
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

  it("send() does not retry an oversized message", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { errcode: 45002, errmsg: "message too long" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.retryable).toBe(false)
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

  it("send() requires reconciliation on an unparseable 200 body", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, "not json"))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.retryable).toBe(false)
    expect(res.error?.code).toBe("delivery_unknown")
    expect(res.error?.message).toContain("non-JSON")
  })

  it.each([{}, null, []])("send() rejects success bodies without errcode zero", async (body) => {
    mockInvoke.mockResolvedValue(httpResp(200, body))
    expect(await adapter().send(sendReq())).toMatchObject({
      ok: false,
      error: { code: "delivery_unknown", retryable: false },
    })
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

  describe("setTyping()", () => {
    it("POSTs custom/typing with Typing / CancelTyping for the conversation's openid", async () => {
      mockInvoke.mockResolvedValue(httpResp(200, { errcode: 0 }))
      const a = adapter()
      await a.setTyping!("wechat-oa:wxoa-1:oUser", true)
      await a.setTyping!("wechat-oa:wxoa-1:oUser", false)
      const calls = mockInvoke.mock.calls.map((c) => c[1].req as { url: string; body: string })
      expect(calls).toHaveLength(2)
      expect(calls[0].url).toBe(
        "https://api.weixin.qq.com/cgi-bin/message/custom/typing?access_token=tok"
      )
      expect(JSON.parse(calls[0].body)).toEqual({ touser: "oUser", command: "Typing" })
      expect(JSON.parse(calls[1].body)).toEqual({ touser: "oUser", command: "CancelTyping" })
      expect(a.health().lastActivityAt).toBeDefined()
    })

    it("swallows 45015 / 45047 (best-effort) but throws other errcodes and transport failures", async () => {
      const a = adapter()
      mockInvoke.mockResolvedValue(httpResp(200, { errcode: 45015, errmsg: "out of window" }))
      await expect(a.setTyping!("wechat-oa:wxoa-1:oUser", true)).resolves.toBeUndefined()
      mockInvoke.mockResolvedValue(httpResp(200, { errcode: 45047, errmsg: "over limit" }))
      await expect(a.setTyping!("wechat-oa:wxoa-1:oUser", true)).resolves.toBeUndefined()
      mockInvoke.mockResolvedValue(httpResp(200, { errcode: 48001, errmsg: "api unauthorized" }))
      await expect(a.setTyping!("wechat-oa:wxoa-1:oUser", true)).rejects.toThrow(/48001/)
      mockInvoke.mockResolvedValue(httpResp(502, "<html>bad gateway</html>"))
      await expect(a.setTyping!("wechat-oa:wxoa-1:oUser", true)).rejects.toThrow(/non-JSON/)
      mockInvoke.mockResolvedValue(httpResp(500, { errcode: 0 }))
      await expect(a.setTyping!("wechat-oa:wxoa-1:oUser", true)).rejects.toThrow(/HTTP 500/)
    })

    it("retries once on an auth errcode with a fresh token, then degrades and throws", async () => {
      mockInvoke
        .mockResolvedValueOnce(httpResp(200, { errcode: 40001, errmsg: "invalid credential" }))
        .mockResolvedValueOnce(httpResp(200, { errcode: 0 }))
      const a = adapter()
      await expect(a.setTyping!("wechat-oa:wxoa-1:oUser", true)).resolves.toBeUndefined()
      expect(mockInvoke).toHaveBeenCalledTimes(2)

      mockInvoke.mockReset()
      mockInvoke.mockResolvedValue(httpResp(200, { errcode: 42001, errmsg: "expired" }))
      await expect(a.setTyping!("wechat-oa:wxoa-1:oUser", true)).rejects.toThrow(/auth failed/)
      expect(mockInvoke).toHaveBeenCalledTimes(2)
      expect(a.health()).toMatchObject({ state: "degraded", reason: "auth_failed" })
    })

    it("rejects an unparseable conversation key without calling the platform", async () => {
      await expect(adapter().setTyping!("nope", true)).rejects.toThrow(/unparseable/)
      expect(mockInvoke).not.toHaveBeenCalled()
    })
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
      yield {
        xml: `<xml><ToUserName><![CDATA[gh_abc123]]></ToUserName><FromUserName><![CDATA[oUser]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content><MsgId>1</MsgId></xml>`,
      }
    })
    const a = adapter()
    const emit = jest.fn()
    await a.start({ emit } as unknown as AdapterContext)
    await flush()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({ selfId: "gh_abc123", plainText: "hello" })
    await a.stop()
  })

  it("continues receiving after a single accepted event fails to persist", async () => {
    mockWebhook.mockImplementation(async function* () {
      for (const id of ["1", "2"])
        yield {
          xml: `<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>hello</Content><MsgId>${id}</MsgId></xml>`,
        }
    })
    const a = adapter()
    const emit = jest
      .fn()
      .mockRejectedValueOnce(new Error("DB unavailable"))
      .mockResolvedValue(undefined)
    await a.start({ emit } as unknown as AdapterContext)
    await flush()
    expect(emit.mock.calls.map(([event]) => event.messageId)).toEqual(["1", "2"])
    await a.stop()
  })

  it("does not emit from a stopped generation after an awaited gate resumes", async () => {
    let release!: (allowed: boolean) => void
    mockGate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    mockWebhook.mockImplementation(async function* () {
      yield {
        xml: `<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>hello</Content><MsgId>1</MsgId></xml>`,
      }
    })
    const a = adapter()
    const emit = jest.fn()
    await a.start({ emit } as unknown as AdapterContext)
    await flush()
    await a.stop()
    release(true)
    await flush()
    expect(emit).not.toHaveBeenCalled()
  })

  it("retries durable acceptance without ACKing a failed delivery", async () => {
    jest.useFakeTimers()
    const a = adapter()
    try {
      const xml =
        "<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>hello</Content><MsgId>1</MsgId></xml>"
      mockInvoke.mockImplementation(async (name: string) => {
        if (name === "connectors_wechat_oa_inbound_list")
          return [{ id: "ingress-1", xml, receivedAt: 1 }]
        if (name === "connectors_wechat_oa_inbound_claim") return true
        return undefined
      })
      mockWebhook.mockImplementation(async function* () {
        yield {
          ingressId: "ingress-1",
          xml,
        }
      })
      const emit = jest
        .fn()
        .mockRejectedValueOnce(new Error("DB unavailable"))
        .mockResolvedValue(undefined)
      await a.start({ emit } as unknown as AdapterContext)
      await jest.advanceTimersByTimeAsync(0)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "connectors_wechat_oa_inbound_ack",
        expect.anything()
      )
      await jest.advanceTimersByTimeAsync(250)
      expect(emit).toHaveBeenCalledTimes(2)
      expect(mockInvoke).toHaveBeenCalledWith("connectors_wechat_oa_inbound_ack", {
        adapterId: "wxoa-1",
        id: "ingress-1",
      })
    } finally {
      await a.stop()
      jest.useRealTimers()
    }
  })

  it("ACKs terminal unsupported XML without dispatching a model turn", async () => {
    mockInvoke.mockImplementation(async (name: string) =>
      name === "connectors_wechat_oa_inbound_list"
        ? [{ id: "ignored-1", xml: "<xml><MsgType>unknown</MsgType></xml>", receivedAt: 1 }]
        : undefined
    )
    mockWebhook.mockImplementation(async function* () {
      yield { ingressId: "ignored-1", xml: "<xml><MsgType>unknown</MsgType></xml>" }
    })
    const a = adapter()
    const emit = jest.fn()
    await a.start({ emit } as unknown as AdapterContext)
    await flush()
    expect(emit).not.toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledWith("connectors_wechat_oa_inbound_ack", {
      adapterId: "wxoa-1",
      id: "ignored-1",
    })
    await a.stop()
  })

  it("retries only the exact ACK after durable acceptance succeeds", async () => {
    jest.useFakeTimers()
    const a = adapter()
    try {
      const xml =
        "<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>hello</Content><MsgId>1</MsgId></xml>"
      mockWebhook.mockImplementation(async function* () {
        yield {
          ingressId: "accepted-1",
          xml,
        }
      })
      let acknowledgements = 0
      mockInvoke.mockImplementation(async (name: string) => {
        if (name === "connectors_wechat_oa_inbound_list")
          return [{ id: "accepted-1", xml, receivedAt: 1 }]
        if (name === "connectors_wechat_oa_inbound_claim") return true
        if (name === "connectors_wechat_oa_inbound_ack" && ++acknowledgements === 1)
          throw new Error("ACK write failed")
        return undefined
      })
      const emit = jest.fn().mockResolvedValue(undefined)
      await a.start({ emit } as unknown as AdapterContext)
      await jest.advanceTimersByTimeAsync(0)
      expect(emit).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(250)
      expect(acknowledgements).toBe(2)
      expect(mockInvoke).toHaveBeenLastCalledWith("connectors_wechat_oa_inbound_ack", {
        adapterId: "wxoa-1",
        id: "accepted-1",
      })
      expect(emit).toHaveBeenCalledTimes(1)
      expect(mockGate).toHaveBeenCalledTimes(1)
      expect(
        mockInvoke.mock.calls.filter(([name]) => name === "connectors_wechat_oa_inbound_claim")
      ).toHaveLength(1)
    } finally {
      await a.stop()
      jest.useRealTimers()
    }
  })

  it("drops a retained delivery revoked while its policy gate was awaiting", async () => {
    const xml =
      "<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>obsolete</Content><MsgId>1</MsgId></xml>"
    let release!: (allowed: boolean) => void
    mockGate.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    mockWebhook.mockImplementation(async function* () {
      yield {
        ingressId: "revoked-1",
        xml,
      }
    })
    mockInvoke
      .mockResolvedValueOnce([{ id: "revoked-1", xml, receivedAt: 1 }])
      .mockResolvedValue([])
    const a = adapter()
    const emit = jest.fn()
    try {
      await a.start({ emit } as unknown as AdapterContext)
      await flush()
      release(true)
      await flush()
      expect(emit).not.toHaveBeenCalled()
      expect(mockInvoke).toHaveBeenCalledWith("connectors_wechat_oa_inbound_list", {
        adapterId: "wxoa-1",
      })
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "connectors_wechat_oa_inbound_ack",
        expect.anything()
      )
    } finally {
      await a.stop()
    }
  })

  it("rechecks native ownership after asynchronous media resolution", async () => {
    const xml =
      "<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>image</MsgType><MediaId>media1</MediaId><MsgId>1</MsgId></xml>"
    let retained = true
    let release!: (value: string) => void
    mockInvoke.mockImplementation(async (name: string) => {
      if (name === "connectors_wechat_oa_inbound_list")
        return retained ? [{ id: "media-1", xml, receivedAt: 1 }] : []
      if (name === "connectors_attachment_read")
        return new Promise<string>((resolve) => {
          release = resolve
        })
      return undefined
    })
    mockWebhook.mockImplementation(async function* () {
      yield { ingressId: "media-1", xml }
    })
    const a = adapter()
    const emit = jest.fn()
    try {
      await a.start({ emit } as unknown as AdapterContext)
      await flush()
      expect(release).toBeDefined()
      retained = false
      release("/9j/")
      await flush()
      expect(emit).not.toHaveBeenCalled()
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "connectors_wechat_oa_inbound_ack",
        expect.anything()
      )
    } finally {
      await a.stop()
    }
  })

  it("drops a delivery revoked between its final native read and durable claim", async () => {
    const xml =
      "<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>obsolete</Content><MsgId>1</MsgId></xml>"
    mockInvoke.mockImplementation(async (name: string) => {
      if (name === "connectors_wechat_oa_inbound_list")
        return [{ id: "claim-lost", xml, receivedAt: 1, admitted: false }]
      if (name === "connectors_wechat_oa_inbound_claim") return false
      return undefined
    })
    mockWebhook.mockImplementation(async function* () {
      yield { ingressId: "claim-lost", xml, admitted: false }
    })
    const a = adapter()
    const emit = jest.fn()
    try {
      await a.start({ emit } as unknown as AdapterContext)
      await flush()
      expect(mockInvoke).toHaveBeenCalledWith("connectors_wechat_oa_inbound_claim", {
        adapterId: "wxoa-1",
        id: "claim-lost",
      })
      expect(emit).not.toHaveBeenCalled()
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "connectors_wechat_oa_inbound_ack",
        expect.anything()
      )
    } finally {
      await a.stop()
    }
  })

  it("resumes an admitted restart delivery even when the current gate denies new work", async () => {
    const xml =
      "<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>retained</Content><MsgId>1</MsgId></xml>"
    mockGate.mockResolvedValue(false)
    mockInvoke.mockImplementation(async (name: string) => {
      if (name === "connectors_wechat_oa_inbound_list")
        return [{ id: "claimed-restart", xml, receivedAt: 1, admitted: true }]
      if (name === "connectors_wechat_oa_inbound_claim") return true
      return undefined
    })
    mockWebhook.mockImplementation(async function* () {
      yield { ingressId: "claimed-restart", xml, admitted: true }
    })
    const a = adapter()
    const emit = jest.fn().mockResolvedValue(undefined)
    try {
      await a.start({ emit } as unknown as AdapterContext)
      await flush()
      expect(mockGate).not.toHaveBeenCalled()
      expect(emit).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenLastCalledWith("connectors_wechat_oa_inbound_ack", {
        adapterId: "wxoa-1",
        id: "claimed-restart",
      })
    } finally {
      await a.stop()
    }
  })

  it.each(["claim-reply-lost", "emit-failed"])(
    "preserves durable admission after %s despite a newly denying gate",
    async (failure) => {
      jest.useFakeTimers()
      const xml =
        "<xml><FromUserName>oUser</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>retained</Content><MsgId>1</MsgId></xml>"
      let admitted = false
      let claims = 0
      mockInvoke.mockImplementation(async (name: string) => {
        if (name === "connectors_wechat_oa_inbound_list")
          return [{ id: "uncertain-claim", xml, receivedAt: 1, admitted }]
        if (name === "connectors_wechat_oa_inbound_claim") {
          admitted = true
          if (++claims === 1 && failure === "claim-reply-lost")
            throw new Error("claim committed but RPC reply lost")
          return true
        }
        return undefined
      })
      mockWebhook.mockImplementation(async function* () {
        yield { ingressId: "uncertain-claim", xml, admitted: false }
      })
      const a = adapter()
      const emit = jest.fn().mockResolvedValue(undefined)
      if (failure === "emit-failed") emit.mockRejectedValueOnce(new Error("DB unavailable"))
      try {
        await a.start({ emit } as unknown as AdapterContext)
        await jest.advanceTimersByTimeAsync(0)
        expect(admitted).toBe(true)
        expect(mockInvoke).not.toHaveBeenCalledWith(
          "connectors_wechat_oa_inbound_ack",
          expect.anything()
        )
        mockGate.mockResolvedValue(false)
        await jest.advanceTimersByTimeAsync(250)
        expect(mockGate).toHaveBeenCalledTimes(1)
        expect(emit).toHaveBeenCalledTimes(failure === "emit-failed" ? 2 : 1)
        expect(mockInvoke).toHaveBeenLastCalledWith("connectors_wechat_oa_inbound_ack", {
          adapterId: "wxoa-1",
          id: "uncertain-claim",
        })
      } finally {
        await a.stop()
        jest.useRealTimers()
      }
    }
  )
})
