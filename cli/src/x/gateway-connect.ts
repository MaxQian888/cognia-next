/**
 * Gateway discovery and connection for `cognia x <agent>`.
 *
 * Attempts to connect to the existing cognia desktop gateway (Rust,
 * `crates/cognia-gateway/`). Falls back to starting a local Node.js proxy
 * when the gateway is not running.
 *
 * Credential for the desktop gateway, in order:
 *   1. an explicit gateway API key (`deps.gatewayApiKey`, `COGNIA_GATEWAY_KEY`),
 *   2. a route ticket minted for this launch (desktop bridge, then headless rpc),
 *   3. otherwise a typed error with the fix in it.
 * An upstream provider key is NEVER handed to the listener: it matches only
 * its own key store and ticket registry, so that could only ever 401, and it
 * would leak the real provider secret to an agent subprocess for nothing.
 */

import {
  mintRouteTicket,
  describeMintFailure,
  type MintRouteTicketResult,
  type TicketMintRequest,
} from "./mint-ticket"
import { startProxyServer, type ProxyConfig, type ProxyServer } from "./proxy-server"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type GatewayConnectionMode =
  /** The desktop gateway, authenticated with a route ticket minted for this launch. */
  | "desktop-gateway-ticket"
  /** The desktop gateway, authenticated with an explicit gateway API key. */
  | "desktop-gateway-key"
  /** The Node fallback proxy, using the CLI's own upstream provider keys. */
  | "node-proxy"

export interface GatewayConnection {
  /** Base URL the external agent should use (e.g. http://127.0.0.1:47823). */
  baseUrl: string
  /** Credential the external agent authenticates with. */
  apiKey: string
  /** Cleanup function to stop the proxy/gateway on exit. */
  shutdown: () => Promise<void>
  mode: GatewayConnectionMode
  /** Frozen family bindings when a ticket was minted. */
  modelBindings?: Record<string, string>
  ticketId?: string
}

export interface GatewayProbeResult {
  running: boolean
  baseUrl?: string
}

export interface GatewayConnectDeps {
  /** Override the gateway port to probe. Default: 47823. */
  gatewayPort?: number
  /** Override the gateway URL (loopback unless `allowRemoteGateway`). */
  gatewayUrl?: string
  /** Accept a non-loopback gateway URL. */
  allowRemoteGateway?: boolean
  /** Override the gateway API key (from env/file). */
  gatewayApiKey?: string
  /** What to mint a ticket for. Without it, only an explicit key can connect. */
  ticketRequest?: TicketMintRequest
  /** Injectable HTTP probe for testing. */
  probe?: (baseUrl: string) => Promise<GatewayProbeResult>
  /** Injectable ticket minter for testing. */
  mintTicket?: (request: TicketMintRequest) => Promise<MintRouteTicketResult>
  /** Injectable proxy factory for testing. */
  startProxy?: typeof startProxyServer
  env?: Record<string, string | undefined>
}

/** The gateway is reachable but no credential could be obtained for it. */
export class GatewayCredentialError extends Error {
  constructor(
    readonly gatewayUrl: string,
    readonly attempts: string
  ) {
    super(
      `the cognia gateway at ${gatewayUrl} is running but no credential could be obtained for it.\n` +
        `  ${attempts}\n` +
        `Fix: set ${GATEWAY_KEY_ENV} to a gateway API key (Settings → Gateway → Keys), ` +
        `or start the Cognia desktop app so a route ticket can be minted for this launch.`
    )
    this.name = "GatewayCredentialError"
  }
}

/** A non-loopback gateway URL was given without opting in. */
export class RemoteGatewayRefusedError extends Error {
  constructor(readonly gatewayUrl: string) {
    super(
      `${GATEWAY_URL_ENV}=${gatewayUrl} is not a loopback address. ` +
        `Pass --allow-remote-gateway to send this launch's credential to a remote listener.`
    )
    this.name = "RemoteGatewayRefusedError"
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Default port for the cognia gateway (see crates/cognia-gateway/src/lib.rs). */
export const DEFAULT_GATEWAY_PORT = 47823

/** Env var that overrides the gateway port. */
export const GATEWAY_PORT_ENV = "COGNIA_GATEWAY_PORT"

/** Env var that overrides the whole gateway URL (loopback unless allowed). */
export const GATEWAY_URL_ENV = "COGNIA_GATEWAY_URL"

/** Env var that provides the gateway API key directly. */
export const GATEWAY_KEY_ENV = "COGNIA_GATEWAY_KEY"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Probe
// ────────────────────────────────────────────────────────────────────────────

/**
 * Probe the gateway's /healthz endpoint to see if it's running.
 */
export async function probeDesktopGateway(
  baseUrl: string = `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`
): Promise<GatewayProbeResult> {
  const http = await import("node:http")
  const https = await import("node:https")
  const client = baseUrl.startsWith("https:") ? https : http
  return new Promise((resolve) => {
    const req = client.get(`${baseUrl.replace(/\/$/, "")}/healthz`, { timeout: 2_000 }, (res) => {
      res.resume()
      if (res.statusCode === 200) {
        res.on("end", () => resolve({ running: true, baseUrl }))
      } else {
        res.on("end", () => resolve({ running: false }))
      }
    })
    req.on("error", () => resolve({ running: false }))
    req.on("timeout", () => {
      req.destroy()
      resolve({ running: false })
    })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Connect
// ────────────────────────────────────────────────────────────────────────────

/** Where to look for the desktop gateway. */
export function resolveGatewayUrl(deps: GatewayConnectDeps = {}): string {
  const env = deps.env ?? process.env
  if (deps.gatewayUrl) return deps.gatewayUrl.replace(/\/$/, "")
  if (env[GATEWAY_URL_ENV]) return env[GATEWAY_URL_ENV]!.replace(/\/$/, "")
  const port =
    deps.gatewayPort ??
    (env[GATEWAY_PORT_ENV] ? parseInt(env[GATEWAY_PORT_ENV]!, 10) : DEFAULT_GATEWAY_PORT)
  return `http://127.0.0.1:${port}`
}

/**
 * Connect to the gateway (desktop or fallback proxy).
 *
 * @param proxyConfig - Upstream config for the fallback proxy, or a thunk so
 *                      the upstream keys are only materialized when the proxy
 *                      actually starts.
 * @param deps        - Injectable dependencies for testing
 */
export async function connectGateway(
  proxyConfig: ProxyConfig | (() => ProxyConfig),
  deps: GatewayConnectDeps = {}
): Promise<GatewayConnection> {
  const env = deps.env ?? process.env
  const gatewayUrl = resolveGatewayUrl(deps)
  if (!isLoopbackUrl(gatewayUrl) && !deps.allowRemoteGateway) {
    throw new RemoteGatewayRefusedError(gatewayUrl)
  }
  const probe = deps.probe ?? probeDesktopGateway

  const probeResult = await probe(gatewayUrl)
  if (probeResult.running) {
    const baseUrl = probeResult.baseUrl ?? gatewayUrl
    const explicitKey = deps.gatewayApiKey ?? env[GATEWAY_KEY_ENV]
    if (explicitKey) {
      return {
        baseUrl,
        apiKey: explicitKey,
        shutdown: async () => {},
        mode: "desktop-gateway-key",
      }
    }
    if (deps.ticketRequest) {
      const mint = deps.mintTicket ?? mintRouteTicket
      const result = await mint(deps.ticketRequest)
      if (result.outcome.ok) {
        return {
          baseUrl,
          apiKey: result.outcome.ticket.secret,
          shutdown: async () => {},
          mode: "desktop-gateway-ticket",
          modelBindings: result.outcome.ticket.modelBindings,
          ticketId: result.outcome.ticket.ticketId,
        }
      }
      throw new GatewayCredentialError(baseUrl, describeMintFailure(result.attempts))
    }
    throw new GatewayCredentialError(baseUrl, "no ticket request was supplied for this launch")
  }

  // Fallback: start the Node.js proxy with the CLI's own upstream keys.
  const startProxy = deps.startProxy ?? startProxyServer
  const config = typeof proxyConfig === "function" ? proxyConfig() : proxyConfig
  const proxy: ProxyServer = await startProxy(config)
  return {
    baseUrl: proxy.baseUrl,
    apiKey: proxy.apiKey,
    shutdown: proxy.shutdown,
    mode: "node-proxy",
  }
}
