/**
 * Recording half of keyless replay (ADR-0118).
 *
 * A pass-through proxy in front of the real provider. It forwards the request
 * untouched, tees the response, and writes a tape keyed by the same normalized
 * digest the replay server will recompute — so a recording and a replay agree
 * by construction rather than by two implementations happening to match.
 *
 * What it deliberately does NOT persist:
 *
 *   - request headers, in particular `authorization` / `x-api-key`. They are
 *     forwarded to the upstream and dropped on the floor here. A fixture that
 *     captured them would be a credential in git.
 *   - the request body. Only its digests are kept; the prompt itself is only
 *     written when the caller explicitly asks for artifact capture, and then it
 *     goes to the encrypted asset store, never into the fixture.
 *
 * Recording is not a replay concern and never runs by accident: nothing here is
 * reachable without `cognia eval record --live`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { digestAnthropicRequest } from "@/lib/ai/replay/normalize-anthropic-request"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { ReplayTapeV1 } from "@cognia/agent-config-types/model-request-surface"
import { parseActorPath, REPLAY_PURPOSE_HEADER } from "./tape-server"
import type { ModelRequestPurpose } from "@cognia/agent-config-types/model-request-surface"

const DEFAULT_UPSTREAM = "https://api.anthropic.com"

/** Never forwarded upstream — they describe the hop, not the request. */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
])

export interface RecordingProxyOptions {
  /** Real provider base URL. Defaults to the Anthropic API. */
  upstream?: string
  provider?: string
  defaultActorRef?: string
  /** Injected in tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

export interface RecordedFixture {
  tapes: ReplayTapeV1[]
  assets: Record<string, string[]>
  actors: string[]
}

export interface RecordingProxy {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string
  baseUrlFor(actorRef: string): string
  /** Everything captured so far, ready to serialize as a fixture. */
  snapshot(): RecordedFixture
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}

function forwardableHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name)) continue
    if (typeof value === "string") headers[name] = value
    else if (Array.isArray(value)) headers[name] = value.join(", ")
  }
  return headers
}

/**
 * Pull assistant text out of an Anthropic SSE body.
 *
 * Only `text_delta` chunks are kept: they are what a replayed stream has to
 * reproduce. Usage counters and message ids are per-run values that would make
 * every recording differ from every replay.
 */
export function extractTextDeltas(sse: string): string[] {
  const chunks: string[] = []
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const event = JSON.parse(payload) as {
        type?: string
        delta?: { type?: string; text?: string }
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        if (typeof event.delta.text === "string") chunks.push(event.delta.text)
      }
    } catch {
      // A partial or non-JSON line is not a delta; skip it rather than failing
      // the recording over a keep-alive comment.
    }
  }
  return chunks
}

/** Assistant text from a non-streaming Messages response. */
export function extractWholeText(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { content?: Array<{ type?: string; text?: string }> }
    const text = (parsed.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
    return text ? [text] : []
  } catch {
    return []
  }
}

export function createRecordingProxy(options: RecordingProxyOptions = {}): RecordingProxy {
  const upstream = (options.upstream ?? DEFAULT_UPSTREAM).replace(/\/$/, "")
  const provider = options.provider ?? "anthropic"
  const defaultActorRef = options.defaultActorRef ?? "root"
  const fetchImpl = options.fetchImpl ?? fetch

  const tapes: ReplayTapeV1[] = []
  const assets: Record<string, string[]> = {}
  const actors = new Set<string>()
  let server: Server | undefined
  let boundPort = 0
  let sequence = 0

  function recordTape(
    actorRef: string,
    purpose: ModelRequestPurpose,
    requestDigest: string,
    behavior: ReplayTapeV1["behavior"]
  ): void {
    sequence += 1
    tapes.push({
      schemaVersion: 1,
      tapeId: `tape-${sequence}`,
      match: { actorRef, purpose, requestDigest },
      behavior,
      // A live capture is never synthetic. Marking it honestly is what keeps
      // `loadReplayFixture({requireSynthetic:true})` from admitting it into the
      // repository; scrubbing and re-marking is a deliberate human step.
      synthetic: false,
    })
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { actorRef: pathActor, apiPath } = parseActorPath(request.url ?? "")
    const actorRef = pathActor ?? defaultActorRef
    actors.add(actorRef)

    const rawBody = await readBody(request)
    const headers = forwardableHeaders(request)

    if (apiPath.startsWith("/v1/messages") && rawBody.length > 0) {
      let providerPayload: unknown
      try {
        providerPayload = JSON.parse(rawBody)
      } catch {
        throw new Error("Recording proxy rejected a malformed provider request body")
      }
      if (!hasNoLeakingPiiDeep(providerPayload)) {
        throw new Error("Recording proxy blocked the provider request by PII gate")
      }
    }

    const upstreamResponse = await fetchImpl(`${upstream}${apiPath}`, {
      method: request.method ?? "POST",
      headers,
      body: rawBody.length > 0 ? rawBody : undefined,
    })

    const responseBody = await upstreamResponse.text()

    // Only Messages calls carry a request surface worth taping; anything else
    // (token counting, model listing) is proxied without being recorded.
    if (apiPath.startsWith("/v1/messages") && rawBody.length > 0) {
      const purposeHeader = headers[REPLAY_PURPOSE_HEADER]
      const purpose = (purposeHeader as ModelRequestPurpose | undefined) ?? "turn"
      try {
        const payload = JSON.parse(rawBody) as Record<string, unknown>
        const { requestDigest } = await digestAnthropicRequest(payload, { provider, purpose })

        if (!upstreamResponse.ok) {
          recordTape(actorRef, purpose, requestDigest, {
            kind: "error",
            status: upstreamResponse.status,
            code: `http_${upstreamResponse.status}`,
            message: responseBody.slice(0, 500),
          })
        } else {
          const streamed = payload.stream === true
          const chunks = streamed ? extractTextDeltas(responseBody) : extractWholeText(responseBody)
          const chunksRef = `chunks-${sequence + 1}`
          assets[chunksRef] = chunks
          recordTape(actorRef, purpose, requestDigest, { kind: "stream", chunksRef })
        }
      } catch {
        // A body the normalizer cannot read is proxied but not taped. Recording
        // a tape we could not key would produce a fixture that never matches.
      }
    }

    const outHeaders: Record<string, string> = {}
    upstreamResponse.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name.toLowerCase())) outHeaders[name] = value
    })
    response.writeHead(upstreamResponse.status, outHeaders)
    response.end(responseBody)
  }

  return {
    get port() {
      return boundPort
    },
    get baseUrl() {
      return `http://127.0.0.1:${boundPort}`
    },
    baseUrlFor(actorRef: string) {
      return `http://127.0.0.1:${boundPort}/a/${encodeURIComponent(actorRef)}`
    },
    snapshot() {
      return {
        tapes: tapes.map((tape) => ({ ...tape })),
        assets: { ...assets },
        actors: [...actors],
      }
    },
    async start(port = 0) {
      server = createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
          if (response.headersSent) {
            response.destroy()
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          const body = JSON.stringify({
            type: "error",
            error: { type: "recording_proxy_error", message },
          })
          response.writeHead(502, { "content-type": "application/json" })
          response.end(body)
        })
      })
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject)
        server?.listen(port, "127.0.0.1", () => {
          boundPort = (server?.address() as AddressInfo).port
          resolve()
        })
      })
    },
    async stop() {
      const active = server
      server = undefined
      if (!active) return
      await new Promise<void>((resolve) => {
        active.closeAllConnections?.()
        active.close(() => resolve())
      })
    },
  }
}
