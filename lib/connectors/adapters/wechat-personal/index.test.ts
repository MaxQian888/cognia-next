import { createWechatPersonalAdapter } from "./index"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { WechatPersonalConversationRef } from "./parse"
import { ILINK_ITEM, ILINK_MSG } from "./protocol"

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
}): { ctx: AdapterContext; http: jest.Mock } {
  const http = jest.fn(async (req: { url: string }): Promise<HttpResp> => {
    const body = req.url.includes("getupdates")
      ? opts.getUpdates()
      : (opts.sendMessage?.() ?? { ret: 0 })
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  })
  const ctx = {
    emit: opts.emit as unknown as AdapterContext["emit"],
    tauri: { httpRequest: http } as unknown as AdapterContext["tauri"],
    secrets: {} as AdapterContext["secrets"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    adapterId: "wx1",
  }
  return { ctx, http }
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
