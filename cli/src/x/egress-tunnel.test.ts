/**
 * Unit tests for `cli/src/x/egress-tunnel.ts`.
 *
 * Every proxy here is an in-process `net` server: nothing leaves the
 * machine, no real upstream is contacted, and no credential is real.
 */

import http from "node:http"
import net from "node:net"
import type tls from "node:tls"
import { AddressInfo } from "node:net"
import {
  TunnelError,
  createTunnelAgent,
  formatAuthority,
  openTunnel,
  parseProxyUrl,
} from "./egress-tunnel"

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

interface Closeable {
  port: number
  close: () => Promise<void>
}

function listen(server: net.Server | http.Server): Promise<Closeable> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

/** A plain HTTP target that echoes the path and the Host header. */
async function startTarget(): Promise<Closeable & { hits: string[] }> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} host=${req.headers.host}`)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ path: req.url }))
  })
  const handle = await listen(server)
  return { ...handle, hits }
}

interface ConnectProxyOptions {
  /** Require this `Proxy-Authorization` header value, answer 407 otherwise. */
  requireAuth?: string
  /** Refuse every CONNECT with this status. */
  refuseWith?: number
  /** Answer with garbage instead of HTTP. */
  garbage?: boolean
}

/** An HTTP CONNECT proxy that records the authorities it was asked for. */
async function startConnectProxy(
  options: ConnectProxyOptions = {}
): Promise<Closeable & { connects: string[] }> {
  const connects: string[] = []
  const server = net.createServer((client) => {
    let head = ""
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1")
      const end = head.indexOf("\r\n\r\n")
      if (end === -1) return
      client.off("data", onData)
      const lines = head.slice(0, end).split("\r\n")
      const [method, authority] = lines[0]!.split(" ")
      connects.push(authority!)
      if (options.garbage) {
        client.end("not http at all\r\n\r\n")
        return
      }
      if (method !== "CONNECT") {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n")
        return
      }
      if (options.requireAuth) {
        const auth = lines.find((line) => /^proxy-authorization:/i.test(line))
        if (!auth || auth.split(":").slice(1).join(":").trim() !== options.requireAuth) {
          client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
          return
        }
      }
      if (options.refuseWith) {
        client.end(`HTTP/1.1 ${options.refuseWith} Forbidden\r\n\r\n`)
        return
      }
      const [host, port] = authority!.split(":")
      const upstream = net.connect({ host: host!, port: Number(port) }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        // Surplus bytes after the header belong to the tunnel.
        const surplus = head.slice(end + 4)
        if (surplus) upstream.write(Buffer.from(surplus, "latin1"))
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on("error", () => client.destroy())
      client.on("error", () => upstream.destroy())
    }
    client.on("data", onData)
    client.on("error", () => {})
  })
  const handle = await listen(server)
  return { ...handle, connects }
}

interface SocksProxyOptions {
  /** Require RFC 1929 username/password. */
  credentials?: { username: string; password: string }
  /** Reply code to refuse every CONNECT with. */
  refuseWith?: number
}

/** A SOCKS5 proxy that records the (domain, port) targets it saw. */
async function startSocksProxy(
  options: SocksProxyOptions = {}
): Promise<Closeable & { targets: string[] }> {
  const targets: string[] = []
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0)
    let stage: "greet" | "auth" | "request" | "tunnel" = "greet"
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (stage === "greet") {
          if (buffer.length < 2) return
          const count = buffer[1]!
          if (buffer.length < 2 + count) return
          const offered = [...buffer.subarray(2, 2 + count)]
          buffer = buffer.subarray(2 + count)
          if (options.credentials) {
            if (!offered.includes(0x02)) {
              client.end(Buffer.from([0x05, 0xff]))
              return
            }
            client.write(Buffer.from([0x05, 0x02]))
            stage = "auth"
          } else {
            client.write(Buffer.from([0x05, 0x00]))
            stage = "request"
          }
          continue
        }
        if (stage === "auth") {
          if (buffer.length < 2) return
          const ulen = buffer[1]!
          if (buffer.length < 2 + ulen + 1) return
          const plen = buffer[2 + ulen]!
          if (buffer.length < 3 + ulen + plen) return
          const username = buffer.subarray(2, 2 + ulen).toString("utf8")
          const password = buffer.subarray(3 + ulen, 3 + ulen + plen).toString("utf8")
          buffer = buffer.subarray(3 + ulen + plen)
          const ok =
            username === options.credentials!.username && password === options.credentials!.password
          client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
          if (!ok) {
            client.end()
            return
          }
          stage = "request"
          continue
        }
        if (stage === "request") {
          if (buffer.length < 5) return
          if (buffer[3] !== 0x03) {
            client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            return
          }
          const hlen = buffer[4]!
          if (buffer.length < 5 + hlen + 2) return
          const host = buffer.subarray(5, 5 + hlen).toString("utf8")
          const port = buffer.readUInt16BE(5 + hlen)
          buffer = buffer.subarray(5 + hlen + 2)
          targets.push(`${host}:${port}`)
          if (options.refuseWith !== undefined) {
            client.end(Buffer.from([0x05, options.refuseWith, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            return
          }
          stage = "tunnel"
          const upstream = net.connect({ host, port }, () => {
            // Bound address as a domain, to exercise the variable-length branch.
            const bound = Buffer.from("proxy.local", "utf8")
            client.write(
              Buffer.concat([
                Buffer.from([0x05, 0x00, 0x00, 0x03, bound.length]),
                bound,
                Buffer.from([0x00, 0x50]),
              ])
            )
            client.off("data", onData)
            if (buffer.length) upstream.write(buffer)
            client.pipe(upstream)
            upstream.pipe(client)
          })
          upstream.on("error", () => client.destroy())
          client.on("error", () => upstream.destroy())
          return
        }
        return
      }
    }
    client.on("data", onData)
    client.on("error", () => {})
  })
  const handle = await listen(server)
  return { ...handle, targets }
}

/** GET through an agent and collect the body. */
function get(url: string, agent: http.Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { agent }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
      )
    })
    req.on("error", reject)
    req.end()
  })
}

// ────────────────────────────────────────────────────────────────────────────
// parseProxyUrl
// ────────────────────────────────────────────────────────────────────────────

describe("parseProxyUrl", () => {
  it("parses http, https, socks5 and socks5h with default ports", () => {
    expect(parseProxyUrl("http://proxy.corp")).toEqual({
      protocol: "http",
      host: "proxy.corp",
      port: 80,
    })
    expect(parseProxyUrl("https://proxy.corp")).toEqual({
      protocol: "https",
      host: "proxy.corp",
      port: 443,
    })
    expect(parseProxyUrl("socks5://127.0.0.1")).toEqual({
      protocol: "socks5",
      host: "127.0.0.1",
      port: 1080,
    })
    expect(parseProxyUrl("socks5h://[::1]:9050")).toEqual({
      protocol: "socks5",
      host: "::1",
      port: 9050,
    })
  })

  it("decodes percent-encoded credentials", () => {
    expect(parseProxyUrl("http://us%40er:p%3Ass@proxy:8080")).toEqual({
      protocol: "http",
      host: "proxy",
      port: 8080,
      username: "us@er",
      password: "p:ss",
    })
  })

  it("refuses schemes the desktop policy does not know", () => {
    expect(() => parseProxyUrl("ftp://proxy:21")).toThrow(TunnelError)
    expect(() => parseProxyUrl("proxy:8080")).toThrow(/not supported|not a valid URL/)
    expect(() => parseProxyUrl("")).toThrow(TunnelError)
  })

  it("formats IPv6 authorities with brackets", () => {
    expect(formatAuthority("::1", 8080)).toBe("[::1]:8080")
    expect(formatAuthority("proxy", 8080)).toBe("proxy:8080")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// HTTP CONNECT
// ────────────────────────────────────────────────────────────────────────────

describe("openTunnel over HTTP CONNECT", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  it("reaches the target through the proxy and pools connections in the agent", async () => {
    const target = await startTarget()
    const proxy = await startConnectProxy()
    cleanups.push(target.close, proxy.close)

    const agent = createTunnelAgent(
      { protocol: "http", host: "127.0.0.1", port: proxy.port },
      false
    )
    const first = await get(`http://127.0.0.1:${target.port}/one`, agent)
    const second = await get(`http://127.0.0.1:${target.port}/two`, agent)
    agent.destroy()

    expect(first).toEqual({ status: 200, body: JSON.stringify({ path: "/one" }) })
    expect(second.body).toBe(JSON.stringify({ path: "/two" }))
    expect(target.hits).toEqual([
      `GET /one host=127.0.0.1:${target.port}`,
      `GET /two host=127.0.0.1:${target.port}`,
    ])
    // keep-alive: one CONNECT served both requests.
    expect(proxy.connects).toEqual([`127.0.0.1:${target.port}`])
  })

  it("sends Proxy-Authorization and surfaces a 407 as proxy-auth-required", async () => {
    const target = await startTarget()
    const expected = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`
    const proxy = await startConnectProxy({ requireAuth: expected })
    cleanups.push(target.close, proxy.close)

    const socket = await openTunnel(
      {
        protocol: "http",
        host: "127.0.0.1",
        port: proxy.port,
        username: "alice",
        password: "s3cret",
      },
      { host: "127.0.0.1", port: target.port, tls: false }
    )
    socket.destroy()

    await expect(
      openTunnel(
        { protocol: "http", host: "127.0.0.1", port: proxy.port },
        { host: "127.0.0.1", port: target.port, tls: false }
      )
    ).rejects.toMatchObject({ code: "proxy-auth-required" })
  })

  it("reports a refused CONNECT and a non-HTTP proxy distinctly", async () => {
    const refusing = await startConnectProxy({ refuseWith: 403 })
    const garbage = await startConnectProxy({ garbage: true })
    cleanups.push(refusing.close, garbage.close)

    await expect(
      openTunnel(
        { protocol: "http", host: "127.0.0.1", port: refusing.port },
        { host: "example.invalid", port: 443, tls: false }
      )
    ).rejects.toMatchObject({ code: "proxy-refused" })
    await expect(
      openTunnel(
        { protocol: "http", host: "127.0.0.1", port: garbage.port },
        { host: "example.invalid", port: 443, tls: false }
      )
    ).rejects.toMatchObject({ code: "proxy-handshake" })
  })

  it("reports an unreachable proxy without touching the target", async () => {
    const closed = await startConnectProxy()
    await closed.close()
    await expect(
      openTunnel(
        { protocol: "http", host: "127.0.0.1", port: closed.port },
        { host: "example.invalid", port: 443, tls: false }
      )
    ).rejects.toMatchObject({ code: "proxy-unreachable" })
  })

  it("times out a proxy that never answers", async () => {
    // Drain what the client sends (a paused socket with unread bytes never
    // reaches `end`, which would keep the fixture open after the timeout).
    const silent = net.createServer((socket) => socket.resume())
    const handle = await listen(silent)
    cleanups.push(handle.close)
    await expect(
      openTunnel(
        { protocol: "http", host: "127.0.0.1", port: handle.port },
        { host: "example.invalid", port: 443, tls: false },
        { timeoutMs: 50 }
      )
    ).rejects.toMatchObject({ code: "proxy-timeout" })
  })

  it("wraps the tunneled socket in TLS to the target with the right SNI", async () => {
    const target = await startTarget()
    const proxy = await startConnectProxy()
    cleanups.push(target.close, proxy.close)
    const tlsCalls: tls.ConnectionOptions[] = []
    const socket = await openTunnel(
      { protocol: "http", host: "127.0.0.1", port: proxy.port },
      {
        host: "api.example.invalid",
        port: target.port,
        tls: true,
        servername: "api.example.invalid",
      },
      {
        // The CONNECT proxy above dials by authority, so point it at the local target.
        connect: (options) => net.connect(options),
        tlsConnect: (options) => {
          tlsCalls.push(options)
          return options.socket as tls.TLSSocket
        },
      }
    ).catch((error: TunnelError) => error)
    // The fake proxy cannot resolve `api.example.invalid`, so the tunnel is refused
    // before TLS. What matters is that TLS is never attempted to the proxy itself.
    expect(socket).toBeInstanceOf(TunnelError)
    expect(tlsCalls).toEqual([])

    const direct = await openTunnel(
      { protocol: "http", host: "127.0.0.1", port: proxy.port },
      { host: "127.0.0.1", port: target.port, tls: true, servername: "api.example.invalid" },
      {
        tlsConnect: (options) => {
          tlsCalls.push(options)
          return options.socket as tls.TLSSocket
        },
      }
    )
    direct.destroy()
    expect(tlsCalls).toHaveLength(1)
    expect(tlsCalls[0]!.servername).toBe("api.example.invalid")
    expect(tlsCalls[0]!.socket).toBeDefined()
  })

  it("speaks TLS to an https:// proxy before CONNECT", async () => {
    const target = await startTarget()
    const proxy = await startConnectProxy()
    cleanups.push(target.close, proxy.close)
    const tlsCalls: tls.ConnectionOptions[] = []
    const socket = await openTunnel(
      { protocol: "https", host: "127.0.0.1", port: proxy.port },
      { host: "127.0.0.1", port: target.port, tls: false },
      {
        tlsConnect: (options) => {
          tlsCalls.push(options)
          const raw = options.socket as tls.TLSSocket
          // Pretend the handshake with the proxy completed.
          process.nextTick(() => raw.emit("secureConnect"))
          return raw
        },
      }
    )
    socket.destroy()
    expect(tlsCalls).toHaveLength(1)
    expect(tlsCalls[0]!.servername).toBe("127.0.0.1")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// SOCKS5
// ────────────────────────────────────────────────────────────────────────────

describe("openTunnel over SOCKS5", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  it("connects with no-auth and sends the target as a domain name", async () => {
    const target = await startTarget()
    const proxy = await startSocksProxy()
    cleanups.push(target.close, proxy.close)

    const agent = createTunnelAgent(
      { protocol: "socks5", host: "127.0.0.1", port: proxy.port },
      false
    )
    const res = await get(`http://127.0.0.1:${target.port}/socks`, agent)
    agent.destroy()
    expect(res).toEqual({ status: 200, body: JSON.stringify({ path: "/socks" }) })
    expect(proxy.targets).toEqual([`127.0.0.1:${target.port}`])
  })

  it("authenticates with username/password when the proxy asks", async () => {
    const target = await startTarget()
    const proxy = await startSocksProxy({ credentials: { username: "bob", password: "pw" } })
    cleanups.push(target.close, proxy.close)

    const ok = await openTunnel(
      { protocol: "socks5", host: "127.0.0.1", port: proxy.port, username: "bob", password: "pw" },
      { host: "127.0.0.1", port: target.port, tls: false }
    )
    ok.destroy()

    await expect(
      openTunnel(
        {
          protocol: "socks5",
          host: "127.0.0.1",
          port: proxy.port,
          username: "bob",
          password: "no",
        },
        { host: "127.0.0.1", port: target.port, tls: false }
      )
    ).rejects.toMatchObject({ code: "proxy-auth-required" })

    await expect(
      openTunnel(
        { protocol: "socks5", host: "127.0.0.1", port: proxy.port },
        { host: "127.0.0.1", port: target.port, tls: false }
      )
    ).rejects.toMatchObject({ code: "proxy-auth-required" })
  })

  it("maps a SOCKS reply code to proxy-refused with the RFC text", async () => {
    const proxy = await startSocksProxy({ refuseWith: 0x05 })
    cleanups.push(proxy.close)
    await expect(
      openTunnel(
        { protocol: "socks5", host: "127.0.0.1", port: proxy.port },
        { host: "example.invalid", port: 443, tls: false }
      )
    ).rejects.toMatchObject({ code: "proxy-refused", message: expect.stringContaining("refused") })
  })
})

describe("createTunnelAgent", () => {
  it("registers the agent under the protocol the request will use", () => {
    const endpoint = { protocol: "http" as const, host: "127.0.0.1", port: 1 }
    const protocolOf = (agent: unknown) => (agent as { protocol?: string }).protocol
    expect(protocolOf(createTunnelAgent(endpoint, false))).toBe("http:")
    expect(protocolOf(createTunnelAgent(endpoint, true))).toBe("https:")
  })
})
