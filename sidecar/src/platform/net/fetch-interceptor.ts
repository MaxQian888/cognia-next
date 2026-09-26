// Wraps the process-wide `globalThis.fetch` to:
//   1. Capture `anthropic-ratelimit-*` headers from any response on
//      `api.anthropic.com` (used by the subscription usage tracker).
//   2. Route all outbound fetches through the user's configured proxy when
//      `HTTPS_PROXY` / `HTTP_PROXY` is set in the sidecar's environment —
//      Tauri's `src-tauri/src/claude/sidecar.rs` injects these from
//      `proxy_config::env_vars()` whenever the user enables the proxy.
//
// The host installs it through `./install-fetch-interceptor.ts`, imported
// before `@anthropic-ai/claude-agent-sdk` so all SDK fetches go through the
// wrapper. Header capture remains best-effort, but proxy installation is
// deliberately fail-closed: an enabled proxy must never degrade to a direct
// first request.

import type { Dispatcher } from "undici"

import { cidrContains, parseCidr, parseIp } from "./ip.ts"
import type { ParsedCidr, ParsedIp } from "./ip.ts"

type Undici = typeof import("undici")

const ANTHROPIC_HOST_RE = /^https?:\/\/api\.anthropic\.com\//i

function proxyEnvUrl(): string {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  )
}

function redactedProxyEndpoint(value: string): string {
  try {
    const parsed = new URL(value)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return "<invalid-proxy-url>"
  }
}

function validateProxyEnvironment(): void {
  for (const value of [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]) {
    if (!value) continue
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error("PROXY_INVALID_CONFIG: sidecar proxy URL is invalid")
    }
    if (!parsed.hostname || !["http:", "https:", "socks5:", "socks:"].includes(parsed.protocol)) {
      throw new Error("PROXY_INVALID_CONFIG: sidecar proxy URL uses an unsupported endpoint")
    }
  }
}

interface NoProxySplit {
  directCidrs: ParsedCidr[]
  directIps: ParsedIp[]
  /** The remaining host-name entries, in undici's `noProxy` syntax. */
  noProxy: string
}

/** undici's NO_PROXY matching knows host names only; exact IPs and CIDRs are split off here. */
function splitNoProxy(): NoProxySplit {
  const value = process.env.no_proxy ?? process.env.NO_PROXY ?? ""
  const directCidrs: ParsedCidr[] = []
  const directIps: ParsedIp[] = []
  const standardEntries: string[] = []
  for (const entry of value.split(/[,\s]+/).filter(Boolean)) {
    const cidr = parseCidr(entry)
    if (cidr) directCidrs.push(cidr)
    else {
      const ip = parseIp(entry)
      if (ip) directIps.push(ip)
      else standardEntries.push(entry)
    }
  }
  return { directCidrs, directIps, noProxy: standardEntries.join(",") }
}

/** The part of a Dispatcher the global slot uses, routing each request direct or via the proxy. */
interface BypassRouter {
  dispatch: Dispatcher["dispatch"]
  close(): Promise<unknown>
  destroy(error?: Error | null): Promise<unknown>
}

function dispatcherWithCidrBypass(undici: Undici): Dispatcher {
  const { directCidrs, directIps, noProxy } = splitNoProxy()
  const proxied = new undici.EnvHttpProxyAgent({ noProxy })
  if (directCidrs.length === 0 && directIps.length === 0) return proxied

  const direct = new undici.Agent()
  const router: BypassRouter = {
    dispatch(options, handler) {
      const hostname = new URL(String(options.origin)).hostname
      const target = parseIp(hostname.replace(/^\[|\]$/g, ""))
      const exactMatch =
        target !== null &&
        directIps.some((entry) => entry.bits === target.bits && entry.value === target.value)
      const dispatcher =
        exactMatch || directCidrs.some((cidr) => cidrContains(cidr, hostname)) ? direct : proxied
      return dispatcher.dispatch(options, handler)
    },
    close() {
      return Promise.all([direct.close(), proxied.close()])
    },
    destroy(error) {
      return Promise.all([direct.destroy(error ?? null), proxied.destroy(error ?? null)])
    },
  }
  // undici's global slot checks only `dispatch`, and fetch calls only the
  // three methods above; the rest of the Dispatcher surface is never reached.
  return router as Dispatcher
}

// Wire the configured proxy into undici's global dispatcher. The caller awaits
// this before the SDK can load or issue its first fetch.
async function installProxyDispatcher(): Promise<void> {
  const proxyUrl = proxyEnvUrl()
  if (!proxyUrl) return
  validateProxyEnvironment()

  let undici: Undici
  try {
    undici = await import("undici")
  } catch {
    throw new Error("PROXY_CONNECT_FAILED: undici proxy support is unavailable")
  }
  if (
    typeof undici.EnvHttpProxyAgent !== "function" ||
    typeof undici.Agent !== "function" ||
    typeof undici.setGlobalDispatcher !== "function"
  ) {
    throw new Error("PROXY_CONNECT_FAILED: undici proxy dispatcher is unavailable")
  }

  try {
    undici.setGlobalDispatcher(dispatcherWithCidrBypass(undici))
  } catch {
    throw new Error("PROXY_INVALID_CONFIG: sidecar proxy dispatcher initialization failed")
  }
  try {
    process.stdout.write(
      JSON.stringify({ type: "proxy_installed", target: redactedProxyEndpoint(proxyUrl) }) + "\n"
    )
  } catch {
    // stdout is observability only; a closed pipe does not change routing.
  }
}

function emitUsageHeaders(headersBag: Record<string, string>): void {
  try {
    process.stdout.write(JSON.stringify({ type: "usage_headers", headers: headersBag }) + "\n")
  } catch {
    // stdout closed or full — drop the event.
  }
}

function extractRatelimitHeaders(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  // `Headers.forEach` is available on both Node fetch and undici.
  if (typeof headers?.forEach === "function") {
    headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower.startsWith("anthropic-ratelimit-")) {
        out[lower] = value
      }
    })
  }
  return out
}

function urlOfFetchArg(input: unknown): string {
  if (typeof input === "string") return input
  if (input && typeof input === "object") {
    const { url, href } = input as { url?: unknown; href?: unknown }
    if (typeof url === "string") return url
    if (typeof href === "string") return href
  }
  return ""
}

function withUsageHeaderCapture(original: typeof fetch): typeof fetch {
  return async function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>) {
    const response = await original.apply(this, args)
    try {
      const url = urlOfFetchArg(args[0])
      if (ANTHROPIC_HOST_RE.test(url)) {
        const headers = extractRatelimitHeaders(response.headers)
        if (Object.keys(headers).length > 0) {
          emitUsageHeaders(headers)
        }
      }
    } catch {
      // never throw from the wrapper; fall through to return the response.
    }
    return response
  }
}

async function install(): Promise<void> {
  // Captured before the proxy dispatcher is installed, as the wrapper target.
  const original = globalThis.fetch
  await installProxyDispatcher()
  if (typeof original === "function") globalThis.fetch = withUsageHeaderCapture(original)
}

const INSTALLED = Symbol.for("cognia.sidecar.fetch-interceptor")

/**
 * Install the proxy dispatcher and the header-capturing fetch wrapper once per
 * process. Later calls (a second host entry, a bundled copy of this module)
 * share the first installation instead of wrapping fetch twice. Rejects with a
 * `PROXY_*` error when an enabled proxy cannot be installed.
 */
export function installFetchInterceptor(): Promise<void> {
  const slot = globalThis as { [INSTALLED]?: Promise<void> }
  slot[INSTALLED] ??= install()
  return slot[INSTALLED]
}
