/**
 * Public IP + geolocation lookup for Settings → Network → IP.
 *
 * Reports the *egress* IP the network currently exits from — when a proxy is
 * active, the request hops through the Rust `proxy_http_request` command, so
 * the returned IP is the proxy's, not the machine's. In the browser build it
 * falls back to a direct `fetch` (the browser/system proxy applies instead).
 *
 * The provider is `ipinfo.io/json`, chosen for stable field coverage
 * (ip / city / region / country / org / loc / timezone) and a keyless free
 * tier. The whole feature is gated behind `networkProxy.ipLookupEnabled`; this
 * module never fires unless the caller has checked that flag.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { loggers } from "@/lib/logging"

const log = loggers.network

/** ipinfo.io JSON endpoint. Returns the caller's public IP + geo metadata. */
export const IP_INFO_URL = "https://ipinfo.io/json"

/** Request timeout — the lookup is a UI affordance, not a hot path. */
const IP_INFO_TIMEOUT_SECS = 15

/** Normalized subset of the ipinfo.io payload the UI renders. */
export interface IpInfo {
  ip: string
  hostname?: string
  city?: string
  region?: string
  country?: string
  /** "lat,lng" as returned by the provider. */
  loc?: string
  /** ASN + org, e.g. "AS13335 Cloudflare, Inc.". */
  org?: string
  postal?: string
  timezone?: string
}

export type IpInfoResult = { ok: true; info: IpInfo } | { ok: false; error: string }

/** Shape of the `proxy_http_request` Tauri command output (subset). */
interface ProxyHttpResponse {
  status: number
  body: string
  headers: Record<string, string>
}

/** Coerce an unknown JSON blob into `IpInfo`, keeping only string fields. */
function normalizeIpInfo(raw: unknown): IpInfo | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v : undefined
  const ip = str(obj.ip)
  if (!ip) return null
  return {
    ip,
    hostname: str(obj.hostname),
    city: str(obj.city),
    region: str(obj.region),
    country: str(obj.country),
    loc: str(obj.loc),
    org: str(obj.org),
    postal: str(obj.postal),
    timezone: str(obj.timezone),
  }
}

/**
 * Fetch the current public IP + geo info.
 *
 * In Tauri the request routes through `proxy_http_request` so it honours the
 * active proxy config (and its bypass list). In the browser it uses a direct
 * `fetch`. Never throws — failures resolve to `{ ok: false, error }`.
 */
export async function fetchIpInfo(): Promise<IpInfoResult> {
  try {
    let body: string
    let status: number
    if (isTauri()) {
      const res = await invoke<ProxyHttpResponse>("proxy_http_request", {
        input: {
          url: IP_INFO_URL,
          method: "GET",
          headers: { Accept: "application/json" },
          timeout_secs: IP_INFO_TIMEOUT_SECS,
        },
      })
      body = res.body
      status = res.status
    } else {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), IP_INFO_TIMEOUT_SECS * 1000)
      try {
        const res = await fetch(IP_INFO_URL, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        })
        body = await res.text()
        status = res.status
      } finally {
        clearTimeout(timer)
      }
    }

    if (status < 200 || status >= 300) {
      return { ok: false, error: `HTTP ${status}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { ok: false, error: "invalid JSON response" }
    }
    const info = normalizeIpInfo(parsed)
    if (!info) return { ok: false, error: "no IP in response" }
    return { ok: true, info }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`fetchIpInfo failed: ${message}`)
    return { ok: false, error: message }
  }
}
