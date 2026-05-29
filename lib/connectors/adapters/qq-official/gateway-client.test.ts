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
