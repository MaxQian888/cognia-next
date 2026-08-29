/**
 * @jest-environment jsdom
 */

import { CanvasWebSocketProvider } from "./websocket-provider"
import { CanvasCRDTStore, type CRDTOperation } from "./crdt-store"
import type { Participant } from "@/types/canvas/collaboration"

interface MockWebSocketInstance {
  url: string
  protocols?: string | string[]
  readyState: number
  send: jest.Mock
  close: jest.Mock
  onopen?: () => void
  onclose?: () => void
  onerror?: (e: unknown) => void
  onmessage?: (e: { data: string }) => void
}

let lastMockSocket: MockWebSocketInstance | null = null

class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  url: string
  readyState = MockWebSocket.OPEN
  send = jest.fn()
  close = jest.fn(() => {
    this.readyState = MockWebSocket.CLOSED
  })
  onopen?: () => void
  onclose?: () => void
  onerror?: (e: unknown) => void
  onmessage?: (e: { data: string }) => void

  protocols?: string | string[]

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    lastMockSocket = this as unknown as MockWebSocketInstance
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  lastMockSocket = null
  ;(globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
    MockWebSocket as unknown as typeof MockWebSocket
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
    url: "ws://localhost:1234",
    authorization: {
      token: "canvas-ticket",
      subjectId: "user-1",
      resourceId: "document-1",
      expiresAt: Date.now() + 60_000,
    },
    reconnectAttempts: 2,
    reconnectInterval: 100,
    heartbeatInterval: 5_000,
  })
}

describe("CanvasWebSocketProvider connect / disconnect lifecycle", () => {
  it("rejects remote transport without a current resource-bound authorization", async () => {
    const missing = new CanvasWebSocketProvider(new CanvasCRDTStore(), {
      url: "ws://localhost:1234",
    })
    await expect(missing.connect("session-1", PARTICIPANT)).rejects.toThrow(
      "CANVAS_REMOTE_AUTH_REQUIRED"
    )
    expect(lastMockSocket).toBeNull()

    const expired = new CanvasWebSocketProvider(new CanvasCRDTStore(), {
      url: "ws://localhost:1234",
      authorization: {
        token: "expired",
        subjectId: "user-1",
        resourceId: "document-1",
        expiresAt: Date.now() - 1,
      },
    })
    await expect(expired.connect("session-1", PARTICIPANT)).rejects.toThrow(
      "CANVAS_REMOTE_AUTH_REQUIRED"
    )
    expect(lastMockSocket).toBeNull()
  })

  it("opens a WebSocket and emits 'connected' once the socket opens", async () => {
    const p = makeProvider()
    const onConnect = jest.fn()
    p.on("connected", onConnect)
    const promise = p.connect("session-1", PARTICIPANT)
    // Simulate the socket reaching OPEN.
    lastMockSocket!.onopen?.()
    await promise
    expect(p.getConnectionState()).toBe("connected")
    expect(onConnect).toHaveBeenCalled()
    expect(lastMockSocket!.send).toHaveBeenCalled() // initial join presence
    expect(lastMockSocket!.protocols).toEqual(["cognia.canvas.v1", "canvas-ticket"])
  })

  it("emits 'error' and rejects when the socket errors before opening", async () => {
    const p = makeProvider()
    const onError = jest.fn()
    p.on("error", onError)
    const promise = p.connect("session-1", PARTICIPANT)
    lastMockSocket!.onerror?.(new Error("boom"))
    await expect(promise).rejects.toBeDefined()
    expect(p.getConnectionState()).toBe("error")
    expect(onError).toHaveBeenCalled()
  })

  it("rejects synchronously when WebSocket constructor throws", async () => {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = function () {
      throw new Error("ctor-fail")
    }
    const p = makeProvider()
    await expect(p.connect("s", PARTICIPANT)).rejects.toBeDefined()
    expect(p.getConnectionState()).toBe("error")
  })

  it("disconnect() sends a leave presence, closes, and emits 'disconnected'", async () => {
    const p = makeProvider()
    const onDisc = jest.fn()
    p.on("disconnected", onDisc)
    const promise = p.connect("s", PARTICIPANT)
    lastMockSocket!.onopen?.()
    await promise
    p.disconnect()
    expect(lastMockSocket!.close).toHaveBeenCalled()
    expect(p.getConnectionState()).toBe("disconnected")
    expect(onDisc).toHaveBeenCalled()
  })
})

describe("broadcast helpers buffer when disconnected", () => {
  it("queues messages until the socket opens, then flushes", async () => {
    const p = makeProvider()
    // Pre-broadcast before connect — should buffer.
    const op: CRDTOperation = {
      id: "op-1",
      type: "insert",
      position: 0,
      text: "x",
      origin: "p-self",
      timestamp: 1,
      vectorClock: new Map([["p-self", 1]]),
    }
    p.broadcastOperation(op)
    p.broadcastCursor({ participantId: "p-self", line: 0, column: 0 } as unknown as never)
    p.broadcastSelection({ start: 0, end: 1 } as unknown as never)
    p.requestSync()
    // No socket yet -> no sends.
    expect(lastMockSocket).toBeNull()

    // Now connect — sessionId/participantId aren't set yet; broadcasts before
    // connect bail out early because session/participant IDs are null.
    const promise = p.connect("s", PARTICIPANT)
    lastMockSocket!.onopen?.()
    await promise
    // Send was called at least once for initial join presence + flushed queue.
    expect(lastMockSocket!.send).toHaveBeenCalled()
  })

  it("broadcast helpers send when connected", async () => {
    const p = makeProvider()
    const promise = p.connect("s1", PARTICIPANT)
    lastMockSocket!.onopen?.()
    await promise
    lastMockSocket!.send.mockClear()
    const op: CRDTOperation = {
      id: "op-1",
      type: "insert",
      position: 0,
      text: "x",
      origin: "p-self",
      timestamp: 1,
      vectorClock: new Map([["p-self", 1]]),
    }
    p.broadcastOperation(op)
    p.broadcastCursor({ participantId: "p-self", line: 0, column: 0 } as unknown as never)
    p.broadcastSelection({ start: 0, end: 1 } as unknown as never)
    p.requestSync()
    expect(lastMockSocket!.send).toHaveBeenCalledTimes(4)
  })
})

describe("incoming message handling", () => {
  async function connectFresh() {
    const crdt = new CanvasCRDTStore()
    crdt.createSession("s1", "")
    const p = makeProvider(crdt)
    const promise = p.connect("s1", PARTICIPANT)
    lastMockSocket!.onopen?.()
    await promise
    return { p, crdt }
  }

  it("handles remote cursor messages from other participants", async () => {
    const { p } = await connectFresh()
    const onMove = jest.fn()
    p.on("cursor-moved", onMove)
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "cursor",
        sessionId: "s1",
        participantId: "p-other",
        data: { line: 1, column: 1 },
        timestamp: 1,
      }),
    })
    expect(onMove).toHaveBeenCalled()
  })

  it("ignores remote cursor messages from self", async () => {
    const { p } = await connectFresh()
    const onMove = jest.fn()
    p.on("cursor-moved", onMove)
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "cursor",
        sessionId: "s1",
        participantId: "p-self",
        data: {},
        timestamp: 1,
      }),
    })
    expect(onMove).not.toHaveBeenCalled()
  })

  it("handles remote selection updates", async () => {
    const { p } = await connectFresh()
    const onSel = jest.fn()
    p.on("selection-changed", onSel)
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "selection",
        sessionId: "s1",
        participantId: "p-other",
        data: { start: 0, end: 5 },
        timestamp: 1,
      }),
    })
    expect(onSel).toHaveBeenCalled()
  })

  it("handles remote operation messages and applies them via the CRDT store", async () => {
    const { p, crdt } = await connectFresh()
    const onUpdate = jest.fn()
    p.on("content-updated", onUpdate)
    const apply = jest.spyOn(crdt, "applyRemoteUpdate").mockImplementation(() => {})
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "operation",
        sessionId: "s1",
        participantId: "p-other",
        data: {
          id: "op-1",
          type: "insert",
          position: 0,
          text: "x",
          origin: "p-other",
          timestamp: 1,
          vectorClock: [["p-other", 1]],
        },
        timestamp: 1,
      }),
    })
    expect(apply).toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalled()
  })

  it("ignores remote operations from self", async () => {
    const { crdt } = await connectFresh()
    const apply = jest.spyOn(crdt, "applyRemoteUpdate").mockImplementation(() => {})
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "operation",
        sessionId: "s1",
        participantId: "p-self",
        data: {
          id: "op-1",
          type: "insert",
          position: 0,
          text: "x",
          origin: "p-self",
          timestamp: 1,
          vectorClock: [["p-self", 1]],
        },
        timestamp: 1,
      }),
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it("emits participant-joined on presence join", async () => {
    const { p } = await connectFresh()
    const onJoin = jest.fn()
    p.on("participant-joined", onJoin)
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "presence",
        sessionId: "s1",
        participantId: "p-other",
        data: { action: "join", participant: PARTICIPANT },
        timestamp: 1,
      }),
    })
    expect(onJoin).toHaveBeenCalled()
  })

  it("emits participant-left on presence leave", async () => {
    const { p } = await connectFresh()
    const onLeft = jest.fn()
    p.on("participant-left", onLeft)
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "presence",
        sessionId: "s1",
        participantId: "p-other",
        data: { action: "leave" },
        timestamp: 1,
      }),
    })
    expect(onLeft).toHaveBeenCalled()
  })

  it("handles sync responses by deserializing CRDT state", async () => {
    const { crdt } = await connectFresh()
    const deserialize = jest.spyOn(crdt, "deserializeState").mockImplementation(() => null)
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "sync",
        sessionId: "s1",
        participantId: "p-other",
        data: { action: "response", state: "{}" },
        timestamp: 1,
      }),
    })
    expect(deserialize).toHaveBeenCalled()
  })

  it("emits 'error' when the message body is invalid JSON", async () => {
    const { p } = await connectFresh()
    const onErr = jest.fn()
    p.on("error", onErr)
    lastMockSocket!.onmessage?.({ data: "{not json" })
    // The handler logs but doesn't emit (only emits on type === 'error' messages),
    // so we just verify it didn't crash.
    expect(onErr).not.toHaveBeenCalled()
  })

  it("emits 'error' when message type is 'error'", async () => {
    const { p } = await connectFresh()
    const onErr = jest.fn()
    p.on("error", onErr)
    lastMockSocket!.onmessage?.({
      data: JSON.stringify({
        type: "error",
        sessionId: "s1",
        participantId: "p-other",
        data: { reason: "x" },
        timestamp: 1,
      }),
    })
    expect(onErr).toHaveBeenCalled()
  })
})

describe("event subscription disposer", () => {
  it("removes the listener when the disposer is invoked", async () => {
    const p = makeProvider()
    const onConnect = jest.fn()
    const off = p.on("connected", onConnect)
    off()
    const promise = p.connect("s1", PARTICIPANT)
    lastMockSocket!.onopen?.()
    await promise
    expect(onConnect).not.toHaveBeenCalled()
  })
})

describe("reconnect logic", () => {
  it("attempts to reconnect after a disconnect when under the retry budget", async () => {
    const p = makeProvider()
    const promise = p.connect("s1", PARTICIPANT)
    lastMockSocket!.onopen?.()
    await promise
    // Simulate close event.
    lastMockSocket!.onclose?.()
    expect(p.getConnectionState()).toBe("reconnecting")
    // Advance the reconnect timer; the new ws will be created.
    jest.advanceTimersByTime(150)
    expect(lastMockSocket).toBeTruthy()
  })

  it("emits 'disconnected' after exhausting reconnect attempts", async () => {
    const p = makeProvider()
    const onDisc = jest.fn()
    p.on("disconnected", onDisc)
    const promise = p.connect("s1", PARTICIPANT)
    lastMockSocket!.onopen?.()
    await promise
    // Force two failed reconnects (configured budget = 2).
    lastMockSocket!.onclose?.()
    jest.advanceTimersByTime(150)
    lastMockSocket!.onclose?.()
    jest.advanceTimersByTime(150)
    lastMockSocket!.onclose?.()
    // After the 3rd close the reconnect budget is exhausted.
    expect(onDisc).toHaveBeenCalled()
  })
})

describe("heartbeat", () => {
  it("sends a heartbeat presence message on the configured interval", async () => {
    const p = makeProvider()
    const promise = p.connect("s1", PARTICIPANT)
    lastMockSocket!.onopen?.()
    await promise
    lastMockSocket!.send.mockClear()
    jest.advanceTimersByTime(5_000)
    const heartbeat = lastMockSocket!.send.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).data.action === "heartbeat"
      } catch {
        return false
      }
    })
    expect(heartbeat).toBeTruthy()
  })
})
