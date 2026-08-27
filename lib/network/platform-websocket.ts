"use client"

/**
 * Proxy-aware WebSocket for the desktop Host.
 *
 * A renderer `new WebSocket("wss://…")` bypasses everything the Off/Manual/Auto
 * proxy settings control: there is no `Proxy-Authorization`, no CONNECT tunnel,
 * no bypass list, and no way to attach a header the handshake needs (an
 * `Authorization` bearer, most obviously — the `WebSocket` constructor takes
 * none). On the desktop it is also subject to `connect-src`.
 *
 * Rust already solved this once, for platform connectors: `connectors_ws_open`
 * dials through `wsproxy::connect_via_proxy`, applies `websocket_route_for`
 * (which *fails* rather than silently connecting direct when the user turned
 * WebSocket proxying off), and pumps frames back as Tauri events. That
 * capability was reachable only by importing `lib/connectors/**`, so everything
 * outside the connector subsystem — ACP, canvas collaboration — used a bare
 * socket instead.
 *
 * This is that transport with the connector-shaped naming removed. It adds no
 * Rust: `connectors_ws_*` stays the single WebSocket stack, and the existing
 * connector adapters keep calling it directly.
 *
 * Off Tauri it falls back to the platform `WebSocket`, which is the only option
 * a browser or Capacitor WebView has — and, per the desktop-Host scope, is
 * exactly the behaviour those shells had before.
 *
 * The renderer preallocates the native handle id and subscribes before asking
 * Rust to handshake, so a server's first event cannot race listener setup.
 */

import { loggers } from "@cognia/logging"

import {
  connectorsWsClose,
  connectorsWsOpen,
  connectorsWsSend,
} from "@/lib/connectors/tauri/commands"
import { connectorListen, type ConnectorUnlistenFn } from "@/lib/connectors/events"
import { isTauri } from "@/lib/tauri"

const log = loggers.network

export interface PlatformWebSocketHandlers {
  /** A text frame. Binary frames arrive on `onBinary` instead. */
  onMessage?: (data: string) => void
  onBinary?: (data: Uint8Array) => void
  /**
   * Terminal. `code`/`reason` are null when the peer vanished without a close
   * frame, which is what an abrupt EOF or a read error looks like.
   */
  onClose?: (info: { code: number | null; reason: string | null }) => void
  /** Non-terminal on its own — `onClose` always follows. */
  onError?: (message: string) => void
}

export interface PlatformWebSocketOptions extends PlatformWebSocketHandlers {
  /**
   * Handshake headers. Native only: a browser `WebSocket` cannot send them, so
   * off Tauri this throws rather than connecting without the auth the caller
   * asked for.
   */
  headers?: Record<string, string>
}

export interface PlatformWebSocket {
  /** Stable handle id. Native only — `"browser"` on the fallback path. */
  readonly id: string
  /** Which transport actually carried the connection. */
  readonly kind: "native" | "browser"
  send(data: string | Uint8Array): Promise<void>
  close(): Promise<void>
}

/** Thrown when handshake headers are requested on a shell that cannot send them. */
export class PlatformWebSocketHeadersUnsupportedError extends Error {
  constructor() {
    super(
      "This shell cannot send WebSocket handshake headers; the browser WebSocket API has no way to set them."
    )
    this.name = "PlatformWebSocketHeadersUnsupportedError"
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function openNative(
  options: PlatformWebSocketOptions,
  open: (handleId: string) => Promise<string>,
  createHandleId: () => string,
  onPrepared?: (socket: PlatformWebSocket) => void
): Promise<PlatformWebSocket> {
  const id = createHandleId()
  const unlisteners: ConnectorUnlistenFn[] = []
  let closed = false
  const teardown = () => {
    for (const unlisten of unlisteners) {
      try {
        unlisten()
      } catch (error) {
        log.debug("platform-websocket: unlisten threw during teardown", { error })
      }
    }
    unlisteners.length = 0
  }

  unlisteners.push(
    await connectorListen<string>(`connectors://ws/${id}/message`, (event) => {
      options.onMessage?.(event.payload)
    })
  )

  unlisteners.push(
    await connectorListen<string>(`connectors://ws/${id}/binary`, (event) => {
      options.onBinary?.(decodeBase64(event.payload))
    })
  )
  unlisteners.push(
    await connectorListen<string>(`connectors://ws/${id}/error`, (event) => {
      options.onError?.(event.payload)
    })
  )
  unlisteners.push(
    await connectorListen<unknown>(`connectors://ws/${id}/close`, (event) => {
      if (closed) return
      closed = true
      const payload = event.payload as { code?: unknown; reason?: unknown } | null | undefined
      const code = typeof payload?.code === "number" ? payload.code : null
      const reason = typeof payload?.reason === "string" ? payload.reason : null
      teardown()
      options.onClose?.({ code, reason })
    })
  )

  const socket: PlatformWebSocket = {
    id,
    kind: "native",
    send: (data) => connectorsWsSend(id, data),
    close: async () => {
      if (closed) return
      closed = true
      teardown()
      await connectorsWsClose(id)
    },
  }
  onPrepared?.(socket)

  try {
    // Rust raises here when the target would be proxied but the user disabled
    // WebSocket proxying. Every listener already exists before the handshake.
    const openedId = await open(id)
    if (openedId !== id) {
      await connectorsWsClose(openedId).catch(() => undefined)
      throw new Error("native WebSocket returned a different handle id")
    }
  } catch (error) {
    teardown()
    throw error
  }

  return socket
}

function openBrowser(
  url: string,
  options: PlatformWebSocketOptions,
  factory: (url: string) => WebSocket
): Promise<PlatformWebSocket> {
  if (options.headers && Object.keys(options.headers).length > 0) {
    throw new PlatformWebSocketHeadersUnsupportedError()
  }
  return new Promise((resolve, reject) => {
    const socket = factory(url)
    let settled = false
    let closed = false

    socket.onopen = () => {
      settled = true
      resolve({
        id: "browser",
        kind: "browser",
        send: async (data) => {
          if (typeof data === "string") {
            socket.send(data)
            return
          }
          // Copy into an ArrayBuffer-backed view. The shared contract accepts
          // any Uint8Array, including one backed by SharedArrayBuffer, while
          // the DOM WebSocket overload only accepts an ArrayBuffer-backed view.
          const bytes = new Uint8Array(data.byteLength)
          bytes.set(data)
          socket.send(bytes.buffer)
        },
        close: async () => {
          if (closed) return
          closed = true
          socket.close()
        },
      })
    }
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        options.onMessage?.(event.data)
        return
      }
      if (!options.onBinary) return
      if (event.data instanceof ArrayBuffer) {
        options.onBinary(new Uint8Array(event.data))
      } else if (typeof Blob !== "undefined" && event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => options.onBinary?.(new Uint8Array(buffer)))
      }
    }
    socket.onerror = () => {
      // The browser event carries no diagnostic detail by design (it would
      // leak cross-origin information), so there is nothing better to report.
      options.onError?.("WebSocket error")
      // Before `onopen`, an error is the connect failing — reject rather than
      // resolve a handle whose socket is already dead.
      if (!settled) {
        settled = true
        reject(new Error(`WebSocket connection to ${url} failed`))
      }
    }
    socket.onclose = (event) => {
      if (closed) return
      closed = true
      options.onClose?.({ code: event.code ?? null, reason: event.reason || null })
      if (!settled) {
        settled = true
        reject(new Error(`WebSocket connection to ${url} closed before opening`))
      }
    }
  })
}

/**
 * Open a WebSocket through this shell's proxy-aware transport.
 *
 * `deps` exists so tests can pin a shell and a socket factory; production
 * passes nothing.
 */
export async function createPlatformWebSocket(
  url: string,
  options: PlatformWebSocketOptions = {},
  deps: {
    isTauri?: () => boolean
    socketFactory?: (url: string) => WebSocket
    nativeOpen?: (handleId: string) => Promise<string>
    createHandleId?: () => string
    onNativePrepared?: (socket: PlatformWebSocket) => void
  } = {}
): Promise<PlatformWebSocket> {
  const onTauri = deps.isTauri ?? isTauri
  if (onTauri()) {
    const open = deps.nativeOpen ?? ((handleId) => connectorsWsOpen(url, options.headers, handleId))
    return openNative(
      options,
      open,
      deps.createHandleId ?? (() => crypto.randomUUID()),
      deps.onNativePrepared
    )
  }
  const factory = deps.socketFactory ?? ((target: string) => new WebSocket(target))
  return openBrowser(url, options, factory)
}
