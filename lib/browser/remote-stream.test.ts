import {
  RemoteBrowserStream,
  decodeRemoteBrowserFrame,
  remoteBrowserWebSocketUrl,
} from "./remote-stream"

function frameBytes(payload = new Uint8Array([0xff, 0xd8, 0xff])): ArrayBuffer {
  const bytes = new Uint8Array(24 + payload.length)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, 1)
  view.setUint8(1, 1)
  view.setUint16(2, 24)
  view.setUint32(4, 42)
  view.setUint16(8, 1280)
  view.setUint16(10, 720)
  view.setBigUint64(12, BigInt(123456))
  view.setUint32(20, payload.length)
  bytes.set(payload, 24)
  return bytes.buffer
}

class FakeSocket {
  binaryType = ""
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  send(value: string) {
    this.sent.push(value)
  }
  close() {
    this.onclose?.()
  }
}

it("decodes the fixed versioned JPEG frame header", () => {
  expect(decodeRemoteBrowserFrame(frameBytes())).toMatchObject({
    version: 1,
    codec: "jpeg",
    sequence: 42,
    width: 1280,
    height: 720,
    timestamp: 123456,
  })
})

it("rejects malformed or unsupported media frames", () => {
  expect(() => decodeRemoteBrowserFrame(new ArrayBuffer(3))).toThrow(/truncated/)
  const unsupported = frameBytes()
  new DataView(unsupported).setUint8(0, 2)
  expect(() => decodeRemoteBrowserFrame(unsupported)).toThrow(/version/)
})

it("builds a ticket-only browser stream URL", () => {
  const url = remoteBrowserWebSocketUrl("https://cloud.example.com/", "session/a", "one shot")
  expect(url).toBe("wss://cloud.example.com/ws/browser/session%2Fa?ticket=one+shot")
  expect(url).not.toContain("jwt")
})

it("acks frames and sends human input only with the current lease epoch", async () => {
  const socket = new FakeSocket()
  const onFrame = jest.fn()
  const onLease = jest.fn()
  const onEvent = jest.fn()
  const stream = new RemoteBrowserStream({
    sessionId: "browser-1",
    serverBaseUrl: "https://cloud.example.com",
    issueTicket: async () => ({ ticket: "once", expiresAt: Date.now() + 60_000 }),
    createSocket: () => socket as unknown as WebSocket,
    onFrame,
    onLease,
    onEvent,
  })

  await stream.connect()
  socket.onopen?.()
  socket.onmessage?.({ data: frameBytes() })
  expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ sequence: 42 }))
  expect(JSON.parse(socket.sent[0])).toMatchObject({
    version: 1,
    type: "frame.ack",
    payload: { sequence: 42 },
  })

  stream.takeover()
  expect(JSON.parse(socket.sent[1])).toMatchObject({ version: 1, type: "control.takeover" })
  socket.onmessage?.({
    data: JSON.stringify({
      version: 1,
      type: "result",
      payload: { lease: { epoch: 9, controller: { kind: "human", id: "device-1" } } },
    }),
  })
  expect(onLease).toHaveBeenCalledWith(expect.objectContaining({ epoch: 9 }))
  expect(stream.sendInput({ kind: "mouse", payload: { type: "mouseMoved", x: 10, y: 20 } })).toBe(
    true
  )
  expect(JSON.parse(socket.sent[2])).toMatchObject({
    type: "input",
    payload: { epoch: 9 },
  })
  socket.onmessage?.({
    data: JSON.stringify({
      version: 1,
      type: "event",
      payload: { kind: "pages.changed", activePageId: "page-2" },
    }),
  })
  expect(onEvent).toHaveBeenCalledWith({ kind: "pages.changed", activePageId: "page-2" })
})

it("does not send input before human takeover", async () => {
  const socket = new FakeSocket()
  const stream = new RemoteBrowserStream({
    sessionId: "browser-1",
    serverBaseUrl: "https://cloud.example.com",
    issueTicket: async () => ({ ticket: "once", expiresAt: Date.now() + 60_000 }),
    createSocket: () => socket as unknown as WebSocket,
  })
  await stream.connect()
  expect(stream.sendInput({ kind: "key", payload: { type: "keyDown", key: "x" } })).toBe(false)
  expect(socket.sent).toEqual([])
})
