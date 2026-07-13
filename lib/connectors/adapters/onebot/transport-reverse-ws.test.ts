/**
 * @jest-environment jsdom
 */

import { listen, emit } from "@tauri-apps/api/event"
import {
  subscribeOneBotEvents,
  subscribeOneBotOpen,
  subscribeOneBotClose,
  subscribeOneBotResponses,
  sendToOneBot,
  createReverseWsTransport,
} from "./transport-reverse-ws"
import type { SerializedOneBotCall } from "./serialize"

const mockListen = listen as jest.Mock
const mockEmit = emit as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ListenerMap = Map<string, ((event: { payload: string }) => void)[]>

function createEventBus(): {
  listenImpl: jest.Mock
  emitImpl: jest.Mock
  trigger: (topic: string, payload: string) => void
} {
  const listeners: ListenerMap = new Map()

  const listenImpl = jest
    .fn()
    .mockImplementation(async (topic: string, handler: (event: { payload: string }) => void) => {
      if (!listeners.has(topic)) listeners.set(topic, [])
      listeners.get(topic)!.push(handler)
      return jest.fn() // unlisten
    })

  const emitImpl = jest.fn().mockResolvedValue(undefined)

  function trigger(topic: string, payload: string) {
    const handlers = listeners.get(topic) ?? []
    for (const h of handlers) h({ payload })
  }

  return { listenImpl, emitImpl, trigger }
}

// ---------------------------------------------------------------------------
// subscribeOneBotEvents
// ---------------------------------------------------------------------------

describe("subscribeOneBotEvents", () => {
  beforeEach(() => {
    mockListen.mockReset()
    mockEmit.mockReset()
  })

  it("subscribes to the correct topic and calls onEvent with parsed JSON", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const received: unknown[] = []
    await subscribeOneBotEvents("adapter-1", (e) => received.push(e))

    bus.trigger("connectors://onebot/adapter-1/event", JSON.stringify({ post_type: "message" }))

    expect(received).toHaveLength(1)
    expect((received[0] as Record<string, unknown>).post_type).toBe("message")
  })

  it("drives 2 events through", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const received: unknown[] = []
    await subscribeOneBotEvents("adapter-2", (e) => received.push(e))

    bus.trigger("connectors://onebot/adapter-2/event", JSON.stringify({ id: 1 }))
    bus.trigger("connectors://onebot/adapter-2/event", JSON.stringify({ id: 2 }))

    expect(received).toHaveLength(2)
    expect((received[0] as Record<string, unknown>).id).toBe(1)
    expect((received[1] as Record<string, unknown>).id).toBe(2)
  })

  it("ignores non-JSON frames without throwing", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const received: unknown[] = []
    await subscribeOneBotEvents("adapter-3", (e) => received.push(e))

    expect(() => {
      bus.trigger("connectors://onebot/adapter-3/event", "not-json")
    }).not.toThrow()
    expect(received).toHaveLength(0)
  })

  it("returns an unlisten function", async () => {
    const mockUnlisten = jest.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    const unlisten = await subscribeOneBotEvents("adapter-x", jest.fn())
    expect(typeof unlisten).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// subscribeOneBotOpen / subscribeOneBotClose
// ---------------------------------------------------------------------------

describe("subscribeOneBotOpen", () => {
  beforeEach(() => mockListen.mockReset())

  it("calls onOpen when open event fires", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const onOpen = jest.fn()
    await subscribeOneBotOpen("adapter-4", onOpen)

    bus.trigger("connectors://onebot/adapter-4/open", "")
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe("subscribeOneBotClose", () => {
  beforeEach(() => mockListen.mockReset())

  it("calls onClose when close event fires", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const onClose = jest.fn()
    await subscribeOneBotClose("adapter-5", onClose)

    bus.trigger("connectors://onebot/adapter-5/close", "")
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// sendToOneBot RPC round-trip
// ---------------------------------------------------------------------------

describe("sendToOneBot", () => {
  beforeEach(() => {
    mockListen.mockReset()
    mockEmit.mockReset()
  })

  it("emits the call to the send topic and resolves on echo-matched response", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    mockEmit.mockImplementation(bus.emitImpl)

    await subscribeOneBotResponses("adapter-rpc")

    const call: SerializedOneBotCall = {
      action: "send_private_msg",
      echo: "echo-001",
      params: { user_id: "1234", message: [] },
    }

    // Simulate a response arriving shortly after the emit
    mockEmit.mockImplementation(async () => {
      setTimeout(() => {
        bus.trigger(
          "connectors://onebot/adapter-rpc/response",
          JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 99 }, echo: "echo-001" })
        )
      }, 10)
    })

    const result = await sendToOneBot("adapter-rpc", call)
    expect(result.status).toBe("ok")
    expect(result.echo).toBe("echo-001")

    // Verify the send topic was called
    expect(mockEmit).toHaveBeenCalledWith(
      "connectors://onebot/adapter-rpc/send",
      JSON.stringify(call)
    )
  })

  it("rejects on timeout", async () => {
    mockEmit.mockResolvedValue(undefined)
    mockListen.mockResolvedValue(jest.fn())

    const call: SerializedOneBotCall = {
      action: "send_private_msg",
      echo: "echo-timeout",
      params: {},
    }

    await expect(sendToOneBot("adapter-timeout", call, 50)).rejects.toThrow("timeout")
  }, 5000)
})

// ---------------------------------------------------------------------------
// createReverseWsTransport — liveness-gated RPC
// ---------------------------------------------------------------------------

describe("createReverseWsTransport", () => {
  beforeEach(() => {
    mockListen.mockReset()
    mockEmit.mockReset()
    mockEmit.mockResolvedValue(undefined)
  })

  const call = (echo: string): SerializedOneBotCall => ({
    action: "get_login_info",
    echo,
    params: {},
  })

  const handlers = () => ({ onOpen: jest.fn(), onClose: jest.fn(), onEvent: jest.fn() })

  it("fails RPCs fast (no 10s timeout, no emit) while no client is connected", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const transport = createReverseWsTransport("rt-idle")
    await transport.start(handlers())

    await expect(transport.send(call("e-idle"))).rejects.toThrow(/no connected client/)
    expect(mockEmit).not.toHaveBeenCalled()
    await transport.stop()
  })

  it("allows RPCs after the open event and fails fast again after close", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    mockEmit.mockImplementation(async (_topic: string, payload: string) => {
      const c = JSON.parse(payload) as { echo: string }
      setTimeout(() => {
        bus.trigger(
          "connectors://onebot/rt-live/response",
          JSON.stringify({ status: "ok", retcode: 0, data: {}, echo: c.echo })
        )
      }, 0)
    })

    const h = handlers()
    const transport = createReverseWsTransport("rt-live")
    await transport.start(h)

    bus.trigger("connectors://onebot/rt-live/open", "")
    expect(h.onOpen).toHaveBeenCalledTimes(1)
    await expect(transport.send(call("e-live"))).resolves.toMatchObject({ status: "ok" })

    bus.trigger("connectors://onebot/rt-live/close", "")
    expect(h.onClose).toHaveBeenCalledTimes(1)
    await expect(transport.send(call("e-closed"))).rejects.toThrow(/no connected client/)

    await transport.stop()
  })

  it("treats an inbound event frame as proof of a live client", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    mockEmit.mockImplementation(async (_topic: string, payload: string) => {
      const c = JSON.parse(payload) as { echo: string }
      setTimeout(() => {
        bus.trigger(
          "connectors://onebot/rt-evt/response",
          JSON.stringify({ status: "ok", retcode: 0, data: {}, echo: c.echo })
        )
      }, 0)
    })

    const h = handlers()
    const transport = createReverseWsTransport("rt-evt")
    await transport.start(h)

    // No open event observed (e.g. adapter restarted mid-connection) — an
    // event frame still marks the client as connected.
    bus.trigger("connectors://onebot/rt-evt/event", JSON.stringify({ post_type: "message" }))
    expect(h.onEvent).toHaveBeenCalledTimes(1)
    await expect(transport.send(call("e-evt"))).resolves.toMatchObject({ status: "ok" })

    await transport.stop()
  })
})
