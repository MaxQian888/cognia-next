import http from "node:http"
import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"

import { ProbeTransportError } from "../core/types"
import { classifyNetworkError, createNodeTransport } from "./transport"

interface UpgradeServer {
  url: string
  origins: Array<string | string[] | undefined>
  close(): Promise<void>
}

const servers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** A loopback WebSocket server that records the Origin header of each upgrade. */
async function upgradeServer(
  opts: {
    refuseStatus?: number
    stallUpgrade?: boolean
    onConnection?: (socket: import("ws").WebSocket) => void
  } = {}
): Promise<UpgradeServer> {
  const origins: Array<string | string[] | undefined> = []
  const wss = new WebSocketServer({ noServer: true })
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end()
  })
  // Upgraded sockets leave the HTTP server's bookkeeping; track them so a
  // stalled handshake can be torn down.
  const upgraded = new Set<import("node:stream").Duplex>()
  server.on("upgrade", (req, socket, head) => {
    upgraded.add(socket)
    origins.push(req.headers.origin)
    // A repeated header would show up joined; count raw occurrences too.
    const raw = req.rawHeaders.filter(
      (_v, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === "origin"
    )
    if (raw.length > 1) origins.push(`DUPLICATE x${raw.length}`)
    if (opts.stallUpgrade) return
    if (opts.refuseStatus) {
      socket.end(
        `HTTP/1.1 ${opts.refuseStatus} Refused\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`
      )
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => opts.onConnection?.(ws))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const handle = {
    url: `ws://127.0.0.1:${port}/signaling?rid=room`,
    origins,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        for (const socket of upgraded) socket.destroy()
        wss.close()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  servers.push(handle)
  return handle
}

async function httpServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const signal = () => new AbortController().signal

describe("openSocket Origin handling", () => {
  it("sends no Origin header for the native profile", async () => {
    const server = await upgradeServer()
    const socket = await createNodeTransport().openSocket(server.url, {
      origin: null,
      timeoutMs: 2_000,
      signal: signal(),
    })
    socket.close()
    await socket.closed
    expect(server.origins).toEqual([undefined])
  })

  it.each(["https://cognia.cn", "capacitor://localhost", "https://localhost"])(
    "sends exactly one Origin: %s",
    async (origin) => {
      const server = await upgradeServer()
      const socket = await createNodeTransport().openSocket(server.url, {
        origin,
        timeoutMs: 2_000,
        signal: signal(),
      })
      socket.close()
      await socket.closed
      expect(server.origins).toEqual([origin])
    }
  )

  it("reports a refused upgrade with its HTTP status", async () => {
    const server = await upgradeServer({ refuseStatus: 403 })
    const error = await createNodeTransport()
      .openSocket(server.url, {
        origin: "https://evil.example",
        timeoutMs: 2_000,
        signal: signal(),
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProbeTransportError)
    expect(error).toMatchObject({ reason: "ws_upgrade", httpStatus: 403 })
  })

  it("reports other upgrade statuses", async () => {
    const server = await upgradeServer({ refuseStatus: 502 })
    await expect(
      createNodeTransport().openSocket(server.url, {
        origin: null,
        timeoutMs: 2_000,
        signal: signal(),
      })
    ).rejects.toMatchObject({ reason: "ws_upgrade", httpStatus: 502 })
  })

  it("times out a stalled handshake", async () => {
    const server = await upgradeServer({ stallUpgrade: true })
    const started = Date.now()
    await expect(
      createNodeTransport().openSocket(server.url, {
        origin: null,
        timeoutMs: 200,
        signal: signal(),
      })
    ).rejects.toMatchObject({ reason: "timeout" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("classifies a refused connection", async () => {
    const server = await upgradeServer()
    const url = server.url
    await server.close()
    await expect(
      createNodeTransport().openSocket(url, { origin: null, timeoutMs: 1_000, signal: signal() })
    ).rejects.toMatchObject({ reason: "connect_error" })
  })

  it("rejects promptly when aborted mid-handshake", async () => {
    const server = await upgradeServer({ stallUpgrade: true })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    await expect(
      createNodeTransport().openSocket(server.url, {
        origin: null,
        timeoutMs: 10_000,
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(ProbeTransportError)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("NodeProbeSocket", () => {
  it("buffers frames in order and keeps a late frame after a timed-out read", async () => {
    let serverSide: import("ws").WebSocket | null = null
    const server = await upgradeServer({
      onConnection: (ws) => {
        serverSide = ws
        ws.send('{"kind":"challenge","n":1}')
        ws.send('{"kind":"x","n":2}')
        ws.on("message", (data) => ws.send(`echo:${data.toString()}`))
      },
    })
    const socket = await createNodeTransport().openSocket(server.url, {
      origin: null,
      timeoutMs: 2_000,
      signal: signal(),
    })
    expect(await socket.next(1_000)).toBe('{"kind":"challenge","n":1}')
    expect(await socket.next(1_000)).toBe('{"kind":"x","n":2}')
    await expect(socket.next(50)).rejects.toMatchObject({ reason: "timeout" })
    serverSide!.send("late")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await socket.next(1_000)).toBe("late")
    socket.send("hi")
    expect(await socket.next(1_000)).toBe("echo:hi")
    socket.close()
    await socket.closed
    await expect(socket.next(100)).rejects.toMatchObject({ reason: "ws_closed" })
    expect(() => socket.send("after close")).toThrow(ProbeTransportError)
  })

  it("rejects a pending read when the server closes", async () => {
    let serverSide: import("ws").WebSocket | null = null
    const server = await upgradeServer({ onConnection: (ws) => (serverSide = ws) })
    const socket = await createNodeTransport().openSocket(server.url, {
      origin: null,
      timeoutMs: 2_000,
      signal: signal(),
    })
    const pending = socket.next(5_000)
    serverSide!.close(1001, "going away")
    await expect(pending).rejects.toMatchObject({ reason: "ws_closed" })
    await socket.closed
  })

  it("force-terminates when the peer never completes the close handshake", async () => {
    const server = await upgradeServer({
      onConnection: (ws) => {
        // Swallow the close frame: never answer it.
        const raw = (ws as unknown as { _socket: import("node:net").Socket })._socket
        raw.removeAllListeners("data")
      },
    })
    const socket = await createNodeTransport({ forceCloseAfterMs: 150 }).openSocket(server.url, {
      origin: null,
      timeoutMs: 2_000,
      signal: signal(),
    })
    const started = Date.now()
    socket.close()
    await socket.closed
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("getJson", () => {
  const transport = createNodeTransport()

  it("parses JSON bodies and keeps the status", async () => {
    const base = await httpServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" }).end('{"ok":false}')
    })
    expect(
      await transport.getJson(`${base}/healthz`, { timeoutMs: 2_000, signal: signal() })
    ).toEqual({
      status: 503,
      body: { ok: false },
      parseError: false,
    })
  })

  it("flags non-JSON and oversized bodies", async () => {
    const base = await httpServer((req, res) => {
      if (req.url === "/big") res.end("x".repeat(200 * 1024))
      else if (req.url === "/empty") res.end("")
      else res.end("<html>not json</html>")
    })
    expect(
      await transport.getJson(`${base}/html`, { timeoutMs: 2_000, signal: signal() })
    ).toMatchObject({
      status: 200,
      parseError: true,
    })
    expect(
      await transport.getJson(`${base}/big`, { timeoutMs: 2_000, signal: signal() })
    ).toMatchObject({
      parseError: true,
    })
    expect(
      await transport.getJson(`${base}/empty`, { timeoutMs: 2_000, signal: signal() })
    ).toEqual({
      status: 200,
      body: undefined,
      parseError: false,
    })
  })

  it("does not follow redirects", async () => {
    const base = await httpServer((_req, res) => {
      res.writeHead(302, { location: "https://example.com/" }).end()
    })
    expect(
      (await transport.getJson(`${base}/healthz`, { timeoutMs: 2_000, signal: signal() })).status
    ).toBe(302)
  })

  it("times out a stalled response", async () => {
    const base = await httpServer(() => undefined)
    await expect(
      transport.getJson(`${base}/healthz`, { timeoutMs: 150, signal: signal() })
    ).rejects.toMatchObject({ reason: "timeout" })
  })

  it("classifies a refused connection", async () => {
    const base = await httpServer((_req, res) => res.end())
    await servers.pop()!.close()
    await expect(
      transport.getJson(`${base}/healthz`, { timeoutMs: 1_000, signal: signal() })
    ).rejects.toMatchObject({ reason: "connect_error" })
  })
})

describe("classifyNetworkError", () => {
  it.each([
    [{ cause: { code: "ENOTFOUND" } }, "dns_error"],
    [{ code: "EAI_AGAIN" }, "dns_error"],
    [{ cause: { code: "CERT_HAS_EXPIRED" } }, "tls_error"],
    [{ cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }, "tls_error"],
    [{ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }, "tls_error"],
    [{ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }, "timeout"],
    [{ name: "TimeoutError" }, "timeout"],
    [{ cause: { code: "ECONNREFUSED" } }, "connect_error"],
    [{ cause: { code: "ECONNRESET" } }, "connect_error"],
    [new Error("opaque"), "connect_error"],
  ])("%j → %s", (error, reason) => {
    expect(classifyNetworkError(error)).toBe(reason)
  })
})
