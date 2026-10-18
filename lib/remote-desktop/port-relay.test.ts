/** @jest-environment jsdom */
import {
  CHANNEL_CHUNK_BYTES,
  MAX_RELAY_FRAME_BYTES,
  REMOTE_DESKTOP_PORT_MESSAGE,
  startRemoteDesktopRelay,
} from "./port-relay"

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = 0
  binaryType = "blob"
  sent: ArrayBuffer[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  close = jest.fn(() => {
    this.readyState = 3
  })
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {}
  send(data: ArrayBuffer) {
    this.sent.push(data)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}

/** A synchronous stand-in for MessageChannel so the test sees each hop. */
function fakeChannel() {
  const port1 = {
    sent: [] as unknown[],
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: jest.fn(function (this: { sent: unknown[] }, data: unknown) {
      port1.sent.push(data)
    }),
    close: jest.fn(),
    start: jest.fn(),
  }
  const port2 = { name: "page-end" }
  return { port1, port2 } as unknown as MessageChannel & {
    port1: typeof port1
  }
}

function setup(post = jest.fn(() => true)) {
  let socket!: FakeSocket
  const channel = fakeChannel()
  const onStatus = jest.fn()
  const onError = jest.fn()
  const stop = startRemoteDesktopRelay({
    connection: "ws://127.0.0.1:4100/rd/ticket",
    mode: "view",
    post,
    onStatus,
    onError,
    createSocket: (url, protocols) => (socket = new FakeSocket(url, protocols)) as never,
    createChannel: () => channel,
  })
  return {
    socket,
    channel: channel as unknown as ReturnType<typeof fakeChannel>,
    post,
    onStatus,
    onError,
    stop,
  }
}

describe("remote desktop port relay", () => {
  beforeAll(() => {
    ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
  })

  it("hands the page a port, never the URL, once the bridge is open", () => {
    const { socket, channel, post, onStatus } = setup()
    expect(socket.protocols).toEqual(["binary"])
    expect(socket.binaryType).toBe("arraybuffer")
    expect(post).not.toHaveBeenCalled()
    socket.open()
    expect(post).toHaveBeenCalledWith({ type: REMOTE_DESKTOP_PORT_MESSAGE, mode: "view" }, [
      channel.port2,
    ])
    expect(JSON.stringify(post.mock.calls)).not.toContain("ticket")
    expect(onStatus).toHaveBeenLastCalledWith("connected")
  })

  it("moves bytes both ways and ignores non-binary socket data", () => {
    const { socket, channel } = setup()
    socket.open()
    const down = new Uint8Array([1, 2, 3]).buffer
    socket.onmessage?.({ data: down } as MessageEvent)
    socket.onmessage?.({ data: "text" } as MessageEvent)
    expect(channel.port1.sent).toEqual([down])
    channel.port1.onmessage?.({ data: new Uint8Array([9, 8]) } as MessageEvent)
    expect(Array.from(new Uint8Array(socket.sent[0]!))).toEqual([9, 8])
  })

  it("refuses an oversized frame from the page and closes", () => {
    const { socket, channel, onError, onStatus } = setup()
    socket.open()
    channel.port1.onmessage?.({ data: new ArrayBuffer(MAX_RELAY_FRAME_BYTES + 1) } as MessageEvent)
    expect(onError).toHaveBeenCalledWith("remote_desktop_protocol_invalid")
    expect(socket.close).toHaveBeenCalled()
    expect(onStatus).toHaveBeenLastCalledWith("disconnected")
  })

  it("closes on the page's request, on socket close, and on stop, once", () => {
    const { socket, channel, onStatus, stop } = setup()
    socket.open()
    channel.port1.onmessage?.({ data: { type: "close" } } as MessageEvent)
    expect(channel.port1.sent).toContainEqual({ type: "closed" })
    expect(socket.close).toHaveBeenCalledTimes(1)
    stop()
    socket.onclose?.()
    expect(onStatus.mock.calls.filter(([status]) => status === "disconnected")).toHaveLength(1)
  })

  it("reports a frame that could not take the port", () => {
    const { socket, onError } = setup(jest.fn(() => false))
    socket.open()
    expect(onError).toHaveBeenCalledWith("remote_desktop_viewer_failed")
    expect(socket.close).toHaveBeenCalled()
  })

  it("relays an attached channel without opening a socket", () => {
    const sent: unknown[] = []
    const raw = {
      binaryType: "blob",
      protocol: "",
      readyState: "open",
      onopen: null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null,
      send: (data: unknown) => sent.push(data),
      close: jest.fn(),
    }
    const channel = fakeChannel()
    const post = jest.fn(() => true)
    const onStatus = jest.fn()
    const createSocket = jest.fn()
    const stop = startRemoteDesktopRelay({
      connection: raw as never,
      mode: "control",
      post,
      onStatus,
      onError: jest.fn(),
      createSocket: createSocket as never,
      createChannel: () => channel,
    })
    expect(createSocket).not.toHaveBeenCalled()
    expect(raw.binaryType).toBe("arraybuffer")
    expect(post).toHaveBeenCalledWith({ type: REMOTE_DESKTOP_PORT_MESSAGE, mode: "control" }, [
      channel.port2,
    ])
    expect(onStatus).toHaveBeenLastCalledWith("connected")
    const down = new Uint8Array([4]).buffer
    raw.onmessage?.({ data: down } as MessageEvent)
    expect((channel as unknown as ReturnType<typeof fakeChannel>).port1.sent).toEqual([down])
    ;(channel as unknown as ReturnType<typeof fakeChannel>).port1.onmessage?.({
      data: new Uint8Array([5]),
    } as MessageEvent)
    expect(sent).toHaveLength(1)
    // A large page frame reaches the channel in 16 KiB pieces.
    ;(channel as unknown as ReturnType<typeof fakeChannel>).port1.onmessage?.({
      data: new ArrayBuffer(CHANNEL_CHUNK_BYTES * 2 + 1),
    } as MessageEvent)
    expect(sent.slice(1).map((piece) => (piece as ArrayBuffer).byteLength)).toEqual([
      CHANNEL_CHUNK_BYTES,
      CHANNEL_CHUNK_BYTES,
      1,
    ])
    stop()
    expect(raw.close).toHaveBeenCalledTimes(1)
  })
})
