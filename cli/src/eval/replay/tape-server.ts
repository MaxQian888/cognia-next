/**
 * Local Anthropic-shaped endpoint that answers from tapes (ADR-0118).
 *
 * This is what makes an agent run reproducible without an API key: the SDK, the
 * agent loop, the tool pipeline, the permission system and persistence all run
 * for real, and only the model endpoint is swapped for this server.
 *
 * It lives in the CLI rather than in `lib/` on purpose. The app is a Next.js
 * static export consumed by Tauri and Capacitor, so a `node:http` import
 * reachable from `lib/` would break the mobile bundle. The matching logic it
 * depends on is in `lib/ai/replay/` and is free of Node built-ins, so record and
 * replay still share one normalization.
 *
 * Two safety properties are structural rather than configurable:
 *
 *   - it binds loopback only, so a replay run cannot be reached off-box;
 *   - an unmatched request is answered with an explicit error naming the digest
 *     that missed, never with a plausible-looking generic completion. A replay
 *     that quietly invents an answer is worse than one that fails.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { digestAnthropicRequest } from "@/lib/ai/replay/normalize-anthropic-request"
import type { ReplayLedger } from "@/lib/ai/replay/lease"
import type {
  ModelRequestPurpose,
  ReplayTapeV1,
} from "@cognia/agent-config-types/model-request-surface"

/**
 * Header the runner stamps so a child agent's calls take its own lease.
 *
 * Only usable by callers that control the HTTP layer. A provider SDK given a
 * base URL does not add headers, so actor routing primarily rides the URL —
 * see {@link TapeServer.baseUrlFor}.
 */
export const REPLAY_ACTOR_HEADER = "x-cognia-replay-actor"
/**
 * Header naming why the model is being called.
 *
 * When absent — the normal case, because no provider SDK forwards it — the
 * server matches on request digest alone and refuses anything ambiguous rather
 * than inferring the purpose from the prompt.
 */
export const REPLAY_PURPOSE_HEADER = "x-cognia-replay-purpose"

/** URL prefix carrying the actor: `/a/<actorRef>/v1/messages`. */
const ACTOR_PATH_PREFIX = "/a/"

/**
 * Split `/a/<actorRef>/v1/messages` into its actor and the API path.
 *
 * The actor segment is URL-encoded by {@link TapeServer.baseUrlFor}, so an
 * actor ref containing a slash cannot forge a different route.
 */
export function parseActorPath(url: string): { actorRef?: string; apiPath: string } {
  if (!url.startsWith(ACTOR_PATH_PREFIX)) return { apiPath: url }
  const rest = url.slice(ACTOR_PATH_PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash < 0) return { apiPath: "/" }
  return { actorRef: decodeURIComponent(rest.slice(0, slash)), apiPath: rest.slice(slash) }
}

const PURPOSES: readonly string[] = [
  "turn",
  "subagent",
  "compaction",
  "title",
  "summary",
  "judge",
  "embedding",
  "other",
]

export interface TapeServerOptions {
  ledger: ReplayLedger
  /**
   * Resolve a tape's `chunksRef` to the text deltas it stands for.
   *
   * Injected because the bytes live in two different places depending on the
   * fixture: inline for a synthetic one, and in the encrypted eval asset store
   * for a real recording.
   */
  resolveChunks(ref: string): Promise<string[]>
  /** Recorded provider; part of the request identity. */
  provider?: string
  /** Actor used when a request carries no actor header. */
  defaultActorRef?: string
}

export interface TapeServerHandledRequest {
  actorRef: string
  purpose: ModelRequestPurpose
  requestDigest: string
  matched: boolean
}

export interface TapeServer {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string
  /**
   * The base URL to hand a provider SDK so its calls take `actorRef`'s lease.
   *
   * This is how a child agent is kept separate without touching the SDK: the
   * runner spawns it with `ANTHROPIC_BASE_URL` pointed here, and the actor
   * falls out of the request path.
   */
  baseUrlFor(actorRef: string): string
  /** Every request the server saw, for the run report. */
  readonly handled: TapeServerHandledRequest[]
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

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name]
  if (Array.isArray(raw)) return raw[0]
  return typeof raw === "string" ? raw : undefined
}

/** The declared purpose, or `undefined` when the caller could not supply one. */
function readPurpose(request: IncomingMessage): ModelRequestPurpose | undefined {
  const raw = headerValue(request, REPLAY_PURPOSE_HEADER)
  return PURPOSES.includes(raw ?? "") ? (raw as ModelRequestPurpose) : undefined
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  })
  response.end(payload)
}

function anthropicError(type: string, message: string): Record<string, unknown> {
  return { type: "error", error: { type, message } }
}

function sseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
}

function writeEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

function messageStart(model: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: "msg_replay",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

/**
 * Stream text deltas.
 *
 * `stopAfter` implements the `cancel` behaviour: the stream is cut mid-flight
 * by destroying the socket, which is what a real interrupted provider response
 * looks like to the SDK. Ending the response normally would instead look like a
 * short but successful turn, and would never exercise the recovery path.
 */
async function writeStream(
  response: ServerResponse,
  chunks: readonly string[],
  model: string,
  stopAfter?: number
): Promise<void> {
  let aborted = false
  response.on("close", () => {
    aborted = true
  })

  sseHeaders(response)
  writeEvent(response, "message_start", messageStart(model))
  writeEvent(response, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })

  let written = 0
  for (const chunk of chunks) {
    if (aborted || response.writableEnded) return
    if (stopAfter !== undefined && written >= stopAfter) {
      response.destroy()
      return
    }
    writeEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: chunk },
    })
    written += 1
  }

  if (stopAfter !== undefined) {
    // Fewer chunks than the cut point: the recording still says this turn was
    // interrupted, so cut it rather than completing.
    response.destroy()
    return
  }
  if (aborted || response.writableEnded) return

  writeEvent(response, "content_block_stop", { type: "content_block_stop", index: 0 })
  writeEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: chunks.join("").length },
  })
  writeEvent(response, "message_stop", { type: "message_stop" })
  response.end()
}

function writeWholeMessage(
  response: ServerResponse,
  chunks: readonly string[],
  model: string
): void {
  sendJson(response, 200, {
    id: "msg_replay",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: chunks.join("") }],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: chunks.join("").length },
  })
}

export function createTapeServer(options: TapeServerOptions): TapeServer {
  const provider = options.provider ?? "anthropic"
  const defaultActorRef = options.defaultActorRef ?? "root"
  const handled: TapeServerHandledRequest[] = []
  let server: Server | undefined
  let boundPort = 0

  async function serveTape(
    tape: ReplayTapeV1,
    response: ServerResponse,
    model: string,
    streaming: boolean
  ): Promise<void> {
    // Bound once: narrowing on `tape.behavior` does not survive an `await`,
    // because TypeScript must assume the property could have changed.
    const behavior = tape.behavior
    switch (behavior.kind) {
      case "stream": {
        const chunks = await options.resolveChunks(behavior.chunksRef)
        if (streaming) await writeStream(response, chunks, model)
        else writeWholeMessage(response, chunks, model)
        return
      }
      case "error": {
        sendJson(response, behavior.status ?? 500, anthropicError(behavior.code, behavior.message))
        return
      }
      case "cancel": {
        await writeStream(response, [], model, behavior.afterChunks ?? 0)
        return
      }
      case "hang": {
        // Hold the socket open without answering, then drop it. This is the
        // shape that has broken timeout handling before: headers sent, nothing
        // following.
        sseHeaders(response)
        writeEvent(response, "message_start", messageStart(model))
        await new Promise((resolve) => setTimeout(resolve, behavior.holdMs))
        if (!response.writableEnded) response.destroy()
        return
      }
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { actorRef: pathActor, apiPath } = parseActorPath(request.url ?? "")
    if (request.method !== "POST" || !apiPath.startsWith("/v1/messages")) {
      sendJson(
        response,
        404,
        anthropicError(
          "replay_unsupported_route",
          `the replay tape server only answers POST /v1/messages; got ${request.method} ${request.url}`
        )
      )
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(await readBody(request)) as Record<string, unknown>
    } catch {
      sendJson(response, 400, anthropicError("invalid_request_error", "request body is not JSON"))
      return
    }

    const actorRef = pathActor ?? headerValue(request, REPLAY_ACTOR_HEADER) ?? defaultActorRef
    const declaredPurpose = readPurpose(request)
    const purpose = declaredPurpose ?? "turn"
    const { requestDigest } = await digestAnthropicRequest(payload, { provider, purpose })
    const lease = options.ledger.lease(actorRef)
    // A declared purpose is the strong match; without one, fall back to the
    // digest and let the lease refuse anything ambiguous.
    const tape = declaredPurpose
      ? lease.take({ purpose: declaredPurpose, requestDigest })
      : lease.takeByDigest(requestDigest)

    handled.push({ actorRef, purpose, requestDigest, matched: Boolean(tape) })

    if (!tape) {
      // Deliberately not a plausible completion: an invented answer would make
      // the run pass while testing nothing.
      sendJson(
        response,
        502,
        anthropicError(
          "replay_no_tape",
          `no tape for actor "${actorRef}" purpose "${purpose}" digest ${requestDigest}. ` +
            "Re-record the fixture, or check whether the prompt or tool surface changed."
        )
      )
      return
    }

    const model = typeof payload.model === "string" ? payload.model : "claude-opus-5"
    await serveTape(tape, response, model, payload.stream === true)
  }

  return {
    get port() {
      return boundPort
    },
    get baseUrl() {
      return `http://127.0.0.1:${boundPort}`
    },
    baseUrlFor(actorRef: string) {
      return `http://127.0.0.1:${boundPort}${ACTOR_PATH_PREFIX}${encodeURIComponent(actorRef)}`
    },
    handled,
    async start(port = 0) {
      server = createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
          if (response.headersSent) {
            response.destroy()
            return
          }
          sendJson(
            response,
            500,
            anthropicError(
              "replay_server_error",
              error instanceof Error ? error.message : String(error)
            )
          )
        })
      })

      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject)
        // Loopback only. A replay run holds a fixture corpus and must not be
        // reachable from another host.
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
