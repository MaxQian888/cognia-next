/**
 * Network proxy configuration types.
 *
 * Surfaced under Settings → Network Proxy. The persisted shape lives on the
 * `AppSettings.networkProxy` field; the Rust side mirrors it via
 * `src-tauri/src/proxy_config/mod.rs:ProxyConfig` and reads it through
 * `proxy_apply` whenever the frontend writes a change.
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
  /**
   * Hosts and CIDR ranges that should bypass the proxy. Matched as exact
   * hosts/IPs, leading-dot domain suffixes, or IPv4/IPv6 CIDR ranges.
   * Defaults to the loopback set so localhost dev servers always reach
   * directly.
   */
  bypass: string[]
  /** When false, WSS connections skip the proxy even when `mode !== "off"`. */
  proxyWebsockets: boolean
  /** Epoch ms — populated whenever auto-detect successfully writes a host. */
  lastDetectedAt?: number
  /**
   * Master switch for the IP-info panel (Settings → Network → IP). When
   * `false`, the app never contacts the public IP lookup endpoint
   * (`ipinfo.io`). Defaults to `true`; the lookup itself still honours the
   * active proxy + bypass list, so it reports the egress IP the proxy sees.
   */
  ipLookupEnabled: boolean
}

/**
 * Read-only compatibility shape for settings rows written before proxy
 * credentials moved to the OS keyring. New code must never persist this
 * field; it exists only so the boot migration can remove it safely.
 */
export interface LegacyNetworkProxySettings extends NetworkProxySettings {
  password?: string
}

export const DEFAULT_NETWORK_PROXY_SETTINGS: NetworkProxySettings = {
  mode: "off",
  protocol: "http",
  host: "",
  port: 0,
  bypass: ["localhost", "127.0.0.1", "::1"],
  proxyWebsockets: true,
  ipLookupEnabled: true,
}

/**
 * Known proxy clients the Rust client registry can attribute a candidate to.
 * Mirrors `src-tauri/src/proxy_config/clients.rs:ClientId` exactly.
 */
export type ProxyClientId = "flclash" | "clash-verge-rev" | "mihomo" | "v2rayn"

/**
 * Which evidence layer discovered a candidate:
 * `config` — the client's config file declared the port (then TCP-verified);
 * `process` — the client process is running, port is its known default;
 * `port` — generic open-port probe only.
 */
export type ProxyCandidateSource = "config" | "process" | "port"

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
  /** Owning client when discovery attributed the port to a known client. */
  client?: ProxyClientId
  /** Display name matching `client` (e.g. "FlClash"). */
  clientName?: string
  /** Evidence layer that produced this candidate. */
  source?: ProxyCandidateSource
  /** True when the controller answered 401/403 — present but secret-guarded. */
  controllerSecured?: boolean
  /** Only protocol-verified candidates are returned by the native detector. */
  verified: true
  /** Concrete handshake used to prove that the endpoint is a proxy. */
  verification: "http-connect" | "socks5-connect"
}

export type ProxyErrorCode =
  | "PROXY_NOT_INITIALIZED"
  | "PROXY_INVALID_CONFIG"
  | "PROXY_CREDENTIAL_UNAVAILABLE"
  | "PROXY_CONNECT_FAILED"
  | "PROXY_TRANSPORT_UNSUPPORTED"

export type ProxyRouteSummary =
  | { kind: "direct"; reason: "off" | "bypass" }
  | { kind: "proxy"; protocol: ProxyProtocol; host: string; port: number }

export interface ProxyRuntimeStatus {
  state: "uninitialized" | "ready" | "blocked"
  route?: ProxyRouteSummary
  credentialConfigured: boolean
  errorCode?: ProxyErrorCode
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
  errorCode?: ProxyErrorCode
  /** Sanitized route metadata; never contains proxy credentials. */
  route?: ProxyRouteSummary
}
