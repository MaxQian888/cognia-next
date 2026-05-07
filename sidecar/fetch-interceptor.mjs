// Side-effect import that monkey-patches `globalThis.fetch` to:
//   1. Capture `anthropic-ratelimit-*` headers from any response on
//      `api.anthropic.com` (used by the subscription usage tracker).
//   2. Route all outbound fetches through the user's configured proxy when
//      `HTTPS_PROXY` / `HTTP_PROXY` is set in the sidecar's environment —
//      Tauri's `src-tauri/src/claude/sidecar.rs` injects these from
//      `proxy_config::env_vars()` whenever the user enables the proxy.
//
// MUST be imported *before* `@anthropic-ai/claude-agent-sdk` so all SDK
// fetches go through the wrapper. Failure modes are silent: never let
// header capture or proxy setup break the actual response.

const ORIGINAL_FETCH = globalThis.fetch
const ANTHROPIC_HOST_RE = /^https?:\/\/api\.anthropic\.com\//i

// Wire the configured proxy into undici's global dispatcher. undici ships
// with Node 20+ and is the engine behind `globalThis.fetch`. We import it
// dynamically so this file remains usable in non-Node environments (and
// failures to load undici don't break header capture below).
async function installProxyDispatcher() {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  if (!proxyUrl) return
  try {
    const undici = await import("undici")
    if (
      undici &&
      typeof undici.ProxyAgent === "function" &&
      typeof undici.setGlobalDispatcher === "function"
    ) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl))
      try {
        process.stdout.write(
          JSON.stringify({
            type: "proxy_installed",
            target: proxyUrl.replace(/\/\/[^@]+@/, "//<redacted>@"),
          }) + "\n"
        )
      } catch {
        // stdout closed; ignore.
      }
    }
  } catch {
    // undici unavailable — fall through to direct fetch.
  }
}

// Fire-and-forget. The agent SDK boot is async too; if a request races the
// dispatcher install it'll just hit the network directly that one time.
installProxyDispatcher()

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
