/**
 * Outbound proxy tunnels for `cognia-agent x`.
 *
 * The Node fallback proxy (`proxy-server.ts`) forwards an agent's API calls
 * to the upstream provider. When the launch has an egress proxy, that hop
 * must go THROUGH it, the same proxy the desktop's `crates/cognia-net`
 * policy would use. Otherwise the user's "everything through the proxy"
 * setting is silently false for exactly the traffic they care most about.
 *
 * Three proxy protocols, no dependencies:
 *   - `http://`: HTTP CONNECT tunnel (plain TCP to the proxy),
 *   - `https://`: HTTP CONNECT tunnel over TLS to the proxy,
 *   - `socks5://` / `socks5h://`: SOCKS5 CONNECT (RFC 1928), with optional
 *     username/password (RFC 1929). The target host is always sent as a
 *     domain name, so DNS resolves proxy-side (the `h` in `socks5h`).
 *
 * The tunnel is exposed as a Node `http.Agent` / `https.Agent` so every
 * `http.request` / `https.request` in the proxy pools connections through it
 * exactly as it would through a direct agent.
 */

import http from "node:http"
import https from "node:https"
import net from "node:net"
import type stream from "node:stream"
import tls from "node:tls"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type ProxyEndpointProtocol = "http" | "https" | "socks5"

export interface ProxyEndpoint {
  protocol: ProxyEndpointProtocol
  host: string
  port: number
  username?: string
  password?: string
}

export interface TunnelTarget {
  host: string
  port: number
  /** Wrap the tunneled socket in TLS to the target (an `https:` upstream). */
  tls: boolean
  /** SNI / certificate name. Defaults to `host`. */
  servername?: string
}

export type TunnelErrorCode =
  /** The proxy URL could not be understood. */
  | "proxy-invalid"
  /** TCP (or TLS) connection to the proxy itself failed. */
  | "proxy-unreachable"
  /** The proxy asked for credentials the launch does not have. */
  | "proxy-auth-required"
  /** The proxy answered but refused to open the tunnel. */
  | "proxy-refused"
  /** The proxy spoke something other than the expected protocol. */
  | "proxy-handshake"
  /** The handshake did not finish within the timeout. */
  | "proxy-timeout"

export class TunnelError extends Error {
  constructor(
    readonly code: TunnelErrorCode,
    message: string
  ) {
    super(message)
    this.name = "TunnelError"
  }
}

export interface TunnelDeps {
  /** TCP dialer (tests substitute an in-process one). */
  connect?: (options: net.NetConnectOpts) => net.Socket
  /** TLS wrapper (tests observe the target-side TLS call without certificates). */
  tlsConnect?: (options: tls.ConnectionOptions) => tls.TLSSocket
  /** Handshake timeout. Default 10 s. */
  timeoutMs?: number
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
const DEFAULT_PORTS: Record<ProxyEndpointProtocol, number> = {
  http: 80,
  https: 443,
  socks5: 1080,
}

// ────────────────────────────────────────────────────────────────────────────
// Proxy URL parsing
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse a proxy URL into an endpoint. Accepts the schemes the desktop policy
 * accepts (`http`, `https`, `socks5`) plus `socks5h` as an alias. Throws a
 * `TunnelError("proxy-invalid")` for anything else so the launch fails
 * before an agent starts, not on its first request.
 */
export function parseProxyUrl(raw: string): ProxyEndpoint {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new TunnelError("proxy-invalid", `proxy URL "${raw}" is not a valid URL`)
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase()
  const protocol: ProxyEndpointProtocol | undefined =
    scheme === "http"
      ? "http"
      : scheme === "https"
        ? "https"
        : scheme === "socks5" || scheme === "socks5h" || scheme === "socks"
          ? "socks5"
          : undefined
  if (!protocol) {
    throw new TunnelError(
      "proxy-invalid",
      `proxy scheme "${scheme}" is not supported (use http, https, socks5 or socks5h)`
    )
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  if (!host) {
    throw new TunnelError("proxy-invalid", `proxy URL "${raw}" has no host`)
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : DEFAULT_PORTS[protocol]
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TunnelError("proxy-invalid", `proxy URL "${raw}" has an invalid port`)
  }
  const username = parsed.username ? safeDecode(parsed.username) : undefined
  const password = parsed.password ? safeDecode(parsed.password) : undefined
  return {
    protocol,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** `host:port` with IPv6 literals bracketed. */
export function formatAuthority(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
}

// ────────────────────────────────────────────────────────────────────────────
// Byte reader for handshakes
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pulls exactly what each handshake step needs from the socket and hands any
 * surplus back with `socket.unshift`, so bytes the target sends right after
 * the tunnel opens are not lost.
 */
class SocketReader {
  private buffered: Buffer = Buffer.alloc(0)
  private waiter: { resolve: () => void; reject: (error: Error) => void } | null = null
  private failure: Error | null = null

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData)
    socket.on("error", this.onError)
    socket.on("close", this.onClose)
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffered = Buffer.concat([this.buffered, chunk])
    this.waiter?.resolve()
  }

  private readonly onError = (error: Error) => {
    this.failure = error
    this.waiter?.reject(error)
  }

  private readonly onClose = () => {
    const error = new TunnelError("proxy-handshake", "proxy closed the connection mid-handshake")
    this.failure = this.failure ?? error
    this.waiter?.reject(this.failure)
  }

  private async fill(): Promise<void> {
    if (this.failure) throw this.failure
    await new Promise<void>((resolve, reject) => {
      this.waiter = {
        resolve: () => {
          this.waiter = null
          resolve()
        },
        reject: (error) => {
          this.waiter = null
          reject(error)
        },
      }
    })
  }

  async readExact(length: number): Promise<Buffer> {
    while (this.buffered.length < length) await this.fill()
    const out = this.buffered.subarray(0, length)
    this.buffered = this.buffered.subarray(length)
    return Buffer.from(out)
  }

  /** Read up to and including the first occurrence of `marker`. */
  async readUntil(marker: Buffer, maxBytes: number): Promise<Buffer> {
    for (;;) {
      const index = this.buffered.indexOf(marker)
      if (index !== -1) {
        const end = index + marker.length
        const out = Buffer.from(this.buffered.subarray(0, end))
        this.buffered = this.buffered.subarray(end)
        return out
      }
      if (this.buffered.length > maxBytes) {
        throw new TunnelError("proxy-handshake", "proxy response exceeded the handshake limit")
      }
      await this.fill()
    }
  }

  /** Detach and give back any surplus bytes. */
  release(): void {
    this.socket.off("data", this.onData)
    this.socket.off("error", this.onError)
    this.socket.off("close", this.onClose)
    if (this.buffered.length > 0) {
      this.socket.unshift(this.buffered)
      this.buffered = Buffer.alloc(0)
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Handshakes
// ────────────────────────────────────────────────────────────────────────────

function basicAuth(proxy: ProxyEndpoint): string | undefined {
  if (!proxy.username) return undefined
  const pair = `${proxy.username}:${proxy.password ?? ""}`
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`
}

async function httpConnect(
  socket: net.Socket,
  reader: SocketReader,
  proxy: ProxyEndpoint,
  target: TunnelTarget
): Promise<void> {
  const authority = formatAuthority(target.host, target.port)
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    "Proxy-Connection: keep-alive",
  ]
  const auth = basicAuth(proxy)
  if (auth) lines.push(`Proxy-Authorization: ${auth}`)
  socket.write(`${lines.join("\r\n")}\r\n\r\n`)
  const head = (await reader.readUntil(Buffer.from("\r\n\r\n"), 64 * 1024)).toString("latin1")
  const statusLine = head.split("\r\n")[0] ?? ""
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
  if (!match) {
    throw new TunnelError(
      "proxy-handshake",
      `proxy did not answer CONNECT with HTTP: "${statusLine}"`
    )
  }
  const status = Number(match[1])
  if (status === 407) {
    throw new TunnelError(
      "proxy-auth-required",
      `proxy ${formatAuthority(proxy.host, proxy.port)} requires authentication (407)`
    )
  }
  if (status < 200 || status >= 300) {
    throw new TunnelError(
      "proxy-refused",
      `proxy ${formatAuthority(proxy.host, proxy.port)} refused CONNECT ${authority}: ${statusLine}`
    )
  }
}

const SOCKS_VERSION = 0x05
const SOCKS_AUTH_NONE = 0x00
const SOCKS_AUTH_PASSWORD = 0x02
const SOCKS_AUTH_UNACCEPTABLE = 0xff
const SOCKS_CMD_CONNECT = 0x01
const SOCKS_ATYP_IPV4 = 0x01
const SOCKS_ATYP_DOMAIN = 0x03
const SOCKS_ATYP_IPV6 = 0x04

const SOCKS_REPLY_TEXT: Record<number, string> = {
  0x01: "general SOCKS server failure",
  0x02: "connection not allowed by ruleset",
  0x03: "network unreachable",
  0x04: "host unreachable",
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
}

async function socks5Connect(
  socket: net.Socket,
  reader: SocketReader,
  proxy: ProxyEndpoint,
  target: TunnelTarget
): Promise<void> {
  const methods = proxy.username ? [SOCKS_AUTH_NONE, SOCKS_AUTH_PASSWORD] : [SOCKS_AUTH_NONE]
  socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]))
  const greeting = await reader.readExact(2)
  if (greeting[0] !== SOCKS_VERSION) {
    throw new TunnelError("proxy-handshake", "proxy is not a SOCKS5 server")
  }
  const chosen = greeting[1]
  if (chosen === SOCKS_AUTH_UNACCEPTABLE) {
    throw new TunnelError(
      "proxy-auth-required",
      `SOCKS5 proxy ${formatAuthority(proxy.host, proxy.port)} accepts none of the offered auth methods`
    )
  }
  if (chosen === SOCKS_AUTH_PASSWORD) {
    const user = Buffer.from(proxy.username ?? "", "utf8")
    const pass = Buffer.from(proxy.password ?? "", "utf8")
    if (user.length === 0 || user.length > 255 || pass.length > 255) {
      throw new TunnelError("proxy-invalid", "SOCKS5 credentials must be 1 to 255 bytes each")
    }
    socket.write(
      Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass])
    )
    const authReply = await reader.readExact(2)
    if (authReply[1] !== 0x00) {
      throw new TunnelError(
        "proxy-auth-required",
        `SOCKS5 proxy ${formatAuthority(proxy.host, proxy.port)} rejected the credentials`
      )
    }
  } else if (chosen !== SOCKS_AUTH_NONE) {
    throw new TunnelError("proxy-handshake", `SOCKS5 proxy chose unsupported auth method ${chosen}`)
  }

  const hostBytes = Buffer.from(target.host, "utf8")
  if (hostBytes.length === 0 || hostBytes.length > 255) {
    throw new TunnelError("proxy-invalid", "SOCKS5 target host must be 1 to 255 bytes")
  }
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(target.port)
  // Always ATYP=domain: the proxy resolves the name (socks5h semantics), so a
  // split-horizon upstream behind the proxy still resolves correctly.
  socket.write(
    Buffer.concat([
      Buffer.from([SOCKS_VERSION, SOCKS_CMD_CONNECT, 0x00, SOCKS_ATYP_DOMAIN, hostBytes.length]),
      hostBytes,
      portBytes,
    ])
  )
  const head = await reader.readExact(4)
  if (head[0] !== SOCKS_VERSION) {
    throw new TunnelError("proxy-handshake", "SOCKS5 proxy sent a malformed CONNECT reply")
  }
  const reply = head[1]!
  if (reply !== 0x00) {
    throw new TunnelError(
      "proxy-refused",
      `SOCKS5 proxy refused CONNECT ${formatAuthority(target.host, target.port)}: ${SOCKS_REPLY_TEXT[reply] ?? `reply ${reply}`}`
    )
  }
  // Consume the bound address so surplus bytes line up with the tunnel.
  switch (head[3]) {
    case SOCKS_ATYP_IPV4:
      await reader.readExact(4 + 2)
      break
    case SOCKS_ATYP_IPV6:
      await reader.readExact(16 + 2)
      break
    case SOCKS_ATYP_DOMAIN: {
      const length = (await reader.readExact(1))[0]!
      await reader.readExact(length + 2)
      break
    }
    default:
      throw new TunnelError("proxy-handshake", "SOCKS5 proxy sent an unknown bound address type")
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Open a tunnel
// ────────────────────────────────────────────────────────────────────────────

/**
 * Open a socket to `target` through `proxy`. Resolves with a socket the
 * caller can speak the target protocol on. When `target.tls` is set it is a
 * TLS socket already negotiated with the target.
 */
export async function openTunnel(
  proxy: ProxyEndpoint,
  target: TunnelTarget,
  deps: TunnelDeps = {}
): Promise<net.Socket> {
  const connect = deps.connect ?? ((options: net.NetConnectOpts) => net.connect(options))
  const tlsConnect = deps.tlsConnect ?? ((options: tls.ConnectionOptions) => tls.connect(options))
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS

  const raw = await new Promise<net.Socket>((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port })
    const onError = (error: Error) => {
      cleanup()
      reject(
        new TunnelError(
          "proxy-unreachable",
          `could not reach proxy ${formatAuthority(proxy.host, proxy.port)}: ${error.message}`
        )
      )
    }
    const onConnect = () => {
      cleanup()
      resolve(socket)
    }
    const cleanup = () => {
      socket.off("error", onError)
      socket.off("connect", onConnect)
    }
    socket.once("error", onError)
    socket.once("connect", onConnect)
  })

  // An `https://` proxy is spoken to over TLS before CONNECT.
  const proxySocket: net.Socket =
    proxy.protocol === "https"
      ? await new Promise<net.Socket>((resolve, reject) => {
          const secure = tlsConnect({ socket: raw, servername: proxy.host })
          const onError = (error: Error) => {
            secure.off("secureConnect", onOk)
            reject(
              new TunnelError(
                "proxy-unreachable",
                `TLS to proxy ${formatAuthority(proxy.host, proxy.port)} failed: ${error.message}`
              )
            )
          }
          const onOk = () => {
            secure.off("error", onError)
            resolve(secure)
          }
          secure.once("error", onError)
          secure.once("secureConnect", onOk)
        })
      : raw

  const reader = new SocketReader(proxySocket)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new TunnelError(
          "proxy-timeout",
          `proxy ${formatAuthority(proxy.host, proxy.port)} did not finish the handshake within ${timeoutMs} ms`
        )
      )
    }, timeoutMs)
  })
  try {
    const handshake =
      proxy.protocol === "socks5"
        ? socks5Connect(proxySocket, reader, proxy, target)
        : httpConnect(proxySocket, reader, proxy, target)
    await Promise.race([handshake, timeout])
  } catch (error) {
    proxySocket.destroy()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    reader.release()
  }

  if (!target.tls) return proxySocket
  return tlsConnect({
    socket: proxySocket,
    servername: target.servername ?? target.host,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Agents
// ────────────────────────────────────────────────────────────────────────────

type CreateConnectionCallback = (error: Error | null, socket: stream.Duplex) => void

function targetFrom(options: http.ClientRequestArgs, useTls: boolean): TunnelTarget {
  const host = options.hostname ?? options.host ?? "localhost"
  const port = Number(options.port ?? (useTls ? 443 : 80))
  const servername = (options as { servername?: string }).servername ?? host
  return { host, port, tls: useTls, servername }
}

/**
 * Node's `Agent.createConnection` contract: return a socket synchronously,
 * or return nothing and hand one to `callback` later. A tunnel is always
 * the asynchronous form.
 */
function connectThroughTunnel(
  proxy: ProxyEndpoint,
  deps: TunnelDeps,
  useTls: boolean,
  options: http.ClientRequestArgs,
  callback?: CreateConnectionCallback
): undefined {
  openTunnel(proxy, targetFrom(options, useTls), deps).then(
    (socket) => callback?.(null, socket),
    (error: Error) => callback?.(error, undefined as unknown as stream.Duplex)
  )
  return undefined
}

/** Plain-HTTP upstream through the proxy. */
class HttpTunnelAgent extends http.Agent {
  constructor(
    private readonly proxy: ProxyEndpoint,
    private readonly deps: TunnelDeps,
    options?: http.AgentOptions
  ) {
    super({ keepAlive: true, ...options })
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback?: CreateConnectionCallback
  ): undefined {
    return connectThroughTunnel(this.proxy, this.deps, false, options, callback)
  }
}

/** TLS upstream through the proxy. Registers as `https:` so `https.request` accepts it. */
class HttpsTunnelAgent extends https.Agent {
  constructor(
    private readonly proxy: ProxyEndpoint,
    private readonly deps: TunnelDeps,
    options?: https.AgentOptions
  ) {
    super({ keepAlive: true, ...options })
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback?: CreateConnectionCallback
  ): undefined {
    return connectThroughTunnel(this.proxy, this.deps, true, options, callback)
  }
}

/**
 * An agent for `http.request` (`targetTls: false`) or `https.request`
 * (`targetTls: true`) whose every connection is a tunnel through `proxy`.
 */
export function createTunnelAgent(
  proxy: ProxyEndpoint,
  targetTls: boolean,
  deps: TunnelDeps = {}
): http.Agent {
  return targetTls ? new HttpsTunnelAgent(proxy, deps) : new HttpTunnelAgent(proxy, deps)
}
