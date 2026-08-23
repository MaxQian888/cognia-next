"use client"

/**
 * Streaming counterpart to [`createPlatformFetch`].
 *
 * `proxyFetch` is buffered: it resolves on the last byte. That is correct for
 * a JSON API call and useless for a body that never ends. Three shapes in this
 * app need bytes as they arrive —
 *
 *   - SSE subscriptions (`text/event-stream`), where a buffered transport
 *     delivers literally nothing;
 *   - long-lived NDJSON, where progress before the end is the point;
 *   - large downloads, which the buffered bridge caps at 64 MiB and holds in
 *     memory twice on each side of the IPC.
 *
 * Before this existed, each such caller either invented its own Rust command
 * (`server_ops_events_*`, `ollama_pull_model_stream`) or fell back to a
 * renderer `EventSource` — which cannot set `Authorization`, is blocked by the
 * packaged shell's `connect-src`, and never sees the configured proxy. This is
 * the generic seam so the next one needs neither.
 *
 * Returns a real `Response` whose body is a `ReadableStream`, so callers use
 * `response.body.getReader()`, `TextDecoderStream`, or any SSE parser exactly
 * as they would with `fetch`.
 *
 * **Not a replacement for the dedicated streams.** Ollama pull, Ops Controller
 * events and the TTS download each carry protocol-specific framing on the Rust
 * side and stay as they are; this serves callers that want HTTP semantics.
 *
 * Off Tauri it delegates to the platform `fetch`, whose body is already a
 * stream — so the web and Capacitor builds are unchanged.
 */

import { Channel, invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

export interface StreamingFetchOptions extends RequestInit {
  /** Bounds the response *head* only. A stream body is unbounded by design. */
  connectTimeout?: number
  /**
   * Maximum silence between body chunks. Omit to leave the stream open
   * indefinitely — what a subscription wants. SSE callers should set this
   * above the origin's keep-alive interval so a dead peer is still detected.
   */
  readTimeout?: number
  /** Reject private/loopback/link-local targets in the native boundary. */
  blockPrivateHosts?: boolean
}

export type PlatformStreamingFetch = (
  input: RequestInfo | URL,
  init?: StreamingFetchOptions
) => Promise<Response>

interface StreamOpenInput {
  requestId: string
  url: string
  method: string
  headers: Record<string, string>
  bodyBase64?: string
  connectTimeoutMs?: number
  readTimeoutMs?: number
  redirect: RequestRedirect
  blockPrivate?: boolean
}

interface StreamOpenOutput {
  requestId: string
  status: number
  headers: Record<string, string>
}

type StreamEvent =
  | { kind: "chunk"; seq: number; bodyBase64: string }
  | { kind: "error"; message: string }
  | { kind: "end" }

/**
 * Statuses whose `Response` MUST have a null body. Same list as the buffered
 * bridge — a zero-length stream is still a body and the constructor throws.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `proxy-stream-${Date.now()}-${Math.random()}`
}

function abortError(): Error {
  if (typeof DOMException !== "undefined")
    return new DOMException("The operation was aborted", "AbortError")
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function headerRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "proxy-authorization") {
      throw new Error("Proxy-Authorization is reserved for the native proxy connector")
    }
    result[key] = value
  })
  return result
}

async function bodyBase64(request: Request): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  const bytes = new Uint8Array(await request.clone().arrayBuffer())
  return bytes.length > 0 ? bytesToBase64(bytes) : undefined
}

/**
 * Bridge one native stream onto a `ReadableStream`.
 *
 * Chunks arrive on the channel whether or not the consumer is reading, so they
 * queue here and each is acknowledged only once handed to the consumer. That
 * ack is the flow-control signal the Rust side pauses on — without it a fast
 * origin and a slow reader reproduce the buffered bridge's memory problem.
 */
function nativeBodyStream(
  id: string,
  channel: Channel<StreamEvent>,
  onDone: () => void
): { stream: ReadableStream<Uint8Array>; abort: (reason: Error) => void } {
  const queue: Uint8Array[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let ended = false
  let failure: Error | undefined
  let cancelled = false

  const ack = (bytes: number) => {
    void invoke("proxy_http_stream_ack", { requestId: id, bytes }).catch(() => undefined)
  }

  const drain = () => {
    if (!controller) return
    while (queue.length > 0 && (controller.desiredSize ?? 1) > 0) {
      const chunk = queue.shift()!
      controller.enqueue(chunk)
      ack(chunk.byteLength)
    }
    if (queue.length > 0 || !ended) return
    // Terminate only once the controller itself has nothing buffered.
    // `desiredSize > 0` is that signal, and it matters because `error()`
    // DISCARDS whatever the controller still holds — closing here while a
    // chunk sat unread would silently drop bytes the origin really sent. The
    // consumer's next read triggers `pull`, which brings us back with an
    // empty controller queue.
    if ((controller.desiredSize ?? 1) <= 0) return
    if (failure) controller.error(failure)
    else controller.close()
    controller = undefined
    onDone()
  }

  channel.onmessage = (event) => {
    if (cancelled) return
    switch (event.kind) {
      case "chunk":
        queue.push(base64ToBytes(event.bodyBase64))
        drain()
        break
      case "error":
        // Recorded, not raised: `end` always follows, and surfacing the error
        // there keeps termination on a single path.
        failure = new Error(event.message)
        break
      case "end":
        ended = true
        drain()
        break
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      drain()
    },
    pull() {
      drain()
    },
    cancel() {
      cancelled = true
      controller = undefined
      queue.length = 0
      void invoke("proxy_http_stream_cancel", { requestId: id }).catch(() => undefined)
      onDone()
    },
  })

  /**
   * Tear the stream down from outside — what an `AbortSignal` firing after the
   * head arrived must do. Erroring the body is the visible half: a consumer
   * awaiting `read()` has to observe the `AbortError`, not a clean close it
   * would read as "the server finished".
   */
  const abort = (reason: Error) => {
    if (cancelled) return
    cancelled = true
    queue.length = 0
    void invoke("proxy_http_stream_cancel", { requestId: id }).catch(() => undefined)
    if (controller) {
      controller.error(reason)
      controller = undefined
    }
    onDone()
  }

  return { stream, abort }
}

async function tauriStreamingFetch(
  input: RequestInfo | URL,
  init: StreamingFetchOptions = {}
): Promise<Response> {
  const { connectTimeout, readTimeout, blockPrivateHosts, ...requestInit } = init
  const request = new Request(input, requestInit)
  if (request.signal.aborted) throw abortError()

  const id = requestId()
  const payload: StreamOpenInput = {
    requestId: id,
    url: request.url,
    method: request.method,
    headers: headerRecord(request.headers),
    bodyBase64: await bodyBase64(request),
    connectTimeoutMs: connectTimeout,
    readTimeoutMs: readTimeout,
    redirect: request.redirect,
    ...(blockPrivateHosts ? { blockPrivate: true } : {}),
  }
  if (request.signal.aborted) throw abortError()

  const channel = new Channel<StreamEvent>()
  // Set once the body stream exists. Before that, an abort can only cancel the
  // native side — there is no stream to error yet, and `open` rejects instead.
  // A holder rather than a `let`: the abort listener closes over it and reads
  // it before the assignment below, which is exactly the shape `prefer-const`
  // rejects.
  const abortBody: { current?: (reason: Error) => void } = {}
  const onAbort = () => {
    if (abortBody.current) abortBody.current(abortError())
    else void invoke("proxy_http_stream_cancel", { requestId: id }).catch(() => undefined)
  }
  request.signal.addEventListener("abort", onAbort, { once: true })
  const detachAbort = () => request.signal.removeEventListener("abort", onAbort)

  let head: StreamOpenOutput
  try {
    head = await invoke<StreamOpenOutput>("proxy_http_stream_open", {
      input: payload,
      onEvent: channel,
    })
  } catch (error) {
    detachAbort()
    if (request.signal.aborted) throw abortError()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Proxy stream failed: ${message}`, { cause: error })
  }

  const headers = new Headers(head.headers)
  if (NULL_BODY_STATUSES.has(head.status)) {
    // No body will ever arrive; release the native side rather than leaving a
    // task parked on a stream nobody reads.
    void invoke("proxy_http_stream_cancel", { requestId: id }).catch(() => undefined)
    detachAbort()
    return new Response(null, { status: head.status, headers })
  }

  const { stream, abort } = nativeBodyStream(id, channel, detachAbort)
  abortBody.current = abort
  // A signal that fired between `open` resolving and this assignment already
  // cancelled the native side; error the body now so the caller does not read
  // a stream that will only ever close empty.
  if (request.signal.aborted) abort(abortError())
  return new Response(stream, { status: head.status, headers })
}

async function browserStreamingFetch(
  input: RequestInfo | URL,
  init: StreamingFetchOptions = {}
): Promise<Response> {
  // `connectTimeout` maps onto an abort because the browser exposes no
  // head-only deadline; `readTimeout` and `blockPrivateHosts` are native-only
  // guards with no browser equivalent, and silently dropping them here is
  // correct — the shell that needs them is the one that has them.
  const {
    connectTimeout,
    readTimeout: _readTimeout,
    blockPrivateHosts: _blockPrivateHosts,
    ...requestInit
  } = init
  if (!connectTimeout) return fetch(input, requestInit)

  const request = new Request(input, requestInit)
  if (request.signal.aborted) throw abortError()
  const controller = new AbortController()
  const propagate = () => controller.abort()
  request.signal.addEventListener("abort", propagate, { once: true })
  const timer = setTimeout(() => controller.abort(), connectTimeout)
  try {
    return await fetch(request, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener("abort", propagate)
  }
}

/**
 * Create the canonical streaming fetch for this shell.
 *
 * `deps` exists so tests can pin a transport without a shell; production
 * passes nothing.
 */
export function createPlatformStreamingFetch(
  deps: { isTauri?: () => boolean } = {}
): PlatformStreamingFetch {
  const onTauri = deps.isTauri ?? isTauri
  return (input, init) =>
    onTauri() ? tauriStreamingFetch(input, init) : browserStreamingFetch(input, init)
}

export const platformStreamingFetch = createPlatformStreamingFetch()
