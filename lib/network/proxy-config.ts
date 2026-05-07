/**
 * Pure helpers around `NetworkProxySettings`. Used by both the renderer
 * (`createProxyFetch`, settings UI) and any Node-side code that needs to
 * shape the same config into env vars.
 *
 * Stays in `lib/network/` next to `proxy-fetch.ts` so the entire proxy
 * surface is co-located. Tests live next to this file.
 */

import type { NetworkProxySettings } from "@/types/network/proxy"

/** True when the user has enabled a proxy AND filled in a host + non-zero port. */
export function isProxyActive(cfg?: NetworkProxySettings | null): cfg is NetworkProxySettings {
  if (!cfg) return false
  if (cfg.mode === "off") return false
  return cfg.host.trim().length > 0 && cfg.port > 0
}

/**
 * Build a proxy URL — `http://user:pass@host:port` (or socks5://...).
 *
 * Returns `null` when the config isn't actionable (off, missing host, or
 * port = 0). Auth is URL-encoded so passwords with `:` / `@` survive.
 */
export function buildProxyUrl(cfg?: NetworkProxySettings | null): string | null {
  if (!isProxyActive(cfg)) return null
  const scheme = cfg.protocol === "socks5" ? "socks5" : cfg.protocol
  const auth =
    cfg.username && cfg.password
      ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
      : ""
  return `${scheme}://${auth}${cfg.host}:${cfg.port}`
}

/**
 * Determine whether a target URL should bypass the proxy. Matches each
 * `bypass` entry as either a literal host (with optional port suffix) or a
 * domain suffix when the entry starts with a dot.
 *
 *   "127.0.0.1"     → matches http://127.0.0.1, http://127.0.0.1:3000
 *   ".internal"     → matches https://api.internal/foo
 *   "localhost"     → matches http://localhost/whatever
 *
 * Anything we cannot parse falls back to "do not bypass" — direct calls are
 * cheaper to debug than silently-leaked-direct ones.
 */
export function shouldBypass(targetUrl: string, bypass: string[]): boolean {
  if (bypass.length === 0) return false
  let host: string
  try {
    host = new URL(targetUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return bypass.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (!entry) return false
    if (entry.startsWith(".")) return host === entry.slice(1) || host.endsWith(entry)
    return host === entry
  })
}

/**
 * Env-var map suitable for spawning a child process (Node sidecar, MCP
 * server) so its outbound HTTP picks up the same proxy. Reads every common
 * casing because libraries are inconsistent.
 *
 * Returns `{}` when no proxy is active so the caller can spread it without
 * conditionals.
 */
export function proxyEnvVars(cfg?: NetworkProxySettings | null): Record<string, string> {
  const url = buildProxyUrl(cfg)
  if (!url) return {}
  const env: Record<string, string> = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
  }
  if (cfg && cfg.bypass.length > 0) {
    const noProxy = cfg.bypass.join(",")
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }
  return env
}

/**
 * Build a base64-encoded Proxy-Authorization header value. Used by the WSS
 * CONNECT tunnel and any direct HTTP CONNECT call site.
 */
export function proxyAuthHeader(cfg?: NetworkProxySettings | null): string | null {
  if (!isProxyActive(cfg)) return null
  if (!cfg.username || !cfg.password) return null
  const credentials = `${cfg.username}:${cfg.password}`
  if (typeof btoa === "function") return `Basic ${btoa(credentials)}`
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`
}
