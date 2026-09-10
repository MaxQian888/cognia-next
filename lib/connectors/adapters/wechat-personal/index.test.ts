const mockCdnFetch = jest.fn()
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => mockCdnFetch(...args),
}))
import { createWechatPersonalAdapter } from "./index"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { WechatPersonalConversationRef } from "./parse"
import { ILINK_ITEM, ILINK_MSG } from "./protocol"

const mockAttachmentRead = jest.fn(async (..._args: unknown[]): Promise<string | null> => null)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  ...jest.requireActual("@/lib/connectors/tauri/commands"),
  connectorsAttachmentRead: (...args: unknown[]) => mockAttachmentRead(...args),
}))

const mockGate = jest.fn(async (..._a: unknown[]) => true)
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: (...a: unknown[]) => mockGate(...a),
}))

const tick = () => new Promise((r) => setTimeout(r, 0))

type HttpResp = { status: number; headers: Record<string, string>; body: string }

/** Build a ctx whose httpRequest routes by URL (getupdates vs sendmessage). */
function makeCtx(opts: {
  emit: jest.Mock
  getUpdates: () => unknown
  sendMessage?: () => unknown
  fetchAttachment?: jest.Mock
}): { ctx: AdapterContext; http: jest.Mock; warn: jest.Mock; abort: AbortController } {
  const http = jest.fn(async (req: { url: string }): Promise<HttpResp> => {
    const body = req.url.includes("getupdates")
      ? opts.getUpdates()
      : (opts.sendMessage?.() ?? { ret: 0 })
    // A string body is passed through raw so tests can feed non-JSON.
    return {
      status: 200,
      headers: {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  })
  const warn = jest.fn()
  const abort = new AbortController()
  const ctx = {
    emit: opts.emit as unknown as AdapterContext["emit"],
    tauri: {
      httpRequest: http,
      fetchAttachment:
        opts.fetchAttachment ?? jest.fn(async () => ({ localUrl: "file:///x", remoteRef: "r" })),
    } as unknown as AdapterContext["tauri"],
    secrets: {} as AdapterContext["secrets"],
    logger: { debug() {}, info() {}, warn, error() {} },
    signal: abort.signal,
    adapterId: "wx1",
  }
  return { ctx, http, warn, abort }
}

/** Flush pending microtasks without relying on timers (fake-timer safe). */
async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

function adapter() {
  return createWechatPersonalAdapter({
    id: "wx1",
    displayName: "My WeChat",
    token: async () => "tok",
    baseUrl: async () => "https://base",
    _backoffBaseMs: 1,
  })
}

const userMsg = (text: string, ctxToken = "ctx-1") => ({
  from_user_id: "alice@im.wechat",
  to_user_id: "bot@im.bot",
  message_type: ILINK_MSG.fromUser,
  context_token: ctxToken,
  session_id: "s1",
  item_list: [{ type: ILINK_ITEM.text, text_item: { text } }],
})

beforeEach(() => {
  mockAttachmentRead.mockReset()
  mockAttachmentRead.mockResolvedValue(null)
  mockGate.mockClear()
  mockGate.mockResolvedValue(true)
})

describe("createWechatPersonalAdapter — inbound long-poll", () => {
  it("emits a parsed message then stops the loop on session expiry", async () => {
    const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1) return { ret: 0, msgs: [userMsg("hello")], get_updates_buf: "cur2" }
        return { ret: -14, errcode: -14, errmsg: "session timeout" }
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 10 && emit.mock.calls.length === 0; i++) await tick()
    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0][0] as NormalizedInboundEvent
    expect(ev.platform).toBe("wechat-personal")
    expect(ev.plainText).toBe("hello")
    // Let the loop hit the -14 response.
    for (let i = 0; i < 10 && a.health().state !== "degraded"; i++) await tick()
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("session_expired_rescan")
    await a.stop()
  })

  it("does not emit when the gate denies", async () => {
    const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
    mockGate.mockResolvedValue(false)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1) return { ret: 0, msgs: [userMsg("blocked")] }
        return { ret: -14 }
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 12; i++) await tick()
    expect(emit).not.toHaveBeenCalled()
    await a.stop()
  })
})

describe("createWechatPersonalAdapter — outbound reply (reply-only)", () => {
  it("sends a text reply echoing the context_token", async () => {
    const emit = jest.fn(async () => undefined)
    const { ctx, http } = makeCtx({
      emit,
      getUpdates: () => ({ ret: -14 }), // end the loop immediately
      sendMessage: () => ({ ret: 0 }),
    })
    const a = adapter()
    await a.start(ctx)
    await tick()
    const ref: WechatPersonalConversationRef = {
      platform: "wechat-personal",
      adapterId: "wx1",
      userId: "alice@im.wechat",
      contextToken: "ctx-9",
    }
    const res = await a.send({
      conversationRef: ref,
      segments: [{ type: "text", text: "hi back" }],
      metadata: { idempotencyKey: "k1" },
    })
    expect(res.ok).toBe(true)
    const sendCall = http.mock.calls.find((c) =>
      (c[0] as { url: string }).url.includes("sendmessage")
    )
    expect(sendCall).toBeTruthy()
    const body = JSON.parse((sendCall![0] as { body: string }).body)
    expect(body.msg.context_token).toBe("ctx-9")
    expect(body.msg.to_user_id).toBe("alice@im.wechat")
    expect(body.msg.item_list[0].text_item.text).toBe("hi back")
    await a.stop()
  })

  it("marks the session dead and refuses retry when send hits ret -14", async () => {
    const emit = jest.fn(async () => undefined)
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => ({ ret: -14 }), // end the loop immediately
      sendMessage: () => ({ ret: -14, errmsg: "session timeout" }),
    })
    const a = adapter()
    await a.start(ctx)
    await tick()
    // Park the adapter first so the health flip below is attributable to
    // send() alone (the poll loop is done and health() reads "down").
    await a.stop()
    expect(a.health().state).toBe("down")
    const ref: WechatPersonalConversationRef = {
      platform: "wechat-personal",
      adapterId: "wx1",
      userId: "alice@im.wechat",
      contextToken: "ctx-9",
    }
    const res = await a.send({
      conversationRef: ref,
      segments: [{ type: "text", text: "hi back" }],
      metadata: { idempotencyKey: "k-exp" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("auth_failed")
    expect(res.error?.retryable).toBe(false)
    expect(res.error?.message).toContain("session timeout")
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("session_expired_rescan")
  })

  it.each([
    [200, { ret: 0, errcode: -14 }, "auth_failed", false],
    [200, { ret: 0, errcode: 42 }, "platform_4xx", true],
    [500, {}, "platform_5xx", true],
    [403, { ret: 0 }, "auth_failed", false],
    [200, null, "bad_response", true],
  ])("does not claim success for HTTP %s body %j", async (status, body, code, retryable) => {
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    http.mockResolvedValue({ status, headers: {}, body: JSON.stringify(body) })
    const result = await a.send({
      conversationRef: {
        platform: "wechat-personal",
        adapterId: "wx1",
        userId: "alice",
        contextToken: "ctx",
      },
      segments: [{ type: "text", text: "hello" }],
      metadata: { idempotencyKey: "response-check" },
    })
    expect(result).toMatchObject({ ok: false, error: { code, retryable } })
    await a.stop()
  })

  it("refuses a proactive send with no context_token", async () => {
    const emit = jest.fn(async () => undefined)
    const { ctx } = makeCtx({ emit, getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    const res = await a.send({
      conversationRef: { platform: "wechat-personal", adapterId: "wx1", userId: "bob@im.wechat" },
      segments: [{ type: "text", text: "ping" }],
      metadata: { idempotencyKey: "k2" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("unsupported_segment")
    await a.stop()
  })
})

describe("createWechatPersonalAdapter — batch resilience & cursor ordering", () => {
  it("keeps handling the rest of the batch when one handler throws, retains the cursor for replay", async () => {
    const emit = jest
      .fn(async (_e: NormalizedInboundEvent) => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("handler exploded")
      })
    let call = 0
    const { ctx, http, warn } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1)
          return {
            ret: 0,
            msgs: [userMsg("m1", "ctx-a"), userMsg("m2", "ctx-b")],
            get_updates_buf: "cur9",
          }
        return { ret: -14 }
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && call < 2; i++) await tick()

    // Message 2 was still handled despite message 1's handler throwing.
    expect(emit).toHaveBeenCalledTimes(2)
    expect((emit.mock.calls[1][0] as NormalizedInboundEvent).plainText).toBe("m2")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("handler exploded"))
    // A failed delivery must be replayed; the next poll retains the old cursor.
    const updates = http.mock.calls.filter((c) =>
      (c[0] as { url: string }).url.includes("getupdates")
    )
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(JSON.parse((updates[1][0] as { body: string }).body).get_updates_buf).toBe("")
    await a.stop()
  })

  it("hydrates official nested and quoted media into readable URLs with detected MIME", async () => {
    const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
    const fetchAttachment = jest.fn(async () => ({ localUrl: "file:///cache", remoteRef: "r" }))
    const png = "iVBORw0KGgo="
    mockAttachmentRead.mockResolvedValue(png)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      fetchAttachment,
      getUpdates: () =>
        ++call === 1
          ? {
              msgs: [
                {
                  ...userMsg(""),
                  item_list: [
                    {
                      type: ILINK_ITEM.text,
                      text_item: { text: "look" },
                      ref_msg: {
                        message_item: {
                          type: ILINK_ITEM.image,
                          image_item: { media: { full_url: "https://cdn/quote" } },
                        },
                      },
                    },
                    {
                      type: ILINK_ITEM.image,
                      image_item: { media: { encrypt_query_param: "image" } },
                    },
                    {
                      type: ILINK_ITEM.file,
                      file_item: {
                        media: { full_url: "https://cdn/file" },
                        file_name: "image.png",
                      },
                    },
                  ],
                },
              ],
            }
          : { ret: -14 },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 30 && !emit.mock.calls.length; i++) await tick()
    const media = emit.mock.calls[0][0].segments.filter(
      (segment) => segment.type === "image" || segment.type === "file"
    )
    expect(media).toHaveLength(3)
    for (const segment of media)
      expect(segment).toMatchObject({
        dataBase64: png,
        mimeType: "image/png",
        url: `data:image/png;base64,${png}`,
      })
    expect(fetchAttachment).toHaveBeenCalledTimes(3)
    await a.stop()
  })

  it("blanks the encrypted image url (placeholder alt) when media resolution fails", async () => {
    const emit = jest.fn(async (_e: NormalizedInboundEvent) => undefined)
    const fetchAttachment = jest.fn(async () => {
      throw new Error("download refused")
    })
    let call = 0
    const { ctx, warn } = makeCtx({
      emit,
      fetchAttachment,
      getUpdates: () => {
        call += 1
        if (call === 1)
          return {
            ret: 0,
            msgs: [
              {
                ...userMsg("", "ctx-img"),
                item_list: [
                  {
                    type: ILINK_ITEM.image,
                    image_item: { url: "https://cdn/enc.jpg", aes_key: "a2V5" },
                  },
                  {
                    type: ILINK_ITEM.image,
                    image_item: { media: { full_url: "https://cdn/second.jpg", aes_key: "a2V5" } },
                  },
                  {
                    type: ILINK_ITEM.voice,
                    voice_item: { media: { full_url: "https://cdn/voice" } },
                  },
                  {
                    type: ILINK_ITEM.video,
                    video_item: { media: { full_url: "https://cdn/video" } },
                  },
                  {
                    type: ILINK_ITEM.file,
                    file_item: { media: { full_url: "https://cdn/file" }, file_name: "file.pdf" },
                  },
                ],
              },
            ],
          }
        return { ret: -14 }
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && emit.mock.calls.length === 0; i++) await tick()

    expect(fetchAttachment).toHaveBeenCalledWith("wx1", "https://cdn/enc.jpg")
    expect(fetchAttachment).toHaveBeenCalledWith("wx1", "https://cdn/second.jpg")
    for (const name of ["voice", "video", "file"])
      expect(fetchAttachment).toHaveBeenCalledWith("wx1", `https://cdn/${name}`)
    const ev = emit.mock.calls[0][0] as NormalizedInboundEvent
    expect(ev.segments[0]).toMatchObject({ type: "image", url: "", alt: "[unavailable image]" })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("download refused"))
    await a.stop()
  })
})

describe("createWechatPersonalAdapter — poll failure classification", () => {
  it("degrades with bad_response and logs when the body is not JSON", async () => {
    const { ctx, warn } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () => "<html>gateway error</html>",
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && a.health().reason !== "bad_response"; i++) await tick()
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("bad_response")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("non-JSON"))
    await a.stop()
  })

  it("degrades with token_missing when the keyring has no bot token", async () => {
    const { ctx, warn } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () => ({ ret: 0 }),
    })
    const a = createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "",
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 20 && a.health().reason !== "token_missing"; i++) await tick()
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("token_missing")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("token missing"))
    await a.stop()
  })

  it("degrades with network_error and logs when the HTTP proxy throws", async () => {
    const { ctx, warn } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () => {
        throw new Error("socket hang up")
      },
    })
    const a = adapter()
    await a.start(ctx)
    for (let i = 0; i < 20 && a.health().reason !== "network_error"; i++) await tick()
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toBe("network_error")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("socket hang up"))
    await a.stop()
  })

  it("tolerates a trailing slash on the persisted base URL", async () => {
    const { ctx, http } = makeCtx({
      emit: jest.fn(async () => undefined),
      getUpdates: () => ({ ret: -14 }),
    })
    const a = createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => "https://base///",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 10 && http.mock.calls.length === 0; i++) await tick()
    expect((http.mock.calls[0][0] as { url: string }).url).toBe("https://base/ilink/bot/getupdates")
    await a.stop()
  })
})

describe("createWechatPersonalAdapter — lifecycle (abortable backoff)", () => {
  const longBackoffAdapter = () =>
    createWechatPersonalAdapter({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => "https://base",
      _backoffBaseMs: 60_000,
    })

  it("stop() wakes a pending backoff delay promptly", async () => {
    jest.useFakeTimers()
    try {
      const { ctx } = makeCtx({
        emit: jest.fn(async () => undefined),
        getUpdates: () => ({ ret: 1, errmsg: "boom" }),
      })
      const a = longBackoffAdapter()
      await a.start(ctx)
      await flushMicrotasks()
      expect(jest.getTimerCount()).toBeGreaterThan(0) // parked in a long backoff
      await a.stop()
      await flushMicrotasks()
      expect(jest.getTimerCount()).toBe(0) // delay woken, timer cleared, loop exited
      expect(a.health().state).toBe("down")
    } finally {
      jest.useRealTimers()
    }
  })

  it("exits the loop when ctx.signal aborts during backoff", async () => {
    jest.useFakeTimers()
    try {
      const { ctx, http, abort } = makeCtx({
        emit: jest.fn(async () => undefined),
        getUpdates: () => ({ ret: 1 }),
      })
      const a = longBackoffAdapter()
      await a.start(ctx)
      await flushMicrotasks()
      const callsBeforeAbort = http.mock.calls.length
      expect(jest.getTimerCount()).toBeGreaterThan(0)
      abort.abort()
      await flushMicrotasks()
      expect(jest.getTimerCount()).toBe(0)
      jest.advanceTimersByTime(60 * 60_000)
      await flushMicrotasks()
      expect(http.mock.calls.length).toBe(callsBeforeAbort) // no more polls
    } finally {
      jest.useRealTimers()
    }
  })

  it("resets the backoff attempt counter on start()", async () => {
    jest.useFakeTimers()
    try {
      const { ctx, http } = makeCtx({
        emit: jest.fn(async () => undefined),
        getUpdates: () => ({ ret: 1 }),
      })
      const a = createWechatPersonalAdapter({
        id: "wx1",
        displayName: "My WeChat",
        token: async () => "tok",
        baseUrl: async () => "https://base",
        _backoffBaseMs: 1000,
      })
      await a.start(ctx)
      await flushMicrotasks() // poll #1 → attempts=1, backoff ≤ 2500ms
      jest.advanceTimersByTime(2600)
      await flushMicrotasks() // poll #2 → attempts=2, backoff ≤ 5000ms
      jest.advanceTimersByTime(5100)
      await flushMicrotasks() // poll #3 → attempts=3
      expect(http.mock.calls.length).toBe(3)
      await a.stop()
      await flushMicrotasks()

      await a.start(ctx)
      await flushMicrotasks() // poll #4 on the fresh loop
      expect(http.mock.calls.length).toBe(4)
      // attempts was reset: the next retry lands within ≤2500ms. Had the
      // counter carried over (attempts=4 → ≥16s), it would not fire here.
      jest.advanceTimersByTime(2600)
      await flushMicrotasks()
      expect(http.mock.calls.length).toBe(5)
      await a.stop()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("createWechatPersonalAdapter — numeric reply → callback short-circuit", () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it("dispatches a numeric reply through dispatchConnectorCallback when a binding is live", async () => {
    const { __resetNumericActionRegistryForTesting, setNumericAction } =
      await import("./numeric-action-registry")
    __resetNumericActionRegistryForTesting()
    const conv = "wechat-personal:wx1:alice@im.wechat"
    setNumericAction(conv, 1, "a2ui:s1:y:confirm")

    const dispatchSpy = jest.fn(async (_e: unknown) => undefined)
    jest.doMock("@/lib/connectors/bus", () => ({
      getBus: () => ({ dispatchConnectorCallback: dispatchSpy }),
    }))
    const { createWechatPersonalAdapter: factory } = await import("./index")

    const emit = jest.fn(async () => undefined)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1) return { ret: 0, msgs: [userMsg("1")] }
        return { ret: -14 }
      },
    })
    const a = factory({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 10 && dispatchSpy.mock.calls.length === 0; i++) await tick()

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const ev = dispatchSpy.mock.calls[0][0] as { triggerId: string; conversationKey: string }
    expect(ev.triggerId).toBe("a2ui:s1:y:confirm")
    expect(ev.conversationKey).toBe(conv)
    // Regular message emit must NOT fire for the same turn.
    expect(emit).not.toHaveBeenCalled()
    await a.stop()
    jest.dontMock("@/lib/connectors/bus")
  })

  it("falls through to emit() when the digit has no live binding", async () => {
    const { __resetNumericActionRegistryForTesting } = await import("./numeric-action-registry")
    __resetNumericActionRegistryForTesting()

    const dispatchSpy = jest.fn(async (_e: unknown) => undefined)
    jest.doMock("@/lib/connectors/bus", () => ({
      getBus: () => ({ dispatchConnectorCallback: dispatchSpy }),
    }))
    const { createWechatPersonalAdapter: factory } = await import("./index")

    const emit = jest.fn(async () => undefined)
    let call = 0
    const { ctx } = makeCtx({
      emit,
      getUpdates: () => {
        call += 1
        if (call === 1) return { ret: 0, msgs: [userMsg("1")] }
        return { ret: -14 }
      },
    })
    const a = factory({
      id: "wx1",
      displayName: "My WeChat",
      token: async () => "tok",
      baseUrl: async () => "https://base",
      _backoffBaseMs: 1,
    })
    await a.start(ctx)
    for (let i = 0; i < 10 && emit.mock.calls.length === 0; i++) await tick()

    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledTimes(1)
    await a.stop()
    jest.dontMock("@/lib/connectors/bus")
  })
})

describe("outbound encrypted media integration", () => {
  const ref: WechatPersonalConversationRef = {
    platform: "wechat-personal",
    adapterId: "wx1",
    userId: "user",
    contextToken: "ctx",
  }
  beforeEach(() => {
    mockCdnFetch.mockReset()
    mockCdnFetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ "x-encrypted-param": "download" }),
    })
  })
  it("uploads all media then publishes individual ordered items with stable client IDs", async () => {
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    http.mockClear()
    http.mockImplementation(async (req) => ({
      status: 200,
      headers: {},
      body: JSON.stringify(req.url.includes("getuploadurl") ? { upload_param: "signed" } : {}),
    }))
    const request = {
      conversationRef: ref,
      segments: [
        { type: "text" as const, text: "caption" },
        { type: "image" as const, url: "data:image/png;base64,AQID" },
        { type: "video" as const, url: "data:video/mp4;base64,AQID" },
        {
          type: "file" as const,
          url: "data:application/pdf;base64,AQID",
          name: "a.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
        },
        { type: "voice" as const, url: "data:audio/mpeg;base64,AQID" },
      ],
      metadata: { idempotencyKey: "stable" },
    }
    const result = await a.send(request)
    expect(result.ok).toBe(true)
    expect(http.mock.calls.slice(0, 4).every(([req]) => req.url.includes("getuploadurl"))).toBe(
      true
    )
    const sent = http.mock.calls
      .filter(([req]) => req.url.includes("sendmessage"))
      .map(([req]) => JSON.parse(req.body).msg)
    expect(sent.map((msg) => msg.item_list[0].type)).toEqual([1, 2, 5, 4, 4])
    expect(sent.every((msg) => msg.item_list.length === 1 && msg.context_token === "ctx")).toBe(
      true
    )
    expect(new Set(sent.map((msg) => msg.client_id)).size).toBe(5)
    expect(result.downgrades).toEqual([
      { from: "voice", to: "file", reason: "ilink_audio_sent_as_file" },
    ])
    expect(result.platformMessageId).toBe(sent[4].client_id)
    http.mockClear()
    await a.send(request)
    expect(
      http.mock.calls
        .filter(([req]) => req.url.includes("sendmessage"))
        .map(([req]) => JSON.parse(req.body).msg.client_id)
    ).toEqual(sent.map((msg) => msg.client_id))
    await a.stop()
  })
  it("does not publish captions when upload fails", async () => {
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    http.mockClear()
    http.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ upload_param: "signed" }),
    })
    mockCdnFetch.mockResolvedValue({ status: 403 })
    const result = await a.send({
      conversationRef: ref,
      segments: [
        { type: "text", text: "caption" },
        { type: "image", url: "data:image/png;base64,AQID" },
      ],
      metadata: { idempotencyKey: "failed" },
    })
    expect(result).toMatchObject({ ok: false, error: { retryable: false } })
    expect(http.mock.calls.some(([req]) => req.url.includes("sendmessage"))).toBe(false)
    await a.stop()
  })
  it("requires reconciliation after partial delivery", async () => {
    const { ctx, http } = makeCtx({ emit: jest.fn(), getUpdates: () => ({ ret: -14 }) })
    const a = adapter()
    await a.start(ctx)
    await tick()
    http.mockClear()
    http
      .mockResolvedValueOnce({ status: 200, headers: {}, body: "{}" })
      .mockRejectedValueOnce(new Error("disconnected"))
    const result = await a.send({
      conversationRef: ref,
      segments: [{ type: "text", text: "x".repeat(2001) }],
      metadata: { idempotencyKey: "partial" },
    })
    expect(result).toMatchObject({
      ok: false,
      platformMessageId: expect.any(String),
      error: { code: "reconciliation_required", retryable: false },
    })
    await a.stop()
  })
})
