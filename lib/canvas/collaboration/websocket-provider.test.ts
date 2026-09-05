/**
 * @jest-environment jsdom
 */

import { CanvasWebSocketProvider, CanvasTransportUnavailableError } from "./websocket-provider"
import { CanvasCRDTStore, type CRDTOperation } from "./crdt-store"
import type { PlatformWebSocket, PlatformWebSocketHandlers } from "@/lib/network/platform-websocket"
import type { Participant } from "@/types/canvas/collaboration"

interface FakeSocket extends PlatformWebSocket {
  handlers: PlatformWebSocketHandlers
  send: jest.Mock
  close: jest.Mock
}

let opened: FakeSocket[] = []
let openCalls = 0
let rejectNextOpen: Error | null = null
/** Every open fails, which is what the retry budget actually bounds. */
let rejectAllOpens = false

/**
 * Stands in for `CollabClient.openCanvasStream`.
 *
 * Counting the calls is the point: the server's tickets are single use, so a
 * reconnect that did not come back through here would be reusing a spent one.
 */
function openSocket(handlers: PlatformWebSocketHandlers): Promise<PlatformWebSocket> {
  openCalls += 1
  if (rejectAllOpens) return Promise.reject(new Error("no ticket"))
  if (rejectNextOpen) {
    const error = rejectNextOpen
    rejectNextOpen = null
    return Promise.reject(error)
  }
  const socket: FakeSocket = {
    id: `socket-${openCalls}`,
    kind: "browser",
    handlers,
    send: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  }
  opened.push(socket)
  return Promise.resolve(socket)
}

const last = (): FakeSocket => opened[opened.length - 1]

function sentFrames(socket: FakeSocket): { type: string; data: Record<string, unknown> }[] {
  return socket.send.mock.calls.map((call) => JSON.parse(call[0] as string))
}

beforeEach(() => {
  jest.useFakeTimers()
  opened = []
  openCalls = 0
  rejectNextOpen = null
  rejectAllOpens = false
})

afterEach(() => {
  jest.useRealTimers()
})

const PARTICIPANT: Participant = {
  id: "p-self",
  name: "Self",
  color: "#000",
  lastActive: new Date(),
  isOnline: true,
}

function makeProvider(crdt = new CanvasCRDTStore()) {
  return new CanvasWebSocketProvider(crdt, {
    openSocket,
    reconnectAttempts: 2,
    reconnectInterval: 100,
    heartbeatInterval: 5_000,
  })
}

describe("CanvasWebSocketProvider connect / disconnect lifecycle", () => {
  it("refuses to open anything when no transport is configured", async () => {
    // The fail-closed state for an install with no collaboration server. It
    // must not fall back to a default host.
    const missing = new CanvasWebSocketProvider(new CanvasCRDTStore(), {})
    await expect(missing.connect("session-1", PARTICIPANT)).rejects.toBeInstanceOf(
      CanvasTransportUnavailableError
    )
    expect(openCalls).toBe(0)
  })

  it("opens through the factory and emits 'connected'", async () => {
    const p = makeProvider()
    const onConnect = jest.fn()
    p.on("connected", onConnect)
    await p.connect("session-1", PARTICIPANT)
    expect(p.getConnectionState()).toBe("connected")
    expect(onConnect).toHaveBeenCalled()
    expect(openCalls).toBe(1)
    expect(sentFrames(last())[0]).toMatchObject({ type: "presence", data: { action: "join" } })
  })

  it("emits 'error' and rejects when the socket cannot be opened", async () => {
    const p = makeProvider()
    const onError = jest.fn()
    p.on("error", onError)
    rejectNextOpen = new Error("ticket refused")
    await expect(p.connect("session-1", PARTICIPANT)).rejects.toBeDefined()
    expect(p.getConnectionState()).toBe("error")
    expect(onError).toHaveBeenCalled()
  })

  it("reports a transport error frame without tearing the session down", async () => {
    const p = makeProvider()
    await p.connect("session-1", PARTICIPANT)
    const onError = jest.fn()
    p.on("error", onError)
    last().handlers.onError?.("upstream reset")
    expect(onError).toHaveBeenCalled()
  })

  it("disconnect() sends a leave presence, closes, and emits 'disconnected'", async () => {
    const p = makeProvider()
    const onDisc = jest.fn()
    p.on("disconnected", onDisc)
    await p.connect("s", PARTICIPANT)
    const socket = last()
    p.disconnect()
    expect(socket.close).toHaveBeenCalled()
    expect(p.getConnectionState()).toBe("disconnected")
    expect(onDisc).toHaveBeenCalled()
    expect(sentFrames(socket).some((frame) => frame.data?.action === "leave")).toBe(true)
  })

  it("a deliberate disconnect does not schedule a reconnect", async () => {
    const p = makeProvider()
    await p.connect("s", PARTICIPANT)
    p.disconnect()
    // A close arriving after our own close must not restart the socket.
    last().handlers.onClose?.({ code: 1000, reason: null })
    await jest.advanceTimersByTimeAsync(500)
    expect(openCalls).toBe(1)
  })
})

describe("broadcast helpers buffer when disconnected", () => {
  it("queues frames raised before the socket exists, then flushes them", async () => {
    const p = makeProvider()
    const op: CRDTOperation = { id: "op-1", update: "AQE=", origin: "p-self", timestamp: 1 }
    p.broadcastOperation(op)
    p.requestSync()
    expect(openCalls).toBe(0)

    await p.connect("s", PARTICIPANT)
    expect(last().send).toHaveBeenCalled()
  })

  it("broadcast helpers send when connected", async () => {
    const p = makeProvider()
    await p.connect("s1", PARTICIPANT)
    last().send.mockClear()
    const op: CRDTOperation = { id: "op-1", update: "AQE=", origin: "p-self", timestamp: 1 }
    p.broadcastOperation(op)
    p.broadcastCursor({ participantId: "p-self", line: 0, column: 0 } as unknown as never)
    p.broadcastSelection({ start: 0, end: 1 } as unknown as never)
    p.requestSync()
    expect(last().send).toHaveBeenCalledTimes(4)
  })

  it("a frame the socket refuses is queued rather than dropped", async () => {
    // An edit that fails to send is an edit the user made. Losing it silently
    // is worse than delivering it late.
    const p = makeProvider()
    await p.connect("s1", PARTICIPANT)
    const socket = last()
    socket.send.mockRejectedValueOnce(new Error("socket gone"))
    p.broadcastOperation({ id: "op-1", update: "AQE=", origin: "p-self", timestamp: 1 })
    await Promise.resolve()

    socket.handlers.onClose?.({ code: 1006, reason: null })
    await jest.advanceTimersByTimeAsync(150)
    expect(sentFrames(last()).some((frame) => frame.type === "operation")).toBe(true)
  })
})

describe("incoming message handling", () => {
  async function connectFresh() {
    const crdt = new CanvasCRDTStore()
    crdt.createSession("s1", "")
    const p = makeProvider(crdt)
    await p.connect("s1", PARTICIPANT)
    return { p, crdt, socket: last() }
  }

  it("handles remote cursor messages from other participants", async () => {
    const { p, socket } = await connectFresh()
    const onMove = jest.fn()
    p.on("cursor-moved", onMove)
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "cursor",
        sessionId: "s1",
        participantId: "p-other",
        data: { line: 1, column: 1 },
        timestamp: 1,
      })
    )
    expect(onMove).toHaveBeenCalled()
  })

  it("ignores remote cursor messages from self", async () => {
    const { p, socket } = await connectFresh()
    const onMove = jest.fn()
    p.on("cursor-moved", onMove)
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "cursor",
        sessionId: "s1",
        participantId: "p-self",
        data: {},
        timestamp: 1,
      })
    )
    expect(onMove).not.toHaveBeenCalled()
  })

  it("handles remote selection updates", async () => {
    const { p, socket } = await connectFresh()
    const onSel = jest.fn()
    p.on("selection-changed", onSel)
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "selection",
        sessionId: "s1",
        participantId: "p-other",
        data: { start: 0, end: 5 },
        timestamp: 1,
      })
    )
    expect(onSel).toHaveBeenCalled()
  })

  it("handles remote operation messages and applies them via the CRDT store", async () => {
    const { p, crdt, socket } = await connectFresh()
    const onUpdate = jest.fn()
    p.on("content-updated", onUpdate)
    const apply = jest.spyOn(crdt, "applyRemoteUpdate").mockImplementation(() => {})
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "operation",
        sessionId: "s1",
        participantId: "p-other",
        // A Yjs update is opaque bytes, base64 for this transport. The old
        // shape carried `position` / `length` / a vector clock, which is what
        // made an unvalidated frame reach `String.prototype.slice`.
        data: { id: "op-1", update: "AQE=", origin: "p-other", timestamp: 1 },
        timestamp: 1,
      })
    )
    expect(apply).toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalled()
  })

  it("drops an operation frame that is not shaped like one", async () => {
    const { p, crdt, socket } = await connectFresh()
    const onUpdate = jest.fn()
    p.on("content-updated", onUpdate)
    const apply = jest.spyOn(crdt, "applyRemoteUpdate").mockImplementation(() => {})
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "operation",
        sessionId: "s1",
        participantId: "p-other",
        data: { nonsense: true },
        timestamp: 1,
      })
    )
    expect(apply).not.toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("ignores remote operations from self", async () => {
    const { crdt, socket } = await connectFresh()
    const apply = jest.spyOn(crdt, "applyRemoteUpdate").mockImplementation(() => {})
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "operation",
        sessionId: "s1",
        participantId: "p-self",
        data: { id: "op-1", update: "AQE=", origin: "p-self", timestamp: 1 },
        timestamp: 1,
      })
    )
    expect(apply).not.toHaveBeenCalled()
  })

  it("emits participant-joined on presence join", async () => {
    const { p, socket } = await connectFresh()
    const onJoin = jest.fn()
    p.on("participant-joined", onJoin)
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "presence",
        sessionId: "s1",
        participantId: "p-other",
        data: { action: "join", participant: PARTICIPANT },
        timestamp: 1,
      })
    )
    expect(onJoin).toHaveBeenCalled()
  })

  it("emits participant-left on presence leave", async () => {
    const { p, socket } = await connectFresh()
    const onLeft = jest.fn()
    p.on("participant-left", onLeft)
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "presence",
        sessionId: "s1",
        participantId: "p-other",
        data: { action: "leave" },
        timestamp: 1,
      })
    )
    expect(onLeft).toHaveBeenCalled()
  })

  it("merges a sync snapshot into the session it is already in", async () => {
    const { crdt, socket } = await connectFresh()
    const apply = jest.spyOn(crdt, "applySnapshot").mockImplementation(() => true)
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "sync",
        sessionId: "s1",
        participantId: "server",
        data: { action: "response", state: "AQE=" },
        timestamp: 1,
      })
    )
    // Bound to THIS provider's session, so a frame cannot name another one.
    expect(apply).toHaveBeenCalledWith("s1", "AQE=")
  })

  it("applies every frame of a multi-part catch-up", async () => {
    // The server sends the baseline and then each later update as its own
    // frame, because it does not link Yjs and cannot merge them itself.
    const { crdt, socket } = await connectFresh()
    const apply = jest.spyOn(crdt, "applySnapshot").mockImplementation(() => true)
    for (const state of ["AQE=", "AgI=", "AwM="]) {
      socket.handlers.onMessage?.(
        JSON.stringify({
          type: "sync",
          sessionId: "s1",
          participantId: "server",
          data: { action: "response", state },
          timestamp: 1,
        })
      )
    }
    expect(apply).toHaveBeenCalledTimes(3)
  })

  it("ignores a sync frame whose state is not a string", async () => {
    // `deserializeState` used to `JSON.parse` whatever arrived and install the
    // session, participants and permissions it described.
    const { crdt, socket } = await connectFresh()
    const apply = jest.spyOn(crdt, "applySnapshot").mockImplementation(() => true)
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "sync",
        sessionId: "s1",
        participantId: "p-other",
        data: { action: "response", state: { session: { id: "hijacked" } } },
        timestamp: 1,
      })
    )
    expect(apply).not.toHaveBeenCalled()
  })

  it("survives an invalid JSON body without emitting an error event", async () => {
    const { p, socket } = await connectFresh()
    const onErr = jest.fn()
    p.on("error", onErr)
    socket.handlers.onMessage?.("{not json")
    expect(onErr).not.toHaveBeenCalled()
  })

  it("emits 'error' when message type is 'error'", async () => {
    const { p, socket } = await connectFresh()
    const onErr = jest.fn()
    p.on("error", onErr)
    socket.handlers.onMessage?.(
      JSON.stringify({
        type: "error",
        sessionId: "s1",
        participantId: "p-other",
        data: { reason: "x" },
        timestamp: 1,
      })
    )
    expect(onErr).toHaveBeenCalled()
  })
})

describe("event subscription disposer", () => {
  it("removes the listener when the disposer is invoked", async () => {
    const p = makeProvider()
    const onConnect = jest.fn()
    const off = p.on("connected", onConnect)
    off()
    await p.connect("s1", PARTICIPANT)
    expect(onConnect).not.toHaveBeenCalled()
  })
})

describe("reconnect logic", () => {
  it("opens a brand new socket on each retry", async () => {
    // The whole reason the provider takes a factory. A ticket is single use,
    // so replaying the first one would have failed every reconnect.
    const p = makeProvider()
    await p.connect("s1", PARTICIPANT)
    last().handlers.onClose?.({ code: 1006, reason: null })
    expect(p.getConnectionState()).toBe("reconnecting")
    await jest.advanceTimersByTimeAsync(150)
    expect(openCalls).toBe(2)
  })

  it("reconnects as the same participant rather than a placeholder", async () => {
    // It used to rejoin as a participant literally named "Reconnecting..." in
    // grey, which is what every other peer then saw in the roster.
    const p = makeProvider()
    await p.connect("s1", PARTICIPANT)
    last().handlers.onClose?.({ code: 1006, reason: null })
    await jest.advanceTimersByTimeAsync(150)
    const join = sentFrames(last()).find((frame) => frame.data?.action === "join")
    expect(join?.data.participant).toMatchObject({ id: "p-self", name: "Self" })
  })

  it("asks for what it missed after reconnecting", async () => {
    const p = makeProvider()
    await p.connect("s1", PARTICIPANT)
    last().handlers.onClose?.({ code: 1006, reason: null })
    await jest.advanceTimersByTimeAsync(150)
    expect(sentFrames(last()).some((frame) => frame.type === "sync")).toBe(true)
  })

  it("emits 'disconnected' after exhausting reconnect attempts", async () => {
    const p = makeProvider()
    const onDisc = jest.fn()
    p.on("disconnected", onDisc)
    await p.connect("s1", PARTICIPANT)

    // The budget bounds CONSECUTIVE failures, so the retries have to actually
    // fail. A server that accepts the socket and drops it again is a different
    // situation, covered below.
    rejectAllOpens = true
    last().handlers.onClose?.({ code: 1006, reason: null })
    await jest.advanceTimersByTimeAsync(150)
    await jest.advanceTimersByTimeAsync(150)
    await jest.advanceTimersByTimeAsync(150)

    expect(onDisc).toHaveBeenCalled()
    // One successful open, then exactly the two the budget allows.
    expect(openCalls).toBe(3)
  })

  it("a reconnect that succeeds restores the full retry budget", async () => {
    // Otherwise a long session that survived two blips hours apart would
    // refuse to recover from the third.
    const p = makeProvider()
    await p.connect("s1", PARTICIPANT)
    for (let blip = 0; blip < 4; blip += 1) {
      last().handlers.onClose?.({ code: 1006, reason: null })
      await jest.advanceTimersByTimeAsync(150)
    }
    expect(p.getConnectionState()).toBe("connected")
    expect(openCalls).toBe(5)
  })
})

describe("heartbeat", () => {
  it("sends a heartbeat presence message on the configured interval", async () => {
    const p = makeProvider()
    await p.connect("s1", PARTICIPANT)
    last().send.mockClear()
    await jest.advanceTimersByTimeAsync(5_000)
    expect(sentFrames(last()).some((frame) => frame.data?.action === "heartbeat")).toBe(true)
  })

  it("stops beating once disconnected", async () => {
    const p = makeProvider()
    await p.connect("s1", PARTICIPANT)
    const socket = last()
    p.disconnect()
    socket.send.mockClear()
    await jest.advanceTimersByTimeAsync(15_000)
    expect(socket.send).not.toHaveBeenCalled()
  })
})
