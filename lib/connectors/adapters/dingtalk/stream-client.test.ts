/**
 * DingTalk Stream client tests — mock the Tauri HTTP register call + WS
 * passthrough + @tauri-apps/api/event, then drive register → ping → bot
 * message and assert ACKs + the yielded frame.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsHttpRequest,
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import { startDingTalkStream, registerDingTalkConnection, TOPIC_BOT_MESSAGE } from "./stream-client"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsWsOpen: jest.fn(),
  connectorsWsSend: jest.fn(),
  connectorsWsClose: jest.fn(),
}))

const mockListen = listen as jest.Mock
const mockHttp = connectorsHttpRequest as jest.Mock
const mockWsOpen = connectorsWsOpen as jest.Mock
const mockWsSend = connectorsWsSend as jest.Mock
const mockWsClose = connectorsWsClose as jest.Mock

function createFakeWsSession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  let closeHandler: (() => void) | null = null
  let count = 0
  let resolve: () => void = () => {}
  const ready = new Promise<void>((r) => {
    resolve = r
  })
  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    count += 1
    if (eventName.endsWith("/message")) messageHandler = handler as (e: { payload: string }) => void
    if (eventName.endsWith("/close")) closeHandler = handler as () => void
    if (count >= 2) resolve()
    return jest.fn()
  })
  return {
    listenImpl,
    waitForListeners: () => ready,
    push: (frame: unknown) => messageHandler?.({ payload: JSON.stringify(frame) }),
    pushRaw: (raw: string) => messageHandler?.({ payload: raw }),
    triggerClose: () => closeHandler?.(),
  }
}

function registerOk() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ endpoint: "wss://fake/connect", ticket: "tkt-1" }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockWsOpen.mockResolvedValue("dt-ws-1")
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
})

describe("registerDingTalkConnection", () => {
  it("posts credentials + subscriptions and returns endpoint+ticket", async () => {
    mockHttp.mockResolvedValueOnce(registerOk())
    const res = await registerDingTalkConnection("ak", "as", [
      { topic: TOPIC_BOT_MESSAGE, type: "CALLBACK" },
    ])
    expect(res).toEqual({ endpoint: "wss://fake/connect", ticket: "tkt-1" })
    const body = JSON.parse(mockHttp.mock.calls[0][0].body)
    expect(body.clientId).toBe("ak")
    expect(body.clientSecret).toBe("as")
    expect(body.subscriptions[0].topic).toBe(TOPIC_BOT_MESSAGE)
  })

  it("throws on a malformed register response", async () => {
    mockHttp.mockResolvedValueOnce({ status: 400, headers: {}, body: JSON.stringify({}) })
    await expect(registerDingTalkConnection("ak", "as", [])).rejects.toThrow(/register failed/)
  })
})

describe("startDingTalkStream", () => {
  it("opens the ws with the ticket, echoes ping, ACKs + yields a bot message", async () => {
    mockHttp.mockResolvedValue(registerOk())
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()

    const client = startDingTalkStream({
      clientId: async () => "ak",
      clientSecret: async () => "as",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const out: Array<{ topic: string; data: Record<string, unknown> }> = []
    const collector = (async () => {
      for await (const f of client.frames) {
        out.push(f)
        if (out.length >= 1) break
      }
    })()

    await session.waitForListeners()

    // ws opened with the ticket query
    expect(mockWsOpen).toHaveBeenCalledWith("wss://fake/connect?ticket=tkt-1")

    // ping → expect echo ACK carrying the same opaque
    session.push({
      type: "SYSTEM",
      headers: { topic: "ping", messageId: "p1" },
      data: '{"opaque":"abc"}',
    })
    await Promise.resolve()
    const pingAck = mockWsSend.mock.calls.find((c) => String(c[1]).includes("abc"))
    expect(pingAck).toBeTruthy()

    // bot message CALLBACK frame
    const payload = {
      msgId: "m1",
      conversationId: "c1",
      conversationType: "1",
      msgtype: "text",
      text: { content: "hi" },
    }
    session.push({
      type: "CALLBACK",
      headers: { topic: TOPIC_BOT_MESSAGE, messageId: "cb1" },
      data: JSON.stringify(payload),
    })

    await collector
    ctrl.abort()

    expect(out).toHaveLength(1)
    expect(out[0].topic).toBe(TOPIC_BOT_MESSAGE)
    expect(out[0].data).toMatchObject({ msgId: "m1", conversationId: "c1" })
    // the bot frame was ACKed (code 200) before being yielded
    const cbAck = mockWsSend.mock.calls.find((c) => String(c[1]).includes("cb1"))
    expect(cbAck).toBeTruthy()
    expect(JSON.parse(String(cbAck![1])).code).toBe(200)
  })

  it("retries on registration failure and stops cleanly on abort", async () => {
    mockHttp.mockRejectedValue(new Error("register fail"))
    const ctrl = new AbortController()
    const client = startDingTalkStream({
      clientId: async () => "ak",
      clientSecret: async () => "as",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })
    const done = (async () => {
      for await (const _f of client.frames) {
        /* none expected */
      }
    })()
    await new Promise((r) => setTimeout(r, 15))
    ctrl.abort()
    await done
    expect(mockHttp).toHaveBeenCalled()
    expect(mockWsOpen).not.toHaveBeenCalled()
  })

  it("retries on ws-open failure and stops cleanly on abort", async () => {
    mockHttp.mockResolvedValue(registerOk())
    mockWsOpen.mockRejectedValue(new Error("ws fail"))
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    const client = startDingTalkStream({
      clientId: async () => "ak",
      clientSecret: async () => "as",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })
    const done = (async () => {
      for await (const _f of client.frames) {
        /* none expected */
      }
    })()
    await new Promise((r) => setTimeout(r, 15))
    ctrl.abort()
    await done
    expect(mockWsOpen).toHaveBeenCalled()
  })

  it("skips malformed frames and tolerates a callback with non-JSON data", async () => {
    mockHttp.mockResolvedValue(registerOk())
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    const client = startDingTalkStream({
      clientId: async () => "ak",
      clientSecret: async () => "as",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })
    const out: Array<{ topic: string; data: Record<string, unknown> }> = []
    const collector = (async () => {
      for await (const f of client.frames) {
        out.push(f)
        if (out.length >= 1) break
      }
    })()

    await session.waitForListeners()
    session.pushRaw("this is not json") // skipped
    session.push({
      type: "CALLBACK",
      headers: { topic: TOPIC_BOT_MESSAGE, messageId: "x" },
      data: "{bad json",
    })

    await collector
    ctrl.abort()
    expect(out).toHaveLength(1)
    expect(out[0].data).toEqual({}) // non-JSON data degrades to {}
  })

  it("echoes an empty opaque when the ping data is not JSON", async () => {
    mockHttp.mockResolvedValue(registerOk())
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    const client = startDingTalkStream({
      clientId: async () => "ak",
      clientSecret: async () => "as",
      signal: ctrl.signal,
      _backoffBaseMs: 50000,
    })
    const collector = (async () => {
      for await (const _f of client.frames) {
        /* none */
      }
    })()
    await session.waitForListeners()
    session.push({ type: "SYSTEM", headers: { topic: "ping", messageId: "p2" }, data: "not-json" })
    await Promise.resolve()
    const ack = mockWsSend.mock.calls.find((c) => String(c[1]).includes("p2"))
    expect(ack).toBeTruthy()
    ctrl.abort()
    await collector
  })

  it("reconnects (re-registers) when the ws closes, then stops on abort", async () => {
    mockHttp.mockResolvedValue(registerOk())
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    const client = startDingTalkStream({
      clientId: async () => "ak",
      clientSecret: async () => "as",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })
    const collector = (async () => {
      for await (const _f of client.frames) {
        /* none */
      }
    })()
    await session.waitForListeners()
    const firstRegisterCount = mockHttp.mock.calls.length
    session.triggerClose() // ws dropped → loop should back off and re-register
    await new Promise((r) => setTimeout(r, 15))
    ctrl.abort()
    await collector
    expect(mockHttp.mock.calls.length).toBeGreaterThan(firstRegisterCount)
  })

  it("ends the connection on a disconnect SYSTEM frame", async () => {
    mockHttp.mockResolvedValue(registerOk())
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()

    const client = startDingTalkStream({
      clientId: async () => "ak",
      clientSecret: async () => "as",
      signal: ctrl.signal,
      _backoffBaseMs: 50000, // long backoff so we can abort during the wait
    })

    const collector = (async () => {
      for await (const _f of client.frames) {
        // no frames expected
      }
    })()

    await session.waitForListeners()
    session.push({ type: "SYSTEM", headers: { topic: "disconnect", messageId: "d1" }, data: "{}" })
    await Promise.resolve()
    ctrl.abort()
    await collector
    expect(mockWsClose).toHaveBeenCalled()
  })
})
