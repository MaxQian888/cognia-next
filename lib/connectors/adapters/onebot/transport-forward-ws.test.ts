import { listen } from "@tauri-apps/api/event"
import { createForwardWsTransport } from "./transport-forward-ws"

// The generic WS client commands are mocked so no Tauri invoke fires.
const mockWsOpen = jest.fn()
const mockWsSend = jest.fn()
const mockWsClose = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: (...args: unknown[]) => mockWsOpen(...args),
  connectorsWsSend: (...args: unknown[]) => mockWsSend(...args),
  connectorsWsClose: (...args: unknown[]) => mockWsClose(...args),
}))

const mockListen = listen as jest.Mock

type Handler = (e: { payload: string }) => void

function createBus() {
  const listeners = new Map<string, Handler[]>()
  const impl = jest.fn(async (topic: string, handler: Handler) => {
    if (!listeners.has(topic)) listeners.set(topic, [])
    listeners.get(topic)!.push(handler)
    return jest.fn()
  })
  const trigger = (topic: string, payload: string) => {
    for (const h of listeners.get(topic) ?? []) h({ payload })
  }
  return { impl, trigger }
}

const noopHandlers = () => ({
  onOpen: jest.fn(),
  onClose: jest.fn(),
  onEvent: jest.fn(),
  onConnectFailed: jest.fn(),
})

beforeEach(() => {
  mockListen.mockReset()
  mockWsOpen.mockReset()
  mockWsSend.mockReset()
  mockWsClose.mockReset()
})

describe("createForwardWsTransport", () => {
  it("dials the URL with a Bearer header and fires onOpen", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")

    const handlers = noopHandlers()
    const transport = createForwardWsTransport({
      adapterId: "ob-fw",
      url: "ws://host:3001",
      token: async () => "secret",
    })
    await transport.start(handlers)

    expect(mockWsOpen).toHaveBeenCalledWith("ws://host:3001", { Authorization: "Bearer secret" })
    expect(handlers.onOpen).toHaveBeenCalledTimes(1)

    await transport.stop()
    expect(mockWsClose).toHaveBeenCalledWith("h1")
  })

  it("omits the auth header when no token is configured", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")

    const transport = createForwardWsTransport({ adapterId: "ob-fw", url: "ws://host:3001" })
    await transport.start(noopHandlers())

    expect(mockWsOpen).toHaveBeenCalledWith("ws://host:3001", undefined)
    await transport.stop()
  })

  it("routes a pushed event frame to onEvent", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")

    const handlers = noopHandlers()
    const transport = createForwardWsTransport({ adapterId: "ob-fw", url: "ws://x" })
    await transport.start(handlers)

    bus.trigger(
      "connectors://ws/h1/message",
      JSON.stringify({ post_type: "message", message: [{ type: "text", data: { text: "hi" } }] })
    )

    expect(handlers.onEvent).toHaveBeenCalledWith(expect.objectContaining({ post_type: "message" }))
    await transport.stop()
  })

  it("ignores non-JSON frames", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")

    const handlers = noopHandlers()
    const transport = createForwardWsTransport({ adapterId: "ob-fw", url: "ws://x" })
    await transport.start(handlers)

    bus.trigger("connectors://ws/h1/message", "<<not json>>")
    expect(handlers.onEvent).not.toHaveBeenCalled()
    await transport.stop()
  })

  it("send() writes the call and resolves on the echo-matched response", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")
    mockWsSend.mockImplementation(async (_id: string, data: string) => {
      const call = JSON.parse(data) as { echo: string }
      setTimeout(() => {
        bus.trigger(
          "connectors://ws/h1/message",
          JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 7 }, echo: call.echo })
        )
      }, 0)
    })

    const transport = createForwardWsTransport({ adapterId: "ob-fw", url: "ws://x" })
    await transport.start(noopHandlers())

    const resp = await transport.send({ action: "send_private_msg", echo: "e1", params: {} })
    expect(resp.status).toBe("ok")
    expect((resp.data as { message_id: number }).message_id).toBe(7)
    expect(mockWsSend).toHaveBeenCalledWith("h1", expect.stringContaining("send_private_msg"))

    await transport.stop()
  })

  it("does not settle a call from an echo-carrying frame that is not a response", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")
    mockWsSend.mockImplementation(async (_id: string, data: string) => {
      const call = JSON.parse(data) as { echo: string }
      setTimeout(() => {
        bus.trigger(
          "connectors://ws/h1/message",
          JSON.stringify({ post_type: "meta_event", echo: call.echo })
        )
        bus.trigger(
          "connectors://ws/h1/message",
          JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 9 }, echo: call.echo })
        )
      }, 0)
    })

    const handlers = noopHandlers()
    const transport = createForwardWsTransport({ adapterId: "ob-fw", url: "ws://x" })
    await transport.start(handlers)

    const resp = await transport.send({ action: "send_msg", echo: "e-meta", params: {} })
    expect(resp.retcode).toBe(0)
    expect((resp.data as { message_id: number }).message_id).toBe(9)
    expect(handlers.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ post_type: "meta_event", echo: "e-meta" })
    )

    await transport.stop()
  })

  it("send() rejects on response timeout", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")
    mockWsSend.mockResolvedValue(undefined) // no response ever arrives

    const transport = createForwardWsTransport({ adapterId: "ob-fw", url: "ws://x" })
    await transport.start(noopHandlers())

    await expect(transport.send({ action: "noop", echo: "e2", params: {} }, 5)).rejects.toThrow(
      /timeout/
    )

    await transport.stop()
  })

  it("send() rejects when the socket is not connected", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    // Never connects; a huge backoff keeps it from reconnecting during the test.
    mockWsOpen.mockRejectedValue(new Error("connect failed"))

    const transport = createForwardWsTransport({
      adapterId: "ob-fw",
      url: "ws://x",
      _backoffBaseMs: 10_000_000,
    })
    await transport.start(noopHandlers())

    await expect(transport.send({ action: "x", echo: "e3", params: {} })).rejects.toThrow(
      /not connected/
    )

    await transport.stop()
  })

  it("reports consecutive connect failures via onConnectFailed", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockRejectedValue(new Error("refused"))

    const handlers = noopHandlers()
    const transport = createForwardWsTransport({
      adapterId: "ob-fw",
      url: "ws://x",
      _backoffBaseMs: 1,
    })
    await transport.start(handlers)

    // First failure fires synchronously in start; the rest ride the 1ms-base
    // reconnect backoff.
    expect(handlers.onConnectFailed).toHaveBeenCalledWith(1)
    await new Promise((r) => setTimeout(r, 60))
    expect(handlers.onConnectFailed.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(handlers.onConnectFailed).toHaveBeenCalledWith(2)
    expect(handlers.onConnectFailed).toHaveBeenCalledWith(3)
    // Counter is consecutive: monotonically increasing while never opening.
    const counts = handlers.onConnectFailed.mock.calls.map((c) => c[0] as number)
    expect(counts).toEqual([...counts].sort((a, b) => a - b))

    await transport.stop()
  })

  it("resets the consecutive failure counter after a successful connect", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockRejectedValueOnce(new Error("refused")).mockResolvedValue("h1")

    const handlers = noopHandlers()
    const transport = createForwardWsTransport({
      adapterId: "ob-fw",
      url: "ws://x",
      _backoffBaseMs: 1,
    })
    await transport.start(handlers)
    expect(handlers.onConnectFailed).toHaveBeenCalledWith(1)

    // Wait for the reconnect to succeed, then drop the socket and fail again —
    // the counter restarts at 1 instead of continuing at 2.
    await new Promise((r) => setTimeout(r, 30))
    expect(handlers.onOpen).toHaveBeenCalledTimes(1)

    mockWsOpen.mockRejectedValue(new Error("refused again"))
    bus.trigger("connectors://ws/h1/close", "")
    await new Promise((r) => setTimeout(r, 30))
    const counts = handlers.onConnectFailed.mock.calls.map((c) => c[0] as number)
    expect(counts.filter((n) => n === 1).length).toBeGreaterThanOrEqual(2)

    await transport.stop()
  })

  it("reconnects after the socket closes", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValue("h1")

    const handlers = noopHandlers()
    const transport = createForwardWsTransport({
      adapterId: "ob-fw",
      url: "ws://x",
      _backoffBaseMs: 1,
    })
    await transport.start(handlers)
    expect(mockWsOpen).toHaveBeenCalledTimes(1)

    bus.trigger("connectors://ws/h1/close", "")
    expect(handlers.onClose).toHaveBeenCalledTimes(1)

    // backoff = 1 * 2^1 = 2ms — wait comfortably past it.
    await new Promise((r) => setTimeout(r, 30))
    expect(mockWsOpen).toHaveBeenCalledTimes(2)
    expect(handlers.onOpen).toHaveBeenCalledTimes(2)

    await transport.stop()
  })
})

describe("forward WS lifecycle races", () => {
  it("closes a socket that finishes opening after stop", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    let finish!: (id: string) => void
    mockWsOpen.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    const transport = createForwardWsTransport({ adapterId: "late", url: "ws://x" })
    const handlers = noopHandlers()
    const starting = transport.start(handlers)
    await transport.stop()
    finish("late-handle")
    await starting
    expect(handlers.onOpen).not.toHaveBeenCalled()
    expect(mockWsClose).toHaveBeenCalledWith("late-handle")
    expect(mockListen).not.toHaveBeenCalled()
  })

  it("unsubscribes a listener whose registration completes after stop", async () => {
    let registered!: (fn: () => void) => void
    mockWsOpen.mockResolvedValue("h1")
    mockListen.mockImplementation(
      () =>
        new Promise((resolve) => {
          registered = resolve
        })
    )
    const transport = createForwardWsTransport({ adapterId: "late", url: "ws://x" })
    const handlers = noopHandlers()
    const starting = transport.start(handlers)
    await Promise.resolve()
    await transport.stop()
    const unlisten = jest.fn()
    registered(unlisten)
    await starting
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it("rejects pending RPCs at stop and permits a clean restart", async () => {
    const bus = createBus()
    mockListen.mockImplementation(bus.impl)
    mockWsOpen.mockResolvedValueOnce("h1").mockResolvedValue("h2")
    mockWsSend.mockResolvedValue(undefined)
    const transport = createForwardWsTransport({
      adapterId: "late",
      url: "ws://x",
      _backoffBaseMs: 1,
    })
    const handlers = noopHandlers()
    await transport.start(handlers)
    const sent = transport.send({ action: "send_msg", echo: "pending-stop", params: {} })
    const rejected = expect(sent).rejects.toThrow(/stopped/)
    await transport.stop()
    await rejected
    await transport.start(handlers)
    bus.trigger("connectors://ws/h1/message", JSON.stringify({ type: "old" }))
    expect(handlers.onEvent).not.toHaveBeenCalled()
    bus.trigger("connectors://ws/h2/close", "")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(mockWsOpen).toHaveBeenCalledTimes(3)
    await transport.stop()
  })
})
