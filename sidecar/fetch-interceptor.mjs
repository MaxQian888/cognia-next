// Side-effect import that monkey-patches `globalThis.fetch` to:
//   1. Capture `anthropic-ratelimit-*` headers from any response on
//      `api.anthropic.com` (used by the subscription usage tracker).
//   2. Route all outbound fetches through the user's configured proxy when
//      `HTTPS_PROXY` / `HTTP_PROXY` is set in the sidecar's environment —
//      Tauri's `src-tauri/src/claude/sidecar.rs` injects these from
//      `proxy_config::env_vars()` whenever the user enables the proxy.
//
// MUST be imported *before* `@anthropic-ai/claude-agent-sdk` so all SDK
// fetches go through the wrapper. Header capture remains best-effort, but
// proxy installation is deliberately fail-closed: an enabled proxy must
// never degrade to a direct first request.

const ORIGINAL_FETCH = globalThis.fetch
const ANTHROPIC_HOST_RE = /^https?:\/\/api\.anthropic\.com\//i

function proxyEnvUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  )
}

function redactedProxyEndpoint(value) {
  try {
    const parsed = new URL(value)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return "<invalid-proxy-url>"
  }
}

function validateProxyEnvironment() {
  for (const value of [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]) {
    if (!value) continue
    let parsed
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

function parseIpv4(input) {
  const parts = input.split(".")
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return { bits: 32, value }
}

function ipv6Words(part) {
  if (!part) return []
  const words = []
  for (const token of part.split(":")) {
    if (!token) return null
    if (token.includes(".")) {
      const ipv4 = parseIpv4(token)
      if (!ipv4) return null
      words.push(Number((ipv4.value >> 16n) & 0xffffn), Number(ipv4.value & 0xffffn))
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) return null
    words.push(Number.parseInt(token, 16))
  }
  return words
}

function parseIpv6(input) {
  const normalized = input.replace(/^\[|\]$/g, "")
  const halves = normalized.split("::")
  if (halves.length > 2) return null
  const left = ipv6Words(halves[0] ?? "")
  const right = ipv6Words(halves[1] ?? "")
  if (!left || !right) return null
  const omitted = 8 - left.length - right.length
  if (halves.length === 1 ? omitted !== 0 : omitted < 1) return null
  const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right]
  if (words.length !== 8) return null
  let value = 0n
  for (const word of words) value = (value << 16n) | BigInt(word)
  return { bits: 128, value }
}

function parseIp(input) {
  return parseIpv4(input) ?? parseIpv6(input)
}

function parseCidr(entry) {
  const separator = entry.lastIndexOf("/")
  if (separator <= 0) return null
  const network = parseIp(entry.slice(0, separator))
  const prefix = Number(entry.slice(separator + 1))
  if (!network || !Number.isInteger(prefix) || prefix < 0 || prefix > network.bits) return null
  return { ...network, prefix }
}

function cidrContains(cidr, hostname) {
  const target = parseIp(hostname.replace(/^\[|\]$/g, ""))
  if (!target || target.bits !== cidr.bits) return false
  const shift = BigInt(cidr.bits - cidr.prefix)
  return target.value >> shift === cidr.value >> shift
}

function splitNoProxy() {
  const value = process.env.no_proxy ?? process.env.NO_PROXY ?? ""
  const directCidrs = []
  const directIps = []
  const standardEntries = []
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

function dispatcherWithCidrBypass(undici) {
  const { directCidrs, directIps, noProxy } = splitNoProxy()
  const proxied = new undici.EnvHttpProxyAgent({ noProxy })
  if (directCidrs.length === 0 && directIps.length === 0) return proxied

  const direct = new undici.Agent()
  return {
    dispatch(options, handler) {
      const hostname = new URL(options.origin).hostname
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
      return Promise.all([direct.destroy(error), proxied.destroy(error)])
    },
  }
}

// Wire the configured proxy into undici's global dispatcher. The top-level
// await is the startup gate: the importing host cannot load the SDK or issue
// its first fetch until the dispatcher is ready.
async function installProxyDispatcher() {
  const proxyUrl = proxyEnvUrl()
  if (!proxyUrl) return
  validateProxyEnvironment()

  let undici
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

await installProxyDispatcher()

function emitUsageHeaders(headersBag) {
  try {
    process.stdout.write(JSON.stringify({ type: "usage_headers", headers: headersBag }) + "\n")
  } catch {
    // stdout closed or full — drop the event.
  }
}

function extractRatelimitHeaders(headers) {
  const out = {}
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

function urlOfFetchArg(input) {
  if (typeof input === "string") return input
  if (input && typeof input === "object") {
    if (typeof input.url === "string") return input.url
    if (typeof input.href === "string") return input.href
  }
  return ""
}

if (typeof ORIGINAL_FETCH === "function") {
  globalThis.fetch = async function patchedFetch(...args) {
    const response = await ORIGINAL_FETCH.apply(this, args)
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
