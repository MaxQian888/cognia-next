import type {
  Experimental_RealtimeModelV4 as RealtimeModel,
  Experimental_RealtimeModelV4ServerEvent as RealtimeServerEvent,
} from "@ai-sdk/provider"

import { WS_OPEN, createLiveVoiceTransport, type WebSocketLike } from "./transport"

class FakeSocket implements WebSocketLike {
  readyState = WS_OPEN
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  onopen: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  send(data: string) {
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
  }
  receive(data: unknown) {
    this.onmessage?.({ data })
  }
}

/** Minimal adapter; individual tests override the parts they exercise. */
function fakeAdapter(overrides: Partial<RealtimeModel> = {}): RealtimeModel {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-realtime",
    doCreateClientSecret: jest.fn(),
    getWebSocketConfig: ({ url }) => ({ url: `${url}?dialed=1`, protocols: ["realtime"] }),
    parseServerEvent: (raw) => raw as RealtimeServerEvent,
    serializeClientEvent: (event) => event,
    buildSessionConfig: (config) => config,
    ...overrides,
  } as RealtimeModel
}

function harness(adapterOverrides: Partial<RealtimeModel> = {}) {
  const socket = new FakeSocket()
  const events: RealtimeServerEvent[] = []
  const errors: Error[] = []
  const closes: { code?: number; reason?: string }[] = []
  const opens: number[] = []
  const created: { url: string; protocols?: string[] }[] = []

  const transport = createLiveVoiceTransport({
    adapter: fakeAdapter(adapterOverrides),
    onServerEvent: (event) => events.push(event),
    onOpen: () => opens.push(1),
    onClose: (info) => closes.push(info),
    onError: (error) => errors.push(error),
    createWebSocket: (url, protocols) => {
      created.push({ url, protocols })
      return socket
    },
  })

  return { transport, socket, events, errors, closes, opens, created }
}

const SESSION = { token: "ek_secret", url: "wss://provider.example/realtime" }

/** Let the transport's internal send chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("connect", () => {
  it("dials the URL and subprotocols the adapter chose", () => {
    const h = harness()

    h.transport.connect(SESSION)

    expect(h.created).toEqual([
      { url: "wss://provider.example/realtime?dialed=1", protocols: ["realtime"] },
    ])
  })

  it("passes the minted token to the adapter rather than the URL", () => {
    const getWebSocketConfig = jest.fn(() => ({ url: "wss://x" }))
    const h = harness({ getWebSocketConfig })

    h.transport.connect(SESSION)

    expect(getWebSocketConfig).toHaveBeenCalledWith({
      token: "ek_secret",
      url: "wss://provider.example/realtime",
    })
  })

  it("reports open", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.socket.onopen?.({})

    expect(h.opens).toHaveLength(1)
    expect(h.transport.isOpen).toBe(true)
  })

  it("refuses a second connect on a live transport", () => {
    const h = harness()
    h.transport.connect(SESSION)

    expect(() => h.transport.connect(SESSION)).toThrow(/already connected/)
  })

  it("reports an unexpected close with its code and reason", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.socket.onclose?.({ code: 1006, reason: "abnormal" })

    expect(h.closes).toEqual([{ code: 1006, reason: "abnormal" }])
    expect(h.transport.isOpen).toBe(false)
  })

  it("surfaces a socket error", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.socket.onerror?.({})

    expect(h.errors.map((error) => error.message)).toEqual(["live voice socket error"])
  })
})

describe("receive", () => {
  it("forwards a parsed server event", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.socket.receive(JSON.stringify({ type: "session-created" }))

    expect(h.events).toEqual([{ type: "session-created" }])
  })

  it("fans one message out to several events", () => {
    // Google packs audio, text and turn-complete into one serverContent message.
    const h = harness({
      parseServerEvent: () =>
        [{ type: "audio-delta" }, { type: "text-delta" }] as unknown as RealtimeServerEvent[],
    })
    h.transport.connect(SESSION)

    h.socket.receive("{}")

    expect(h.events.map((event) => event.type)).toEqual(["audio-delta", "text-delta"])
  })

  it("accepts an already-decoded payload", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.socket.receive({ type: "response-done" })

    expect(h.events).toEqual([{ type: "response-done" }])
  })

  it("reports malformed JSON without killing the socket", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.socket.receive("{not json")

    expect(h.errors[0].message).toMatch(/malformed JSON/)
    expect(h.socket.closed).toBeNull()
  })

  it("reports an adapter parse failure", () => {
    const h = harness({
      parseServerEvent: () => {
        throw new Error("unknown vendor event")
      },
    })
    h.transport.connect(SESSION)

    h.socket.receive("{}")

    expect(h.errors.map((error) => error.message)).toEqual(["unknown vendor event"])
  })

  it("skips a null event from the adapter", () => {
    const h = harness({ parseServerEvent: () => null as unknown as RealtimeServerEvent })
    h.transport.connect(SESSION)

    h.socket.receive("{}")

    expect(h.events).toHaveLength(0)
  })

  describe("vendor keepalive", () => {
    it("answers a health check and does not treat it as a session event", () => {
      const h = harness({
        getHealthCheckResponse: (raw) => ((raw as { ping?: boolean }).ping ? { pong: true } : null),
      })
      h.transport.connect(SESSION)

      h.socket.receive(JSON.stringify({ ping: true }))

      expect(h.socket.sent).toEqual([JSON.stringify({ pong: true })])
      expect(h.events).toHaveLength(0)
    })

    it("passes non-keepalive messages through", () => {
      const h = harness({ getHealthCheckResponse: () => null })
      h.transport.connect(SESSION)

      h.socket.receive(JSON.stringify({ type: "session-created" }))

      expect(h.events).toHaveLength(1)
      expect(h.socket.sent).toHaveLength(0)
    })
  })
})

describe("send", () => {
  it("serializes and writes an event", async () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.transport.send({ type: "response-create" } as never)
    await flush()

    expect(h.socket.sent).toEqual([JSON.stringify({ type: "response-create" })])
  })

  it("passes a string payload straight through", async () => {
    const h = harness({ serializeClientEvent: () => "raw-frame" })
    h.transport.connect(SESSION)

    h.transport.send({ type: "input-audio-append" } as never)
    await flush()

    expect(h.socket.sent).toEqual(["raw-frame"])
  })

  it("preserves order when serialization is async and uneven", async () => {
    // Audio appends are high-rate; a reordered stream is unrecoverable.
    const delays: Record<string, number> = { first: 20, second: 1, third: 0 }
    const h = harness({
      serializeClientEvent: async (event) => {
        const id = (event as unknown as { id: string }).id
        await new Promise((resolve) => setTimeout(resolve, delays[id]))
        return { id }
      },
    })
    h.transport.connect(SESSION)

    for (const id of ["first", "second", "third"]) {
      h.transport.send({ id } as never)
    }
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(h.socket.sent.map((payload) => JSON.parse(payload).id)).toEqual([
      "first",
      "second",
      "third",
    ])
  })

  it("drops frames while the socket is not open rather than buffering them", async () => {
    const h = harness()
    h.transport.connect(SESSION)
    h.socket.readyState = 0

    h.transport.send({ type: "input-audio-append" } as never)
    h.socket.readyState = WS_OPEN
    await flush()

    expect(h.socket.sent).toHaveLength(0)
  })

  it("drops a queued frame if the socket closes mid-flight", async () => {
    const h = harness({
      serializeClientEvent: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return event
      },
    })
    h.transport.connect(SESSION)

    h.transport.send({ type: "input-audio-append" } as never)
    h.socket.readyState = 3
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(h.socket.sent).toHaveLength(0)
  })

  it("reports a serialization failure and keeps the chain usable", async () => {
    let shouldFail = true
    const h = harness({
      serializeClientEvent: (event) => {
        if (shouldFail) throw new Error("cannot serialize")
        return event
      },
    })
    h.transport.connect(SESSION)

    h.transport.send({ type: "bad" } as never)
    await flush()
    shouldFail = false
    h.transport.send({ type: "good" } as never)
    await flush()

    expect(h.errors.map((error) => error.message)).toEqual(["cannot serialize"])
    expect(h.socket.sent).toEqual([JSON.stringify({ type: "good" })])
  })

  it("skips an event the adapter declines to serialize", async () => {
    const h = harness({ serializeClientEvent: () => null })
    h.transport.connect(SESSION)

    h.transport.send({ type: "ignored" } as never)
    await flush()

    expect(h.socket.sent).toHaveLength(0)
  })

  it("is a no-op before connect", async () => {
    const h = harness()

    expect(() => h.transport.send({ type: "response-create" } as never)).not.toThrow()
    await flush()
  })
})

describe("close", () => {
  it("closes the socket with the given code", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.transport.close(1000, "done")

    expect(h.socket.closed).toEqual({ code: 1000, reason: "done" })
    expect(h.transport.isOpen).toBe(false)
  })

  it("detaches handlers so a late message cannot resurface", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.transport.close()
    h.socket.receive(JSON.stringify({ type: "session-created" }))

    expect(h.events).toHaveLength(0)
  })

  it("does not report an error for a close we initiated", () => {
    const h = harness()
    h.transport.connect(SESSION)

    h.transport.close()
    h.socket.onerror?.({})

    expect(h.errors).toHaveLength(0)
  })

  it("tolerates a socket that throws while closing", () => {
    const h = harness()
    h.transport.connect(SESSION)
    h.socket.close = () => {
      throw new Error("InvalidStateError")
    }

    expect(() => h.transport.close()).not.toThrow()
  })

  it("is safe when never connected", () => {
    expect(() => harness().transport.close()).not.toThrow()
  })

  it("allows reconnecting afterwards", () => {
    const h = harness()
    h.transport.connect(SESSION)
    h.transport.close()

    expect(() => h.transport.connect(SESSION)).not.toThrow()
  })
})

describe("default WebSocket seam", () => {
  const globals = globalThis as Record<string, unknown>
  const saved = globals.WebSocket

  afterEach(() => {
    if (saved === undefined) delete globals.WebSocket
    else globals.WebSocket = saved
  })

  it("constructs a real WebSocket with the adapter's protocols", () => {
    const calls: unknown[][] = []
    globals.WebSocket = function WebSocketStub(...args: unknown[]) {
      calls.push(args)
      return new FakeSocket()
    }

    createLiveVoiceTransport({
      adapter: fakeAdapter(),
      onServerEvent: () => undefined,
    }).connect(SESSION)

    expect(calls).toEqual([["wss://provider.example/realtime?dialed=1", ["realtime"]]])
  })

  it("omits the protocol argument when the adapter supplies none", () => {
    const calls: unknown[][] = []
    globals.WebSocket = function WebSocketStub(...args: unknown[]) {
      calls.push(args)
      return new FakeSocket()
    }

    createLiveVoiceTransport({
      adapter: fakeAdapter({ getWebSocketConfig: () => ({ url: "wss://bare" }) }),
      onServerEvent: () => undefined,
    }).connect(SESSION)

    expect(calls).toEqual([["wss://bare"]])
  })

  it("reports a runtime with no WebSocket", () => {
    delete globals.WebSocket

    expect(() =>
      createLiveVoiceTransport({
        adapter: fakeAdapter(),
        onServerEvent: () => undefined,
      }).connect(SESSION)
    ).toThrow(/WebSocket is not available/)
  })
})
