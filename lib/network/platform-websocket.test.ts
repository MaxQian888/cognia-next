const connectorsWsOpen = jest.fn()
const connectorsWsSend = jest.fn()
const connectorsWsClose = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: (...args: unknown[]) => connectorsWsOpen(...args),
  connectorsWsSend: (...args: unknown[]) => connectorsWsSend(...args),
  connectorsWsClose: (...args: unknown[]) => connectorsWsClose(...args),
}))

type Handler = (event: { payload: unknown }) => void
const listeners = new Map<string, Handler>()
const unlisten = jest.fn()
jest.mock("@/lib/connectors/events", () => ({
  connectorListen: jest.fn(async (topic: string, handler: Handler) => {
    listeners.set(topic, handler)
    return () => {
      listeners.delete(topic)
      unlisten(topic)
    }
  }),
}))

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

import {
  PlatformWebSocketHeadersUnsupportedError,
  createPlatformWebSocket,
  withSubprotocolHeader,
} from "./platform-websocket"

const HANDLE_ID = "00000000-0000-4000-8000-000000000001"
const randomUUID = jest.spyOn(globalThis.crypto, "randomUUID")

function emit(topic: string, payload: unknown): void {
  const handler = listeners.get(topic)
  if (!handler) throw new Error(`no listener for ${topic}`)
  handler({ payload })
}

beforeEach(() => {
  randomUUID.mockReturnValue(HANDLE_ID)
  connectorsWsOpen.mockReset().mockResolvedValue(HANDLE_ID)
  connectorsWsSend.mockReset().mockResolvedValue(undefined)
  connectorsWsClose.mockReset().mockResolvedValue(undefined)
  unlisten.mockReset()
  listeners.clear()
  mockIsTauri.mockReset().mockReturnValue(true)
})

describe("createPlatformWebSocket on Tauri", () => {
  it("dials through the native proxy-aware transport and forwards handshake headers", async () => {
    const socket = await createPlatformWebSocket("wss://agent.example.com/acp", {
      headers: { Authorization: "Bearer t" },
    })

    expect(connectorsWsOpen).toHaveBeenCalledWith(
      "wss://agent.example.com/acp",
      { Authorization: "Bearer t" },
      HANDLE_ID
    )
    expect(socket.kind).toBe("native")
    expect(socket.id).toBe(HANDLE_ID)
  })

  it("carries subprotocols as the handshake header the native path can send", async () => {
    // The renderer has no way to name a subprotocol on the native command, but
    // on the wire a subprotocol IS a header, so it goes across as one.
    await createPlatformWebSocket("wss://collab.example.com/stream", {
      headers: { Authorization: "Bearer t" },
      protocols: ["cognia.chat.v1", "st_ticket"],
    })

    expect(connectorsWsOpen).toHaveBeenCalledWith(
      "wss://collab.example.com/stream",
      { Authorization: "Bearer t", "Sec-WebSocket-Protocol": "cognia.chat.v1, st_ticket" },
      HANDLE_ID
    )
  })

  it("surfaces text, binary and error frames on their own callbacks", async () => {
    const onMessage = jest.fn()
    const onBinary = jest.fn()
    const onError = jest.fn()
    await createPlatformWebSocket("wss://agent.example.com/acp", { onMessage, onBinary, onError })

    emit(`connectors://ws/${HANDLE_ID}/message`, '{"jsonrpc":"2.0"}')
    emit(`connectors://ws/${HANDLE_ID}/binary`, Buffer.from([1, 2, 3]).toString("base64"))
    emit(`connectors://ws/${HANDLE_ID}/error`, "read error")

    expect(onMessage).toHaveBeenCalledWith('{"jsonrpc":"2.0"}')
    expect(onBinary).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    expect(onError).toHaveBeenCalledWith("read error")
  })

  it("reports a close frame's code and reason, then detaches every listener", async () => {
    const onClose = jest.fn()
    await createPlatformWebSocket("wss://agent.example.com/acp", { onClose })

    emit(`connectors://ws/${HANDLE_ID}/close`, { code: 1006, reason: "abnormal" })

    expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: "abnormal" })
    // A webview reload that leaks listeners is what makes duplicate inbound
    // events pile up, so teardown is part of the contract.
    expect(unlisten).toHaveBeenCalledTimes(4)
    expect(listeners.size).toBe(0)
  })

  it("normalizes a peer that vanished without a close frame to nulls", async () => {
    const onClose = jest.fn()
    await createPlatformWebSocket("wss://agent.example.com/acp", { onClose })

    emit(`connectors://ws/${HANDLE_ID}/close`, { code: null, reason: null })

    expect(onClose).toHaveBeenCalledWith({ code: null, reason: null })
  })

  it("tolerates a legacy close payload with no body at all", async () => {
    const onClose = jest.fn()
    await createPlatformWebSocket("wss://agent.example.com/acp", { onClose })

    emit(`connectors://ws/${HANDLE_ID}/close`, undefined)

    expect(onClose).toHaveBeenCalledWith({ code: null, reason: null })
  })

  it("closes once, even when the caller closes after the peer already did", async () => {
    const onClose = jest.fn()
    const socket = await createPlatformWebSocket("wss://agent.example.com/acp", { onClose })

    emit(`connectors://ws/${HANDLE_ID}/close`, { code: 1000, reason: "bye" })
    await socket.close()

    expect(connectorsWsClose).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("sends through the native command", async () => {
    const socket = await createPlatformWebSocket("wss://agent.example.com/acp")

    await socket.send("ping")

    expect(connectorsWsSend).toHaveBeenCalledWith(HANDLE_ID, "ping")
  })

  it("sends binary frames through the native command", async () => {
    const socket = await createPlatformWebSocket("wss://agent.example.com/acp")
    const bytes = new Uint8Array([1, 2, 3])

    await socket.send(bytes)

    expect(connectorsWsSend).toHaveBeenCalledWith(HANDLE_ID, bytes)
  })

  it("attaches listeners before the native handshake can emit its first frame", async () => {
    const onMessage = jest.fn()
    connectorsWsOpen.mockImplementationOnce(async (_url, _headers, handleId) => {
      emit(`connectors://ws/${handleId}/message`, "first")
      return handleId
    })

    await createPlatformWebSocket("wss://agent.example.com/acp", { onMessage })

    expect(onMessage).toHaveBeenCalledWith("first")
  })

  it("propagates the native refusal when WebSocket proxying is disabled", async () => {
    // Rust's `websocket_route_for` fails rather than dialling direct. Swallowing
    // that would route the connection around a proxy the user chose.
    connectorsWsOpen.mockRejectedValueOnce(
      new Error("public WebSocket traffic is blocked because WebSocket proxying is disabled")
    )

    await expect(createPlatformWebSocket("wss://agent.example.com/acp")).rejects.toThrow(
      "WebSocket proxying is disabled"
    )
  })
})

describe("createPlatformWebSocket off Tauri", () => {
  interface FakeSocket extends WebSocket {
    __open(): void
    __message(data: unknown): void
    __close(code: number, reason: string): void
    __error(): void
    sent: unknown[]
    closeCalls: number
  }

  function fakeSocket(): FakeSocket {
    const socket = {
      onopen: null as null | (() => void),
      onmessage: null as null | ((event: { data: unknown }) => void),
      onclose: null as null | ((event: { code: number; reason: string }) => void),
      onerror: null as null | (() => void),
      sent: [] as unknown[],
      closeCalls: 0,
      send(data: string | Uint8Array) {
        this.sent.push(data)
      },
      close() {
        this.closeCalls += 1
      },
      __open() {
        this.onopen?.()
      },
      __message(data: unknown) {
        this.onmessage?.({ data })
      },
      __close(code: number, reason: string) {
        this.onclose?.({ code, reason })
      },
      __error() {
        this.onerror?.()
      },
    }
    return socket as unknown as FakeSocket
  }

  beforeEach(() => {
    mockIsTauri.mockReturnValue(false)
  })

  it("falls back to the platform WebSocket and resolves on open", async () => {
    const socket = fakeSocket()
    const onMessage = jest.fn()
    const pending = createPlatformWebSocket(
      "wss://canvas.example.com/session",
      { onMessage },
      { socketFactory: () => socket }
    )
    socket.__open()
    const handle = await pending

    expect(handle.kind).toBe("browser")
    socket.__message("hello")
    expect(onMessage).toHaveBeenCalledWith("hello")

    await handle.send("ping")
    expect(socket.sent).toEqual(["ping"])

    const bytes = new Uint8Array([1, 2, 3])
    await handle.send(bytes)
    expect(new Uint8Array(socket.sent[1] as ArrayBuffer)).toEqual(bytes)
  })

  it("refuses handshake headers instead of dropping them", async () => {
    // Silently connecting without the bearer would look like a working socket
    // and fail as an auth error the caller cannot explain.
    await expect(
      createPlatformWebSocket(
        "wss://agent.example.com/acp",
        { headers: { Authorization: "Bearer t" } },
        { socketFactory: () => fakeSocket() }
      )
    ).rejects.toBeInstanceOf(PlatformWebSocketHeadersUnsupportedError)
  })

  it("rejects when the connection errors before opening", async () => {
    const socket = fakeSocket()
    const pending = createPlatformWebSocket(
      "wss://canvas.example.com/session",
      {},
      { socketFactory: () => socket }
    )
    socket.__error()

    await expect(pending).rejects.toThrow("failed")
  })

  it("reports a close after opening without rejecting the settled handle", async () => {
    const socket = fakeSocket()
    const onClose = jest.fn()
    const pending = createPlatformWebSocket(
      "wss://canvas.example.com/session",
      { onClose },
      { socketFactory: () => socket }
    )
    socket.__open()
    const handle = await pending

    socket.__close(1001, "going away")

    expect(onClose).toHaveBeenCalledWith({ code: 1001, reason: "going away" })
    await handle.close()
    expect(socket.closeCalls).toBe(0)
  })

  it("hands subprotocols to the platform constructor", async () => {
    // The browser cannot send handshake headers, so a protocol that carries its
    // credential as a subprotocol reaches the server only through this argument.
    const socket = fakeSocket()
    const factory = jest.fn(() => socket)
    const pending = createPlatformWebSocket(
      "wss://collab.example.com/stream",
      { protocols: ["cognia.chat.v1", "st_ticket"] },
      { socketFactory: factory }
    )
    socket.__open()
    await pending

    expect(factory).toHaveBeenCalledWith("wss://collab.example.com/stream", [
      "cognia.chat.v1",
      "st_ticket",
    ])
  })

  it("honours the injected shell probe over the ambient one", async () => {
    mockIsTauri.mockReturnValue(true)
    const socket = fakeSocket()
    const pending = createPlatformWebSocket(
      "wss://canvas.example.com/session",
      {},
      { isTauri: () => false, socketFactory: () => socket }
    )
    socket.__open()

    expect((await pending).kind).toBe("browser")
    expect(connectorsWsOpen).not.toHaveBeenCalled()
  })
})

describe("withSubprotocolHeader", () => {
  it("sends the same comma-separated list the browser constructor would", () => {
    expect(withSubprotocolHeader(undefined, ["cognia.chat.v1", "st_ticket"])).toEqual({
      "Sec-WebSocket-Protocol": "cognia.chat.v1, st_ticket",
    })
  })

  it("keeps the caller's headers beside it", () => {
    expect(withSubprotocolHeader({ Authorization: "Bearer x" }, ["p"])).toEqual({
      Authorization: "Bearer x",
      "Sec-WebSocket-Protocol": "p",
    })
  })

  it("leaves the headers untouched when there is no subprotocol", () => {
    expect(withSubprotocolHeader({ Authorization: "Bearer x" }, [])).toEqual({
      Authorization: "Bearer x",
    })
    expect(withSubprotocolHeader(undefined, undefined)).toBeUndefined()
  })
})
