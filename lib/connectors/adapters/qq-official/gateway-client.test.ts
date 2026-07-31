/**
 * QQ gateway client tests — mirror the Discord harness: mock the Tauri WS
 * passthrough + @tauri-apps/api/event, then drive HELLO → IDENTIFY → READY →
 * GROUP_AT_MESSAGE_CREATE and assert the generator yields the dispatch.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import { startQQGateway } from "./gateway-client"

const mockListen = listen as jest.Mock
const mockWsOpen = connectorsWsOpen as jest.Mock
const mockWsSend = connectorsWsSend as jest.Mock
const mockWsClose = connectorsWsClose as jest.Mock

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: jest.fn(),
  connectorsWsSend: jest.fn(),
  connectorsWsClose: jest.fn(),
}))

function createFakeWsSession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  let count = 0
  let resolve: () => void = () => {}
  const ready = new Promise<void>((r) => {
    resolve = r
  })
  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    count += 1
    if (eventName.endsWith("/message")) messageHandler = handler as (e: { payload: string }) => void
    if (count >= 2) resolve()
    return jest.fn()
  })
  return {
    listenImpl,
    waitForListeners: () => ready,
    push: (payload: unknown) => messageHandler?.({ payload: JSON.stringify(payload) }),
  }
}

/**
 * Reconnect-aware harness: tracks one message handler per WS connection so a
 * test can drive HELLO/READY frames on the first connection, force it to end,
 * and then talk to the second connection.
 */
function createMultiWsSessions() {
  const handlers: Array<(event: { payload: string }) => void> = []
  let waiters: Array<{ count: number; resolve: () => void }> = []
  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    if (eventName.endsWith("/message")) {
      handlers.push(handler as (e: { payload: string }) => void)
      waiters = waiters.filter((w) => {
        if (handlers.length >= w.count) {
          w.resolve()
          return false
        }
        return true
      })
    }
    return jest.fn()
  })
  return {
    listenImpl,
    /** Resolves once the n-th connection has registered its message listener. */
    waitForConnection: (n: number) =>
      new Promise<void>((resolve) => {
        if (handlers.length >= n) {
          resolve()
          return
        }
        waiters.push({ count: n, resolve })
      }),
    /** Push a frame to the n-th (1-indexed) connection. */
    push: (n: number, payload: unknown) => handlers[n - 1]?.({ payload: JSON.stringify(payload) }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockWsOpen.mockResolvedValue("qq-ws-1")
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
})

describe("startQQGateway", () => {
  it("identifies with the QQBot token and yields a group message dispatch", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()

    const client = startQQGateway({
      accessToken: async () => "ACCESS_TOKEN",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const out: Array<{ t: string }> = []
    const collector = (async () => {
      for await (const d of client.dispatches) {
        out.push(d)
        if (out.length >= 1) break
      }
    })()

    await session.waitForListeners()
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    session.push({ op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "s1" } })
    await new Promise((r) => setTimeout(r, 10))
    session.push({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      s: 2,
      d: { id: "m1", content: "hi", group_openid: "GO" },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collector

    expect(out).toHaveLength(1)
    expect(out[0].t).toBe("GROUP_AT_MESSAGE_CREATE")
    expect(client.selfId).toBe("bot-1")

    // The IDENTIFY frame carried the `QQBot ` token prefix.
    const identifyCall = mockWsSend.mock.calls.find((c) => {
      try {
        return JSON.parse(c[1]).op === 2
      } catch {
        return false
      }
    })
    expect(identifyCall).toBeDefined()
    expect(JSON.parse(identifyCall![1]).d.token).toBe("QQBot ACCESS_TOKEN")
  }, 10000)

  it("reconnects and recovers when the access token mint fails once during HELLO", async () => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()
    const accessToken = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error("bots.qq.com blip"))
      .mockResolvedValue("FRESH_TOKEN")

    const client = startQQGateway({
      accessToken,
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const out: Array<{ t: string }> = []
    const collector = (async () => {
      for await (const d of client.dispatches) {
        out.push(d)
        if (out.length >= 1) break
      }
    })()

    await sessions.waitForConnection(1)
    // First HELLO: accessToken rejects — must NOT unwind the generator.
    sessions.push(1, { op: 10, d: { heartbeat_interval: 100000 } })
    await sessions.waitForConnection(2)
    // Second connection: token mint succeeds, IDENTIFY goes out, bot recovers.
    sessions.push(2, { op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    sessions.push(2, { op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "s1" } })
    sessions.push(2, {
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      s: 2,
      d: { id: "m1", content: "hi", author: { user_openid: "UO" } },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collector

    expect(out).toHaveLength(1)
    expect(out[0].t).toBe("C2C_MESSAGE_CREATE")
    expect(mockWsOpen).toHaveBeenCalledTimes(2)
  }, 10000)

  it("closes a zombie socket after two heartbeats without an ACK and reconnects", async () => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()

    const client = startQQGateway({
      accessToken: async () => "TOK",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const collector = (async () => {
      // No dispatches expected — drain until abort.
      for await (const d of client.dispatches) void d
    })()

    await sessions.waitForConnection(1)
    // Tiny heartbeat interval and never an ACK: the client must give the
    // socket up as half-open and re-dial instead of heartbeating forever.
    sessions.push(1, { op: 10, d: { heartbeat_interval: 5 } })
    await sessions.waitForConnection(2)

    expect(mockWsClose).toHaveBeenCalled()
    expect(mockWsOpen.mock.calls.length).toBeGreaterThanOrEqual(2)

    ctrl.abort()
    await collector
  }, 10000)

  it("resumes with the stored session and treats RESUMED as consumed, not yielded", async () => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()

    const client = startQQGateway({
      accessToken: async () => "TOK",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const out: Array<{ t: string }> = []
    const collector = (async () => {
      for await (const d of client.dispatches) {
        out.push(d)
        if (out.length >= 1) break
      }
    })()

    await sessions.waitForConnection(1)
    sessions.push(1, { op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    sessions.push(1, { op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "s1" } })
    // A heartbeat ACK resets the zombie counter (op 11).
    sessions.push(1, { op: 11 })
    // Server asks us to reconnect (op 7) — the session survives for RESUME.
    sessions.push(1, { op: 7 })

    await sessions.waitForConnection(2)
    sessions.push(2, { op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    // RESUMED resets the backoff attempt counter and is not a message event.
    sessions.push(2, { op: 0, t: "RESUMED", d: {} })
    sessions.push(2, {
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      s: 5,
      d: { id: "m9", content: "back", group_openid: "GO" },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collector

    // The second connection resumed instead of re-identifying.
    const resumeCall = mockWsSend.mock.calls.find((c) => {
      try {
        return JSON.parse(c[1]).op === 6
      } catch {
        return false
      }
    })
    expect(resumeCall).toBeDefined()
    expect(JSON.parse(resumeCall![1]).d.session_id).toBe("s1")
    expect(out).toHaveLength(1)
    expect(out[0].t).toBe("GROUP_AT_MESSAGE_CREATE")
  }, 10000)

  it("exits immediately when already aborted", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    ctrl.abort()
    const client = startQQGateway({
      accessToken: async () => "t",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })
    const out: unknown[] = []
    for await (const d of client.dispatches) out.push(d)
    expect(out).toHaveLength(0)
    expect(mockWsOpen).not.toHaveBeenCalled()
  })
})
