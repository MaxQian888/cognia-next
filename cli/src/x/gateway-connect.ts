/**
 * Gateway discovery and connection for `cognia x <agent>`.
 *
 * Attempts to connect to the existing cognia desktop gateway (Rust,
 * `crates/cognia-gateway/`). Falls back to starting a local Node.js proxy
 * when the gateway is not running.
 */

import { startProxyServer, type ProxyConfig, type ProxyServer } from "./proxy-server"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface GatewayConnection {
  /** Base URL the external agent should use (e.g. http://127.0.0.1:47823). */
  baseUrl: string
  /** API key the external agent authenticates with. */
  apiKey: string
  /** Cleanup function to stop the proxy/gateway on exit. */
  shutdown: () => Promise<void>
  /** Whether this is the full Rust gateway or the Node fallback proxy. */
  mode: "desktop-gateway" | "node-proxy"
}

export interface GatewayProbeResult {
  running: boolean
  port?: number
}

export interface GatewayConnectDeps {
  /** Override the gateway port to probe. Default: 47823. */
  gatewayPort?: number
  /** Override the gateway API key (from env/file). */
  gatewayApiKey?: string
  /** Injectable HTTP probe for testing. */
  probe?: (port: number) => Promise<GatewayProbeResult>
  /** Injectable proxy factory for testing. */
  startProxy?: typeof startProxyServer
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Default port for the cognia gateway (see crates/cognia-gateway/src/lib.rs). */
export const DEFAULT_GATEWAY_PORT = 47823

/** Env var that overrides the gateway port. */
export const GATEWAY_PORT_ENV = "COGNIA_GATEWAY_PORT"

/** Env var that provides the gateway API key directly. */
export const GATEWAY_KEY_ENV = "COGNIA_GATEWAY_KEY"

// ────────────────────────────────────────────────────────────────────────────
// Probe
// ────────────────────────────────────────────────────────────────────────────

/**
 * Probe the desktop gateway's /healthz endpoint to see if it's running.
 * Returns `{ running: true, port }` on success, `{ running: false }` otherwise.
 */
export async function probeDesktopGateway(
  port: number = DEFAULT_GATEWAY_PORT
): Promise<GatewayProbeResult> {
  const http = await import("node:http")
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: 2_000 }, (res) => {
      if (res.statusCode === 200) {
        // Drain the response
        res.resume()
        res.on("end", () => resolve({ running: true, port }))
      } else {
        res.resume()
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

/**
 * Connect to the gateway (desktop or fallback proxy).
 *
 * Resolution order:
 * 1. If the desktop gateway is running on the expected port → use it.
 * 2. Otherwise → start a local Node.js proxy with the provided credentials.
 *
 * @param proxyConfig - Upstream config for the fallback proxy (API keys, base URLs)
 * @param deps        - Injectable dependencies for testing
 */
export async function connectGateway(
  proxyConfig: ProxyConfig,
  deps: GatewayConnectDeps = {}
): Promise<GatewayConnection> {
  const port =
    deps.gatewayPort ??
    (process.env[GATEWAY_PORT_ENV]
      ? parseInt(process.env[GATEWAY_PORT_ENV], 10)
      : DEFAULT_GATEWAY_PORT)
  const probe = deps.probe ?? probeDesktopGateway

  // Try desktop gateway first
  const probeResult = await probe(port)
  if (probeResult.running) {
    const apiKey =
      deps.gatewayApiKey ??
      process.env[GATEWAY_KEY_ENV] ??
      // Fallback: use the upstream key directly — the gateway accepts these
      // when configured with `autoAuth` mode (common in dev setups).
      proxyConfig.anthropicApiKey ??
      proxyConfig.openaiApiKey ??
      ""
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey,
      shutdown: async () => {
        /* Desktop gateway lifecycle is managed by the desktop app */
      },
      mode: "desktop-gateway",
    }
  }

  // Fallback: start the Node.js proxy
  const startProxy = deps.startProxy ?? startProxyServer
  const proxy: ProxyServer = await startProxy(proxyConfig)
  return {
    baseUrl: proxy.baseUrl,
    apiKey: proxy.apiKey,
    shutdown: proxy.shutdown,
    mode: "node-proxy",
  }
}
