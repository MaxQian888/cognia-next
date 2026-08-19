"use client"

/**
 * Platform-routed transport for the Ops Controller client (ADR-0059).
 *
 * The controller lives on whatever host the operator enrolled, which means the
 * WebView cannot talk to it directly on any shell:
 *
 *   - **Tauri desktop** — `tauri.conf.json`'s `connect-src` allowlists a fixed
 *     set of origins, and a user-entered controller is never on it. A renderer
 *     `fetch` is blocked by CSP before it reaches the network, so requests go
 *     through `proxyFetch` (the native `proxy_http_request` bridge), which also
 *     picks up the desktop proxy policy. `connectorsHttpRequest` would work too
 *     but carries a 5 req/s per-host token bucket sized for chat platforms —
 *     enough to throttle a fleet refresh, which fans out one request per server.
 *   - **Capacitor mobile** — the WebView origin is `capacitor://`, and a
 *     self-hosted controller sends no CORS headers, so `CapacitorHttp.request`
 *     is the only path. Same reasoning as `lib/webdav/transport.ts`.
 *   - **Web** — an ordinary browser `fetch`, which reaches a controller only if
 *     that controller opts into CORS. [`opsTransportKind`] reports `"browser"`
 *     so the UI can say as much instead of failing opaquely.
 *
 * Live events are a separate problem from requests. `GET /v1/events` is an SSE
 * body that never ends, so neither buffered native bridge can carry it: they
 * resolve on the last byte, which never arrives. Desktop therefore streams
 * through a dedicated native command (`server_ops_events_open`), and the other
 * two shells fall back to polling — see [`supportsLiveOperationEvents`].
 */

import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"

import { getCapacitorHttp } from "@/lib/connectivity/capacitor-http"
import { createProxyFetch } from "@/lib/network/proxy-fetch"
import { detectPlatform } from "@/lib/platform/detect"
import { OpsError, type OperationEvent, type OpsFetch } from "./client"

export type OpsTransportKind = "tauri" | "capacitor" | "browser"

/** Which transport this shell will use for controller traffic. */
export function opsTransportKind(): OpsTransportKind {
  const platform = detectPlatform()
  if (platform === "tauri") return "tauri"
  // `detectPlatform` reports `mobile` for the Capacitor shell, but the native
  // HTTP plugin is what actually decides whether the CORS-free path exists —
  // a mobile web build has the former without the latter.
  if (platform === "mobile" && getCapacitorHttp()) return "capacitor"
  return "browser"
}

/**
 * Whether this shell can hold the controller's SSE stream open.
 *
 * False everywhere the only transport is buffered. Callers fall back to
 * polling the operations they already know about rather than pretending the
 * fleet is live.
 */
export function supportsLiveOperationEvents(): boolean {
  return opsTransportKind() === "tauri"
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

/**
 * `fetch` over `CapacitorHttp`. Only the shapes the controller client actually
 * sends are supported: text bodies, JSON responses, no redirect following
 * beyond what the native stack does on its own.
 */
async function capacitorFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const plugin = getCapacitorHttp()
  if (!plugin) throw new OpsError("network_unavailable", 0, "CapacitorHttp is unavailable")
  const request = new Request(input, init)
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
  const response = await plugin.request({
    url: request.url,
    method: request.method as "GET" | "POST",
    headers: headerRecord(request.headers),
    data: body,
    // Text, not json: the controller's error bodies and its success bodies are
    // both JSON, but a native auto-parse would hand back an object the
    // `Response` constructor cannot take, and `OpsClient` parses either way.
    responseType: "text",
    connectTimeout: 30_000,
    readTimeout: 30_000,
  })
  const payload = typeof response.data === "string" ? response.data : JSON.stringify(response.data)
  // 204/304 carry no body, and `new Response(body)` throws on a non-null body
  // for those statuses — an empty string is still a body.
  const nullBody = response.status === 204 || response.status === 304
  return new Response(nullBody ? null : payload, {
    status: response.status,
    headers: response.headers,
  })
}

/** The `fetch` implementation this shell should give [`OpsClient`]. */
export function createOpsFetch(): OpsFetch {
  switch (opsTransportKind()) {
    case "capacitor":
      return capacitorFetch
    case "tauri": {
      // Wrapped rather than returned directly: `createProxyFetch` accepts its
      // own `ProxyFetchOptions` init, which is narrower than `RequestInit` and
      // so not assignable to `OpsFetch` under `strictFunctionTypes`.
      const proxied = createProxyFetch()
      return (input, init) => proxied(input, init)
    }
    default:
      return (input, init) => fetch(input, init)
  }
}

/** One message on the native `server-ops://events/<streamId>` channel. */
type NativeStreamMessage =
  | { kind: "open" }
  | { kind: "event"; id: string | null; event: string | null; data: string; retry: number | null }
  | { kind: "closed"; error: string | null }

function streamId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ops-events-${Date.now()}-${Math.random()}`
}

/**
 * Decode one controller frame.
 *
 * Frames that are not operation events (the `controller-error` the SSE endpoint
 * emits when its event storage is unreachable) are dropped rather than thrown:
 * the stream itself is still healthy, and killing it would trade a recoverable
 * storage blip for a full reconnect cycle.
 */
function decodeEvent(name: string | null, data: string): OperationEvent | null {
  if (name !== null && name !== "operation" && name !== "message") return null
  try {
    const parsed = JSON.parse(data) as Partial<OperationEvent>
    if (typeof parsed.id !== "number" || typeof parsed.operationId !== "string") return null
    return parsed as OperationEvent
  } catch {
    return null
  }
}

/**
 * Stream `/v1/events` through the native command, yielding each operation
 * event as it arrives.
 *
 * The generator ends when the controller closes the stream, when the native
 * task fails, or when `signal` aborts — a failure surfaces as an `OpsError` so
 * the caller's reconnect loop can tell an expired token from a dead host.
 */
async function* nativeEventStream(options: {
  controllerUrl: string
  accessToken: () => Promise<string>
  lastEventId?: number
  signal?: AbortSignal
}): AsyncGenerator<OperationEvent> {
  const token = await options.accessToken()
  if (!token) throw new OpsError("authentication_required", 401, "Authentication is required")
  // A caller that supplies no signal wants the stream to run until the
  // controller ends it; a never-aborting signal expresses that without
  // scattering optional checks through the loop below.
  const signal = options.signal ?? new AbortController().signal
  if (signal.aborted) return

  const id = streamId()
  const pending: OperationEvent[] = []
  let finished: { error: string | null } | null = null
  // Resolved by whichever arrives first — an event, the close message, or the
  // abort. Recreated after every wake-up so no wake-up is missed between waits.
  let wake: (() => void) | null = null
  const notify = () => {
    wake?.()
    wake = null
  }

  const unlisten = await listen<NativeStreamMessage>(`server-ops://events/${id}`, (message) => {
    const payload = message.payload
    if (payload.kind === "event") {
      const event = decodeEvent(payload.event, payload.data)
      if (event) pending.push(event)
    } else if (payload.kind === "closed") {
      finished = { error: payload.error }
    }
    notify()
  })
  const onAbort = () => notify()
  signal.addEventListener("abort", onAbort, { once: true })

  try {
    await invoke("server_ops_events_open", {
      streamId: id,
      controllerUrl: options.controllerUrl,
      accessToken: token,
      lastEventId: options.lastEventId === undefined ? null : String(options.lastEventId),
    })

    for (;;) {
      while (pending.length > 0) {
        if (signal.aborted) return
        yield pending.shift() as OperationEvent
      }
      if (signal.aborted) return
      if (finished) {
        const { error } = finished as { error: string | null }
        if (error) throw new OpsError("event_stream_failed", 0, error)
        return
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    unlisten()
    signal.removeEventListener("abort", onAbort)
    // Idempotent on the native side — a stream that already ended reports
    // `false` rather than failing, which is the normal shape of an effect
    // cleanup racing a server-side disconnect.
    void invoke("server_ops_events_close", { streamId: id }).catch(() => undefined)
  }
}

export type OpsEventStreamFn = (options: {
  lastEventId?: number
  signal?: AbortSignal
}) => AsyncGenerator<OperationEvent>

/**
 * The event-stream implementation for this shell, or `null` where no shell-side
 * transport can hold a stream open. A `null` return is the signal to poll.
 */
export function createOpsEventStream(options: {
  controllerUrl: string
  accessToken: () => Promise<string>
}): OpsEventStreamFn | null {
  if (!supportsLiveOperationEvents()) return null
  return (streamOptions) =>
    nativeEventStream({
      controllerUrl: options.controllerUrl,
      accessToken: options.accessToken,
      ...streamOptions,
    })
}
