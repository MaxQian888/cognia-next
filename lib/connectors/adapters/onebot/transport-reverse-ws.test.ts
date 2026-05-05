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
