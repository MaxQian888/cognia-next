/**
 * Tests for the Discord Gateway client.
 *
 * Approach: mock Tauri connectorsWsOpen/Send/Close and @tauri-apps/api/event.
 * Drive HELLO → IDENTIFY → READY → MESSAGE_CREATE sequence and assert the
 * dispatches generator yields the expected events.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import { startGatewayClient } from "./gateway-client"

const mockListen = listen as jest.Mock
const mockWsOpen = connectorsWsOpen as jest.Mock
const mockWsSend = connectorsWsSend as jest.Mock
const mockWsClose = connectorsWsClose as jest.Mock

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: jest.fn(),
  connectorsWsSend: jest.fn(),
  connectorsWsClose: jest.fn(),
}))

// ---------------------------------------------------------------------------
// Fake session factory
// ---------------------------------------------------------------------------

/**
 * Creates a controllable fake WS session. Use:
 * - listenImpl: set as `mockListen.mockImplementation`
 * - push(payload): deliver a Gateway JSON frame to the message handler
 * - waitForListeners(): resolves once both message + close handlers are set
 */
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  mockWsOpen.mockResolvedValue("ws-handle-id")
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessageCreate(id: string, content: string) {
  return {
    op: 0,
    t: "MESSAGE_CREATE",
    s: parseInt(id, 10),
    d: {
      id,
      content,
      channel_id: "chan-1",
      author: { id: "user-1", username: "Alice" },
      timestamp: "2024-05-05T12:00:00.000000+00:00",
      attachments: [],
      mentions: [],
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startGatewayClient", () => {
  it("drives HELLO → IDENTIFY → READY → 2 MESSAGE_CREATE and yields both", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const dispatches: Array<{ t: string }> = []

    const client = startGatewayClient({
      botToken: async () => "BOT_TOKEN",
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake-gateway",
      _backoffBaseMs: 1,
    })

    // Collect dispatches in the background; break after 2
    const collectorDone = (async () => {
      for await (const d of client.dispatches) {
        dispatches.push(d as { t: string })
        if (dispatches.length >= 2) break
      }
    })()

    // Wait until WS listeners are registered (generator is running)
    await session.waitForListeners()

    // HELLO → triggers IDENTIFY
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))

    // READY
    session.push({
      op: 0,
      t: "READY",
      s: 1,
      d: {
        user: { id: "bot-id-123" },
        session_id: "sess-abc",
        resume_gateway_url: "wss://resume",
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    // Two MESSAGE_CREATE dispatches
    session.push(makeMessageCreate("101", "hello"))
    await new Promise((r) => setTimeout(r, 5))
    session.push(makeMessageCreate("102", "world"))
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    expect(dispatches).toHaveLength(2)
    expect(dispatches[0].t).toBe("MESSAGE_CREATE")
    expect(dispatches[1].t).toBe("MESSAGE_CREATE")
  }, 10000)

  it("sends IDENTIFY after HELLO with correct token and intents=33281", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()

    const client = startGatewayClient({
      botToken: async () => "MY_SECRET_TOKEN",
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake-gateway",
      _backoffBaseMs: 1,
    })

    // Start iterating to drive the generator
    const collectDone = (async () => {
      for await (const _ of client.dispatches) break
    })()

    // Wait for listeners to register
    await session.waitForListeners()

    // Send HELLO
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 30))

    ctrl.abort()
    await collectDone

    // Find the IDENTIFY call (op 2)
    const identifyCall = mockWsSend.mock.calls.find((args: unknown[]) => {
      try {
        const p = JSON.parse(args[1] as string) as { op: number }
        return p.op === 2
      } catch {
        return false
      }
    })

    expect(identifyCall).toBeDefined()
    const payload = JSON.parse(identifyCall![1] as string) as {
      d: { token: string; intents: number }
    }
    expect(payload.d.token).toBe("MY_SECRET_TOKEN")
    expect(payload.d.intents).toBe(33281)
  }, 10000)

  it("stops immediately when signal is pre-aborted", async () => {
    mockListen.mockResolvedValue(jest.fn())
    mockWsOpen.mockImplementation(() => new Promise<string>(() => {})) // never resolves

    const ctrl = new AbortController()
    ctrl.abort()

    const client = startGatewayClient({
      botToken: async () => "TOKEN",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const collected: unknown[] = []
    for await (const d of client.dispatches) collected.push(d)

    expect(collected).toHaveLength(0)
  })
})
