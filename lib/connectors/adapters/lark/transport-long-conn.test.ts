/**
 * Long-connection transport tests.
 *
 * Mocks: connectorsWsOpen, connectorsWsSend, connectorsWsClose,
 * connectorsHttpRequest, @tauri-apps/api/event listen.
 *
 * Pattern: POST wsServer → connect WS → push event_push frames → assert yield;
 * push heartbeat_req → assert heartbeat_rsp sent; abort → stops.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"

const mockListen = listen as jest.Mock
const mockWsOpen = connectorsWsOpen as jest.Mock
const mockWsSend = connectorsWsSend as jest.Mock
const mockWsClose = connectorsWsClose as jest.Mock
const mockHttp = connectorsHttpRequest as jest.Mock

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: jest.fn(),
  connectorsWsSend: jest.fn(),
  connectorsWsClose: jest.fn(),
  connectorsHttpRequest: jest.fn(),
}))

function createFakeWsSession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  let closeHandler: (() => void) | null = null
  let listenCallCount = 0
  let handlersResolve: () => void = () => {}
  const handlersReadyP = new Promise<void>((r) => {
    handlersResolve = r
  })

  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    listenCallCount++
    if ((eventName as string).endsWith("/message")) {
      messageHandler = handler as (event: { payload: string }) => void
    } else if ((eventName as string).endsWith("/close")) {
      closeHandler = handler as () => void
    }
    if (listenCallCount >= 2) handlersResolve()
    return jest.fn()
  })

  return {
    listenImpl,
    waitForListeners: () => handlersReadyP,
    push(payload: unknown) {
      messageHandler?.({ payload: JSON.stringify(payload) })
    },
    triggerClose() {
      closeHandler?.()
    },
  }
}

function makeWsServerOkResp(url = "wss://fake-lark-ws") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, data: { url } }),
  }
}

function makeLarkEnvelope(msgId: string) {
  return {
    schema: "2.0",
    header: { event_id: `evt_${msgId}`, event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_user_001" } },
      message: {
        message_id: msgId,
        chat_id: "oc_chat_001",
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"hello"}',
      },
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockWsOpen.mockResolvedValue("lark-handle-id")
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
  mockHttp.mockResolvedValue(makeWsServerOkResp())
})

describe("startLarkLongConn", () => {
  it("yields events from event_push frames", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const { startLarkLongConn } = await import("./transport-long-conn")

    const ctrl = new AbortController()
    const yielded: string[] = []

    const collectorDone = (async () => {
      for await (const envelope of startLarkLongConn({
        tenantAccessToken: async () => "tat-xxx",
        signal: ctrl.signal,
        _wsServerUrl: "https://fake-ws-server",
        _heartbeatIntervalMs: 100_000, // prevent timer fires during test
        _backoffBaseMs: 1,
      })) {
        yielded.push(envelope.event.message.message_id)
        if (yielded.length >= 2) break
      }
    })()

    await session.waitForListeners()

    session.push({ type: "event_push", event: makeLarkEnvelope("om_001") })
    await new Promise((r) => setTimeout(r, 10))
    session.push({ type: "event_push", event: makeLarkEnvelope("om_002") })
    await new Promise((r) => setTimeout(r, 10))

    ctrl.abort()
    await collectorDone

    expect(yielded).toEqual(["om_001", "om_002"])
  }, 10000)

  it("replies heartbeat_rsp to heartbeat_req", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const { startLarkLongConn } = await import("./transport-long-conn")

    const ctrl = new AbortController()
    const yielded: string[] = []

    const collectorDone = (async () => {
      for await (const envelope of startLarkLongConn({
        tenantAccessToken: async () => "tat-xxx",
        signal: ctrl.signal,
        _wsServerUrl: "https://fake-ws-server",
        _heartbeatIntervalMs: 100_000,
        _backoffBaseMs: 1,
      })) {
        yielded.push(envelope.event.message.message_id)
        break
      }
    })()

    await session.waitForListeners()

    // Trigger a server heartbeat probe
    session.push({ type: "heartbeat_req" })
    await new Promise((r) => setTimeout(r, 20))

    // Then push a real event so we have something to yield and break
    session.push({ type: "event_push", event: makeLarkEnvelope("om_hb") })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    // Assert heartbeat_rsp was sent
    const rspCalls = mockWsSend.mock.calls.filter((args: unknown[]) => {
      try {
        const p = JSON.parse(args[1] as string) as { type?: string }
        return p.type === "heartbeat_rsp"
      } catch {
        return false
      }
    })
    expect(rspCalls.length).toBeGreaterThanOrEqual(1)
  }, 10000)

  it("stops immediately when signal is pre-aborted", async () => {
    mockListen.mockResolvedValue(jest.fn())

    const { startLarkLongConn } = await import("./transport-long-conn")

    const ctrl = new AbortController()
    ctrl.abort()

    const collected: unknown[] = []
    for await (const e of startLarkLongConn({
      tenantAccessToken: async () => "tat-xxx",
      signal: ctrl.signal,
      _heartbeatIntervalMs: 100_000,
      _backoffBaseMs: 1,
    })) {
      collected.push(e)
    }

    expect(collected).toHaveLength(0)
  })
})
