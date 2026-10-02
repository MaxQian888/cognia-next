import { afterEach, describe, expect, it, vi } from "vitest"

import { ProbeTransportError } from "../../../probe/src/core/index"
import { createWorkerTransport } from "./worker-transport"

afterEach(() => {
  vi.restoreAllMocks()
})

/** Stub an upgrade: the Worker sees `client`, the test drives `server`. */
function stubUpgrade(): { server: WebSocket; requests: Request[] } {
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
  server.accept()
  const requests: Request[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push(new Request(input as RequestInfo, init as RequestInit))
    return new Response(null, { status: 101, webSocket: client })
  })
  return { server, requests }
}

const signal = () => new AbortController().signal

describe("Worker probe transport", () => {
  it("upgrades over https with the exact Origin and buffers frames in order", async () => {
    const { server, requests } = stubUpgrade()
    const socket = await createWorkerTransport().openSocket("wss://relay.test/signaling?rid=r1", {
      origin: "capacitor://localhost",
      timeoutMs: 1_000,
      signal: signal(),
    })
    expect(requests[0].url).toBe("https://relay.test/signaling?rid=r1")
    expect(requests[0].headers.get("upgrade")).toBe("websocket")
    expect(requests[0].headers.get("origin")).toBe("capacitor://localhost")
    server.send('{"kind":"challenge"}')
    server.send('{"kind":"second"}')
    await expect(socket.next(1_000)).resolves.toBe('{"kind":"challenge"}')
    await expect(socket.next(1_000)).resolves.toBe('{"kind":"second"}')
    socket.close()
    await socket.closed
  })

  it("sends no Origin for the native profile", async () => {
    const { requests } = stubUpgrade()
    await createWorkerTransport().openSocket("wss://relay.test/signaling", {
      origin: null,
      timeoutMs: 1_000,
      signal: signal(),
    })
    expect(requests[0].headers.get("origin")).toBeNull()
  })

  it("times out a read without losing a frame that arrives later", async () => {
    const { server } = stubUpgrade()
    const socket = await createWorkerTransport().openSocket("wss://relay.test/s", {
      origin: null,
      timeoutMs: 1_000,
      signal: signal(),
    })
    await expect(socket.next(20)).rejects.toMatchObject({ reason: "timeout" })
    server.send("late")
    await expect(socket.next(1_000)).resolves.toBe("late")
  })

  it("rejects pending and later reads once the server closes", async () => {
    const { server } = stubUpgrade()
    const socket = await createWorkerTransport().openSocket("wss://relay.test/s", {
      origin: null,
      timeoutMs: 1_000,
      signal: signal(),
    })
    const pending = socket.next(2_000)
    server.close(1011, "gone")
    await expect(pending).rejects.toMatchObject({ reason: "ws_closed" })
    await expect(socket.next(10)).rejects.toBeInstanceOf(ProbeTransportError)
    await socket.closed
  })

  it("classifies refused upgrades and edge failures", async () => {
    const transport = createWorkerTransport()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
    await expect(
      transport.openSocket("wss://relay.test/s", {
        origin: "https://evil.example",
        timeoutMs: 1_000,
        signal: signal(),
      })
    ).rejects.toMatchObject({ reason: "origin_rejected", httpStatus: 403 })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 403 }))
    await expect(
      transport.openSocket("wss://relay.test/s", {
        origin: null,
        timeoutMs: 1_000,
        signal: signal(),
      })
    ).rejects.toMatchObject({ reason: "ws_upgrade" })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 525 }))
    await expect(
      transport.getJson("https://relay.test/healthz", { timeoutMs: 1_000, signal: signal() })
    ).rejects.toMatchObject({
      reason: "tls_error",
    })
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("network"))
    await expect(
      transport.getJson("https://relay.test/healthz", { timeoutMs: 1_000, signal: signal() })
    ).rejects.toMatchObject({
      reason: "connect_error",
    })
  })

  it("parses health JSON and reports a non-JSON body", async () => {
    const transport = createWorkerTransport()
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ ok: true }))
    await expect(
      transport.getJson("https://relay.test/healthz", { timeoutMs: 1_000, signal: signal() })
    ).resolves.toEqual({
      status: 200,
      body: { ok: true },
      parseError: false,
    })
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("<html>", { status: 200 }))
    await expect(
      transport.getJson("https://relay.test/healthz", { timeoutMs: 1_000, signal: signal() })
    ).resolves.toMatchObject({
      parseError: true,
    })
  })
})
