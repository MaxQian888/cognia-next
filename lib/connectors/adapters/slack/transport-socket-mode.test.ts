/**
 * Socket Mode transport tests.
 *
 * Mocks: connectorsWsOpen, connectorsWsSend, connectorsWsClose,
 * connectorsHttpRequest, @tauri-apps/api/event listen.
 *
 * Pattern: drive hello → events_api → disconnect → reconnect;
 * assert ACK envelope_ids and generator yields.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import { startSocketMode, type SocketModeDelivery } from "./transport-socket-mode"

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

// ---------------------------------------------------------------------------
// Fake WS session factory
// ---------------------------------------------------------------------------

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
  mockWsOpen.mockResolvedValue("sm-handle-id")
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
  mockHttp.mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, url: "wss://fake-socket-mode" }),
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startSocketMode", () => {
  it("yields events from events_api frames and ACKs with envelope_id", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const yielded: SocketModeDelivery[] = []

    const collectorDone = (async () => {
      for await (const delivery of startSocketMode({
        appToken: async () => "xapp-token",
        signal: ctrl.signal,
        _connectionsOpenUrl: "https://fake-connections-open",
        _backoffBaseMs: 1,
      })) {
        yielded.push(delivery)
        if (yielded.length >= 2) break
      }
    })()

    await session.waitForListeners()

    // Drive hello
    session.push({ type: "hello", num_connections: 1 })
    await new Promise((r) => setTimeout(r, 10))

    // First events_api frame
    session.push({
      type: "events_api",
      envelope_id: "env-001",
      payload: {
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "hello",
          ts: "1714900000.000001",
          channel_type: "channel",
        },
      },
      accepts_response_payload: false,
    })
    await new Promise((r) => setTimeout(r, 10))

    // Second events_api frame
    session.push({
      type: "events_api",
      envelope_id: "env-002",
      payload: {
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "world",
          ts: "1714900001.000001",
          channel_type: "channel",
        },
      },
      accepts_response_payload: false,
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    expect(yielded).toHaveLength(2)
    expect(yielded[0].kind).toBe("event")
    expect(yielded[1].kind).toBe("event")
    expect((yielded[0] as { envelope: { type: string } }).envelope.type).toBe("event_callback")
    expect((yielded[1] as { envelope: { type: string } }).envelope.type).toBe("event_callback")

    // Assert ACKs were sent for both envelope_ids
    const ackCalls = mockWsSend.mock.calls.filter((args: unknown[]) => {
      try {
        const p = JSON.parse(args[1] as string) as { envelope_id?: string }
        return p.envelope_id !== undefined
      } catch {
        return false
      }
    })
    expect(ackCalls).toHaveLength(2)
    const ackIds = ackCalls.map((c: unknown[]) => {
      const p = JSON.parse(c[1] as string) as { envelope_id: string }
      return p.envelope_id
    })
    expect(ackIds).toContain("env-001")
    expect(ackIds).toContain("env-002")
  }, 15000)

  it("calls apps.connections.open once per WS connection attempt", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const yielded: unknown[] = []

    const collectorDone = (async () => {
      for await (const e of startSocketMode({
        appToken: async () => "xapp-token",
        signal: ctrl.signal,
        _connectionsOpenUrl: "https://fake-connections-open",
        _backoffBaseMs: 1,
      })) {
        yielded.push(e)
        if (yielded.length >= 1) break
      }
    })()

    await session.waitForListeners()

    session.push({ type: "hello" })
    await new Promise((r) => setTimeout(r, 10))

    session.push({
      type: "events_api",
      envelope_id: "env-once",
      payload: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "one",
          ts: "1714900000.000001",
          channel_type: "channel",
        },
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    // apps.connections.open should have been called at least once
    const httpCalls = mockHttp.mock.calls.filter((c: unknown[]) => {
      const url = (c[0] as { url?: string })?.url ?? ""
      return url.includes("fake-connections-open")
    })
    expect(httpCalls.length).toBeGreaterThanOrEqual(1)
    expect(yielded.length).toBeGreaterThanOrEqual(1)
  }, 10000)

  it("ACKs and yields interactive + slash_commands envelopes, and fires onHello", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const yielded: SocketModeDelivery[] = []
    const onHello = jest.fn()

    const collectorDone = (async () => {
      for await (const delivery of startSocketMode({
        appToken: async () => "xapp-token",
        signal: ctrl.signal,
        onHello,
        _connectionsOpenUrl: "https://fake-connections-open",
        _backoffBaseMs: 1,
      })) {
        yielded.push(delivery)
        if (yielded.length >= 2) break
      }
    })()

    await session.waitForListeners()

    session.push({ type: "hello", num_connections: 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(onHello).toHaveBeenCalledTimes(1)

    // interactive envelope (A2UI button click)
    session.push({
      type: "interactive",
      envelope_id: "env-int",
      payload: {
        type: "block_actions",
        user: { id: "U1" },
        actions: [{ action_id: "a1", type: "button", value: "v" }],
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    // slash_commands envelope
    session.push({
      type: "slash_commands",
      envelope_id: "env-slash",
      payload: { command: "/x", text: "y", channel_id: "C1", user_id: "U1" },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    expect(yielded).toHaveLength(2)
    expect(yielded[0]).toMatchObject({
      kind: "interactive",
      payload: { type: "block_actions" },
    })
    expect(yielded[1]).toMatchObject({
      kind: "slash_command",
      payload: { command: "/x" },
    })

    // BOTH envelope kinds must have been acked with their envelope_id.
    const ackIds = mockWsSend.mock.calls
      .map((args: unknown[]) => {
        try {
          return (JSON.parse(args[1] as string) as { envelope_id?: string }).envelope_id
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
    expect(ackIds).toContain("env-int")
    expect(ackIds).toContain("env-slash")
  }, 15000)

  it("stops immediately when signal is pre-aborted", async () => {
    mockListen.mockResolvedValue(jest.fn())

    const ctrl = new AbortController()
    ctrl.abort()

    const collected: unknown[] = []
    for await (const e of startSocketMode({
      appToken: async () => "xapp-token",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })) {
      collected.push(e)
    }

    expect(collected).toHaveLength(0)
  })
})
