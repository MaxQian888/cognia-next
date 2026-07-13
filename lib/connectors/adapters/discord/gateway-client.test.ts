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
import { startGatewayClient, type GatewayStatusEvent } from "./gateway-client"

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
  let closeHandler: ((event: { payload?: unknown }) => void) | null = null
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
      closeHandler = handler as (event: { payload?: unknown }) => void
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
    /** Legacy proxies emit `()` (undefined payload); upgraded ones `{code, reason}`. */
    triggerClose(payload?: unknown) {
      closeHandler?.({ payload })
    },
  }
}

/** Parsed frames sent through connectorsWsSend, filtered by op. */
function sentFrames(op: number): Array<{ op: number; d?: unknown }> {
  return mockWsSend.mock.calls
    .map(([, data]: [string, string]) => {
      try {
        return JSON.parse(data) as { op: number; d?: unknown }
      } catch {
        return null
      }
    })
    .filter((f): f is { op: number; d?: unknown } => f !== null && f.op === op)
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

  it("updatePresence returns false before connect and sends op 3 once connected", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    mockWsOpen.mockResolvedValue("ws-1")
    mockWsSend.mockResolvedValue(undefined)

    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "BOT_TOKEN",
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake-gateway",
      _backoffBaseMs: 1,
    })

    // Generator not iterated yet — no live connection.
    expect(await client.updatePresence("AI 1k")).toBe(false)

    const collectorDone = (async () => {
      for await (const _d of client.dispatches) {
        break
      }
    })()
    await session.waitForListeners()

    expect(await client.updatePresence("AI 1.2M $3.4")).toBe(true)
    const presenceFrame = mockWsSend.mock.calls
      .map(([, data]: [string, string]) => JSON.parse(data) as { op: number; d?: unknown })
      .find((f) => f.op === 3)
    expect(presenceFrame).toBeDefined()
    const d = presenceFrame!.d as { activities: Array<{ type: number; state: string }> }
    expect(d.activities[0]).toMatchObject({ type: 4, state: "AI 1.2M $3.4" })

    ctrl.abort()
    session.triggerClose()
    await collectorDone
  }, 10000)

  it("sends IDENTIFY after HELLO with correct token and default intents=46593", async () => {
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
    expect(payload.d.intents).toBe(46593)
  }, 10000)

  it("honours a custom intents bitmask in IDENTIFY", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "TOKEN",
      intents: 512,
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake-gateway",
      _backoffBaseMs: 1,
    })
    const collectDone = (async () => {
      for await (const _ of client.dispatches) break
    })()
    await session.waitForListeners()
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 30))
    ctrl.abort()
    await collectDone

    const identifyCall = mockWsSend.mock.calls.find((args: unknown[]) => {
      try {
        return (JSON.parse(args[1] as string) as { op: number }).op === 2
      } catch {
        return false
      }
    })
    const payload = JSON.parse(identifyCall![1] as string) as { d: { intents: number } }
    expect(payload.d.intents).toBe(512)
  }, 10000)

  it("yields INTERACTION_CREATE / reaction / delete dispatches, drops noise", async () => {
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

    const collectorDone = (async () => {
      for await (const d of client.dispatches) {
        dispatches.push(d as { t: string })
        if (dispatches.length >= 3) break
      }
    })()

    await session.waitForListeners()
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))

    // Noise dispatch — must be dropped, not yielded.
    session.push({ op: 0, t: "TYPING_START", s: 2, d: { channel_id: "c1" } })
    await new Promise((r) => setTimeout(r, 5))
    session.push({ op: 0, t: "INTERACTION_CREATE", s: 3, d: { type: 3, id: "i1", token: "tok" } })
    await new Promise((r) => setTimeout(r, 5))
    session.push({ op: 0, t: "MESSAGE_REACTION_ADD", s: 4, d: { message_id: "m1" } })
    await new Promise((r) => setTimeout(r, 5))
    session.push({ op: 0, t: "MESSAGE_DELETE", s: 5, d: { id: "m1", channel_id: "c1" } })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    expect(dispatches.map((d) => d.t)).toEqual([
      "INTERACTION_CREATE",
      "MESSAGE_REACTION_ADD",
      "MESSAGE_DELETE",
    ])
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

  // ── server-requested heartbeat (op 1) ──────────────────────────────────────

  it("answers a server-requested heartbeat (op 1) with an immediate op-1 send", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "T",
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake",
      _backoffBaseMs: 1,
    })
    const collectorDone = (async () => {
      for await (const _ of client.dispatches) break
    })()
    await session.waitForListeners()

    // Huge interval so the timer loop cannot fire during the test.
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    const beatsBefore = sentFrames(1).length

    session.push({ op: 1, d: null })
    await new Promise((r) => setTimeout(r, 20))

    expect(sentFrames(1).length).toBe(beatsBefore + 1)

    ctrl.abort()
    session.triggerClose()
    await collectorDone
  }, 10000)

  // ── zombie detection (missing HEARTBEAT_ACK) ───────────────────────────────

  it("closes the handle and reconnects when a heartbeat is never ACKed", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "T",
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake",
      _backoffBaseMs: 1,
    })
    const collectorDone = (async () => {
      for await (const _ of client.dispatches) {
        /* keep draining across the reconnect */
      }
    })()
    await session.waitForListeners()

    // Short interval; never send op 11 → the 2nd tick must detect the zombie.
    session.push({ op: 10, d: { heartbeat_interval: 15 } })

    // Zombie close (~≤45ms) + resume delay (500ms) + reopen.
    await new Promise((r) => setTimeout(r, 800))

    expect(mockWsClose).toHaveBeenCalled()
    expect(mockWsOpen.mock.calls.length).toBeGreaterThanOrEqual(2)

    ctrl.abort()
    session.triggerClose()
    await collectorDone
  }, 10000)

  it("keeps the connection alive while heartbeats are ACKed", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "T",
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake",
      _backoffBaseMs: 1,
    })
    const collectorDone = (async () => {
      for await (const _ of client.dispatches) break
    })()
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 25 } })
    // ACK faster than the beat cadence for ~150ms.
    for (let i = 0; i < 15; i++) {
      session.push({ op: 11 })
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(mockWsClose).not.toHaveBeenCalled()

    ctrl.abort()
    session.triggerClose()
    await collectorDone
  }, 10000)

  // ── close-code handling (fatal vs legacy) ──────────────────────────────────

  it("stops reconnecting on a fatal close code and surfaces it via onStatus", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const statuses: GatewayStatusEvent[] = []
    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "T",
      signal: ctrl.signal,
      onStatus: (s) => statuses.push(s),
      _gatewayUrl: "wss://fake",
      _backoffBaseMs: 1,
    })
    const collectorDone = (async () => {
      for await (const _ of client.dispatches) {
        /* drain */
      }
    })()
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    session.triggerClose({ code: 4014, reason: "Disallowed intent(s)." })

    // Generator must END on its own (no abort) — fatal codes never reconnect.
    await collectorDone
    await new Promise((r) => setTimeout(r, 50))

    expect(mockWsOpen).toHaveBeenCalledTimes(1)
    const fatal = statuses.find((s) => s.kind === "fatal_close")
    expect(fatal).toMatchObject({ code: 4014, reason: "disallowed intents" })
  }, 10000)

  it("treats a legacy close payload (undefined) as non-fatal and reconnects", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "T",
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake",
      _backoffBaseMs: 1,
    })
    const collectorDone = (async () => {
      for await (const _ of client.dispatches) {
        /* drain */
      }
    })()
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 10))
    session.triggerClose() // legacy `()` payload
    await new Promise((r) => setTimeout(r, 150))

    expect(mockWsOpen.mock.calls.length).toBeGreaterThanOrEqual(2)

    ctrl.abort()
    session.triggerClose()
    await collectorDone
  }, 10000)

  // ── status events: READY / RESUMED / connect_failed ────────────────────────

  it("emits resumed on RESUMED (reconnect-attempt counter reset path)", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const statuses: GatewayStatusEvent[] = []
    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "T",
      signal: ctrl.signal,
      onStatus: (s) => statuses.push(s),
      _gatewayUrl: "wss://fake",
      _backoffBaseMs: 1,
    })
    const collectorDone = (async () => {
      for await (const _ of client.dispatches) break
    })()
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 10))
    session.push({ op: 0, t: "RESUMED", s: 9, d: {} })
    await new Promise((r) => setTimeout(r, 10))

    expect(statuses.some((s) => s.kind === "resumed")).toBe(true)

    ctrl.abort()
    session.triggerClose()
    await collectorDone
  }, 10000)

  it("emits connect_failed with a growing consecutive-attempts count", async () => {
    mockListen.mockResolvedValue(jest.fn())
    mockWsOpen.mockRejectedValue(new Error("connect refused"))

    const statuses: GatewayStatusEvent[] = []
    const ctrl = new AbortController()
    const client = startGatewayClient({
      botToken: async () => "T",
      signal: ctrl.signal,
      onStatus: (s) => statuses.push(s),
      _gatewayUrl: "wss://fake",
      _backoffBaseMs: 1,
    })
    const collectorDone = (async () => {
      for await (const _ of client.dispatches) {
        /* never yields */
      }
    })()

    await new Promise((r) => setTimeout(r, 150))
    ctrl.abort()
    await collectorDone

    const attempts = statuses
      .filter((s): s is Extract<GatewayStatusEvent, { kind: "connect_failed" }> => s.kind === "connect_failed")
      .map((s) => s.attempts)
    expect(attempts.length).toBeGreaterThanOrEqual(3)
    expect(attempts.slice(0, 3)).toEqual([1, 2, 3])
  }, 10000)

  // ── MESSAGE_DELETE_BULK fan-out ────────────────────────────────────────────

  it("fans MESSAGE_DELETE_BULK out into individual MESSAGE_DELETE dispatches", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const dispatches: Array<{ t: string; d: unknown }> = []
    const client = startGatewayClient({
      botToken: async () => "T",
      signal: ctrl.signal,
      _gatewayUrl: "wss://fake",
      _backoffBaseMs: 1,
    })
    const collectorDone = (async () => {
      for await (const d of client.dispatches) {
        dispatches.push(d as { t: string; d: unknown })
        if (dispatches.length >= 2) break
      }
    })()
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 10))
    session.push({
      op: 0,
      t: "MESSAGE_DELETE_BULK",
      s: 4,
      d: { ids: ["m1", "m2"], channel_id: "c1", guild_id: "g1" },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    expect(dispatches.map((d) => d.t)).toEqual(["MESSAGE_DELETE", "MESSAGE_DELETE"])
    expect(dispatches.map((d) => (d.d as { id: string }).id)).toEqual(["m1", "m2"])
    expect(dispatches[0].d).toMatchObject({ channel_id: "c1", guild_id: "g1" })
  }, 10000)
})
