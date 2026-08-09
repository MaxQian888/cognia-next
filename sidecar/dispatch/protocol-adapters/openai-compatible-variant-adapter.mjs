// Declarative "openai-compatible-variant" protocol adapter (one-api channel
// analog). A plugin describes an upstream as pure JSON — URL template, header
// rules, request field renames/injections, response JSON paths — and this
// adapter executes it with fetch + an SSE parser. No plugin code ever runs in
// the sidecar process: the spec is data, validated and interpolated here.
//
// v1 scope: text + reasoning deltas, finish reason, usage. Tool-calling is
// intentionally OUT of scope for declarative adapters (needs real code; the
// renderer round-trip path is the planned phase-2 escape hatch).

import { getPath } from "./json-path-lite.mjs"
import { GENERIC_REASONING_EFFORT } from "./reasoning-effort-tables.mjs"

/** Keys a well-formed spec must carry (parity-tested against the renderer). */
export const SPEC_REQUIRED_KEYS = ["kind", "urlTemplate", "responsePaths"]

/** @param {any} spec */
export function validateSpec(spec) {
  if (!spec || typeof spec !== "object") return "spec must be an object"
  if (spec.kind !== "openai-compatible-variant") return `unknown spec kind: ${spec?.kind}`
  if (typeof spec.urlTemplate !== "string" || spec.urlTemplate.length === 0) {
    return "spec.urlTemplate is required"
  }
  if (!spec.responsePaths || typeof spec.responsePaths.textDelta !== "string") {
    return "spec.responsePaths.textDelta is required"
  }
  return null
}

/** Interpolate `{apiKey}` / `{model}` / `{baseURL}` placeholders. */
function interpolate(template, vars) {
  return template.replace(/\{(apiKey|model|baseURL)\}/g, (_, key) => vars[key] ?? "")
}

/** Resolve the wire reasoning-effort value, honoring a per-channel override map.
 * The default map lives in `reasoning-effort-tables.mjs`, shared with the
 * renderer so it never offers tiers this channel folds together. */
function resolveVariantEffort(effort, map) {
  if (map && typeof map[effort] === "string") return map[effort]
  return GENERIC_REASONING_EFFORT[effort] ?? "medium"
}

/** Apply `requestRenames` to modelParams keys (e.g. maxOutputTokens → max_tokens). */
function renameParams(params, renames) {
  if (!renames) return { ...params }
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    out[renames[key] ?? key] = value
  }
  return out
}

/** Split an SSE byte stream into `data:` payload strings. */
async function* sseDataLines(body) {
  const decoder = new TextDecoder()
  let buf = ""
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "")
      buf = buf.slice(idx + 1)
      if (line.startsWith("data:")) yield line.slice(5).trim()
    }
  }
  const tail = buf.trim()
  if (tail.startsWith("data:")) yield tail.slice(5).trim()
}

function mayBeIncompleteJson(payload) {
  const trimmed = payload.trim()
  return trimmed.startsWith("{") || (trimmed.startsWith("[") && trimmed !== "[DONE]")
}

/**
 * Hard ceiling on the multi-line-JSON reassembly buffer. A real SSE event is
 * a few KB of delta text; anything past this is a poisoned buffer (a garbage
 * `{`-prefixed line that will never parse), not a legitimate continuation.
 */
const MAX_PENDING_SSE_BYTES = 1024 * 1024

/**
 * @param {any} spec  Validated openai-compatible-variant spec.
 * @returns {import("./types.mjs").ProtocolAdapter}
 */
export function makeOpenAiCompatVariantAdapter(spec) {
  return {
    id: `declarative:${spec.kind}`,
    async start(req) {
      const invalid = validateSpec(spec)
      if (invalid) throw new Error(`invalid protocol adapter spec: ${invalid}`)
      const creds = req.credentials ?? {}
      const vars = {
        apiKey: creds.apiKey ?? "",
        model: req.model,
        baseURL: (creds.baseURL ?? "").replace(/\/+$/, ""),
      }
      const url = interpolate(spec.urlTemplate, vars)
      const headers = { "content-type": "application/json" }
      for (const [name, value] of Object.entries(spec.headers ?? {})) {
        headers[name.toLowerCase()] = interpolate(value, vars)
      }
      // Reasoning-effort translation (opt-in): a channel that supports a
      // thinking level declares the wire field name via `spec.reasoningEffortField`
      // (e.g. "reasoning_effort"); we then map the app's effort to a safe value.
      // Omitted by default so channels that reject the field never 400. `requestInject`
      // still wins (spread last) if a spec sets the same key explicitly.
      const reasoningInject =
        spec.reasoningEffortField && req.reasoning?.effort
          ? {
              [spec.reasoningEffortField]: resolveVariantEffort(
                req.reasoning.effort,
                spec.reasoningEffortMap
              ),
            }
          : {}
      const body = {
        model: req.model,
        messages: req.messages,
        stream: true,
        ...renameParams(req.modelParams ?? {}, spec.requestRenames),
        ...reasoningInject,
        ...(spec.requestInject ?? {}),
      }

      const fetchFn = req.fetchFn ?? globalThis.fetch
      const res = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: req.abortSignal,
      })
      if (!res.ok) {
        // Surface status + body text so the renderer's error classifier can
        // pick up the class and any Retry-After hint embedded in the payload.
        const retryAfter = res.headers?.get?.("retry-after")
        const text = await res.text().catch(() => "")
        const err = new Error(
          `HTTP ${res.status}${retryAfter ? ` retry-after: ${retryAfter}` : ""}: ${text.slice(0, 500)}`
        )
        // Structured fields so extractHttpErrorMeta can read the status and
        // Retry-After header instead of falling back to message parsing.
        err.statusCode = res.status
        if (retryAfter != null) err.responseHeaders = { "retry-after": retryAfter }
        throw err
      }
      if (!res.body) throw new Error("upstream response has no body")

      const paths = spec.responsePaths
      let resolveUsage
      const usage = new Promise((resolve) => {
        resolveUsage = resolve
      })

      async function* fullStream() {
        let finishReason = null
        let promptTokens
        let completionTokens
        let cachedInputTokens
        let cacheCreationInputTokens
        let reasoningTokens
        let pendingData = null
        try {
          for await (const data of sseDataLines(res.body)) {
            if (data === "[DONE]") break
            const payload = pendingData ? `${pendingData}${data}` : data
            let parsed
            let hasParsed = false
            try {
              parsed = JSON.parse(payload)
              hasParsed = true
              pendingData = null
            } catch {
              // The glued payload didn't parse. If this line parses on its
              // own, the stashed prefix was garbage (a malformed frame that
              // will never complete) — drop it and recover with the line,
              // instead of letting the poisoned buffer eat the whole stream.
              if (pendingData !== null) {
                try {
                  parsed = JSON.parse(data)
                  hasParsed = true
                  pendingData = null
                } catch {
                  // Still ambiguous: genuine multi-line continuation.
                }
              }
              if (!hasParsed) {
                const stash = mayBeIncompleteJson(payload) ? payload : null
                pendingData = stash !== null && stash.length <= MAX_PENDING_SSE_BYTES ? stash : null
                continue // tolerate keep-alive/comment payloads
              }
            }
            const text = getPath(parsed, paths.textDelta)
            if (typeof text === "string" && text.length > 0) {
              yield { type: "text-delta", id: "0", text }
            }
            if (paths.reasoningDelta) {
              const reasoning = getPath(parsed, paths.reasoningDelta)
              if (typeof reasoning === "string" && reasoning.length > 0) {
                yield { type: "reasoning-delta", id: "r0", text: reasoning }
              }
            }
            if (paths.finishReason) {
              const fr = getPath(parsed, paths.finishReason)
              if (typeof fr === "string" && fr.length > 0) finishReason = fr
            }
            if (paths.usage) {
              const input = paths.usage.input ? getPath(parsed, paths.usage.input) : undefined
              const output = paths.usage.output ? getPath(parsed, paths.usage.output) : undefined
              const cacheRead = paths.usage.cacheRead
                ? getPath(parsed, paths.usage.cacheRead)
                : undefined
              const cacheCreation = paths.usage.cacheCreation
                ? getPath(parsed, paths.usage.cacheCreation)
                : undefined
              const reasoning = paths.usage.reasoning
                ? getPath(parsed, paths.usage.reasoning)
                : undefined
              if (typeof input === "number") promptTokens = input
              if (typeof output === "number") completionTokens = output
              if (typeof cacheRead === "number") cachedInputTokens = cacheRead
              if (typeof cacheCreation === "number") cacheCreationInputTokens = cacheCreation
              if (typeof reasoning === "number") reasoningTokens = reasoning
            }
          }
          const finalUsage = {
            ...(promptTokens !== undefined ? { promptTokens } : {}),
            ...(completionTokens !== undefined ? { completionTokens } : {}),
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
            ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          }
          yield { type: "finish", finishReason: finishReason ?? "stop", usage: finalUsage }
          resolveUsage(finalUsage)
        } finally {
          // Settles the usage promise on EVERY exit path — including the
          // generator being closed early via .return() when the turn is
          // interrupted. Without this the dispatcher's `await usage` after the
          // stream loop hangs forever and the session stays `active`. A second
          // resolve after the success path above is a harmless no-op.
          resolveUsage(null)
        }
      }

      return { fullStream: fullStream(), usage, response: null }
    },
  }
}
