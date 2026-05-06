// Side-effect import that monkey-patches `globalThis.fetch` to capture
// `anthropic-ratelimit-*` headers from any response on `api.anthropic.com`.
// MUST be imported *before* `@anthropic-ai/claude-agent-sdk` so that all
// SDK fetches go through the wrapper.
//
// We intentionally don't import the host's `emit()` helper — that would
// create a circular module load. Writing one JSON-line to stdout is exactly
// the same channel `emit()` uses, so the event arrives at Tauri's
// `claude://message` listener identically.
//
// Failure modes are deliberately silent: never let header capture break the
// actual response (or worse, hang the request).

const ORIGINAL_FETCH = globalThis.fetch
const ANTHROPIC_HOST_RE = /^https?:\/\/api\.anthropic\.com\//i

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
