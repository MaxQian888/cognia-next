/**
 * Network proxy configuration types.
 *
 * Surfaced under Settings → Network Proxy. The persisted shape lives on the
 * `AppSettings.networkProxy` field; the Rust side mirrors it via
 * `src-tauri/src/proxy_config/mod.rs:ProxyConfig` and reads it through
 * `proxy_set` whenever the frontend writes a change.
 */

export type ProxyProtocol = "http" | "https" | "socks5"

/**
 * `off` — no proxy applied.
 * `manual` — the user has filled in host/port (and optional auth) explicitly.
 * `auto` — auto-detected at startup or via the Detection tab; behaves the
 *   same as `manual` once a host/port is populated, but the
 *   `lastDetectedAt` timestamp distinguishes it for UX.
 */
export type ProxyMode = "off" | "manual" | "auto"

export interface NetworkProxySettings {
  mode: ProxyMode
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  /**
   * Hosts and CIDR ranges that should bypass the proxy. Matched as
   * substrings + suffix matches by `lib/network/proxy-config.ts:shouldBypass`.
   * Defaults to the loopback set so localhost dev servers always reach
   * directly.
   */
  bypass: string[]
  /** When false, WSS connections skip the proxy even when `mode !== "off"`. */
  proxyWebsockets: boolean
  /** Epoch ms — populated whenever auto-detect successfully writes a host. */
  lastDetectedAt?: number
}

export const DEFAULT_NETWORK_PROXY_SETTINGS: NetworkProxySettings = {
  mode: "off",
  protocol: "http",
  host: "",
  port: 0,
  bypass: ["localhost", "127.0.0.1", "::1"],
  proxyWebsockets: true,
}

/**
 * Result row returned by the `proxy_detect` Tauri command. Each candidate is
 * a host:port pair we successfully connected to (port probe) plus, when the
 * candidate is a Clash/Mihomo controller, an identifying version string.
 */
export interface ProxyCandidate {
  kind: "http" | "socks5" | "clash"
  host: string
  port: number
  /** Human-friendly description rendered in the Detection tab. */
  label: string
  /** Optional Clash/Mihomo version when the controller API responded. */
  version?: string
}

/**
 * Result of the `proxy_test` Tauri command — sanity-checks the active proxy
 * by issuing a request to a user-supplied URL through the configured client.
 */
export interface ProxyTestResult {
  ok: boolean
  status?: number
  latencyMs: number
  error?: string
  /** Echoes the proxy URL the test went through (for the UI). */
  proxyUrl?: string
}
