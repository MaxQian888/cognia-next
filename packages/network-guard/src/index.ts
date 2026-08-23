/**
 * @cognia/network-guard — the canonical SSRF policy shared by every outbound
 * fetch path in cognia (app `web_fetch`, connector inbound media, the
 * web-clone sidecar engine).
 *
 * Dependency-free and browser-safe by construction: no DNS, no sockets, no
 * Node built-ins. Runtime-specific behaviour (the app's Settings guidance, the
 * webclone process policy) lives in thin adapters at each call site; only the
 * classification lives here.
 */

export {
  ipv6Groups,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateOrLocalHost,
  normalizeHost,
  parseIPv4,
  type IPv4Octets,
} from "./host"

export {
  evaluateFetchTarget,
  type FetchGuardDecision,
  type FetchGuardOptions,
  type FetchGuardReason,
} from "./fetch-target"
