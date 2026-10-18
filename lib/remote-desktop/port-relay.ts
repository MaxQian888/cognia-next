/**
 * The byte relay for third-party remote desktop viewers (ADR-0234 §3).
 *
 * A third-party viewer is a sandboxed, opaque-origin webview page. It never
 * learns the bridge URL, its one-shot ticket or the transport: the app's own
 * document opens the WebSocket (loopback, or the Host's ticketed viewer
 * socket) or holds the attached `cognia.rfb` channel, and hands the page one
 * end of a `MessageChannel`.
 *
 * Protocol on the page's port:
 *  * The page receives a host message `{ type: "cognia.remote-desktop.port",
 *    mode }` whose event carries the port in `ports[0]`.
 *  * Binary messages (`ArrayBuffer`) in both directions are the session's RFB
 *    bytes, already past authentication (security type None).
 *  * The host posts `{ type: "closed" }` when the session ends; the page may
 *    post `{ type: "close" }` to end it.
 *
 * Frames from the page are capped at the bridge's own 1 MiB limit, so a page
 * cannot make the app buffer more than the Host would accept.
 */

import type { RemoteDesktopConnection, RemoteDesktopRawChannel } from "./stream"
import type { RemoteDesktopSessionMode } from "./types"

export const REMOTE_DESKTOP_PORT_MESSAGE = "cognia.remote-desktop.port"
export const MAX_RELAY_FRAME_BYTES = 1024 * 1024
/** Largest message sent on a datachannel; browsers interoperate on 16 KiB. */
export const CHANNEL_CHUNK_BYTES = 16 * 1024

export type RelayStatus = "connecting" | "connected" | "disconnected"

export interface RemoteDesktopRelayOptions {
  /** A WebSocket URL to open, or an attached channel that is already open. */
  connection: RemoteDesktopConnection
  mode: RemoteDesktopSessionMode
  /** Posts into the viewer's frame, transferring the port. */
  post: (data: unknown, transfer: Transferable[]) => boolean
  onStatus: (status: RelayStatus) => void
  onError: (code: string) => void
  /** Test seam. */
  createSocket?: (url: string, protocols: string[]) => WebSocket
  createChannel?: () => MessageChannel
}

function asBinary(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
  }
  return null
}

/** A WebSocket or a raw channel: both carry binary frames, with different readyStates. */
type Carrier = WebSocket | RemoteDesktopRawChannel

function isOpen(carrier: Carrier): boolean {
  return carrier.readyState === "open" || carrier.readyState === WebSocket.OPEN
}

function isLive(carrier: Carrier): boolean {
  return (
    isOpen(carrier) ||
    carrier.readyState === "connecting" ||
    carrier.readyState === WebSocket.CONNECTING
  )
}

/** Start relaying; returns a stop function that closes both ends. */
export function startRemoteDesktopRelay(options: RemoteDesktopRelayOptions): () => void {
  // The loopback bridge never goes through a proxy (network-egress allowlist).
  const createSocket =
    options.createSocket ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols))
  const channel = (options.createChannel ?? (() => new MessageChannel()))()
  const local = channel.port1
  let stopped = false
  let delivered = false
  const socket: Carrier =
    typeof options.connection === "string"
      ? createSocket(options.connection, ["binary"])
      : options.connection
  socket.binaryType = "arraybuffer"
  options.onStatus("connecting")

  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      local.postMessage({ type: "closed" })
    } catch {
      // The page may already be gone.
    }
    local.close()
    if (isLive(socket)) socket.close()
    options.onStatus("disconnected")
  }

  const onOpen = () => {
    if (stopped) return
    delivered = options.post({ type: REMOTE_DESKTOP_PORT_MESSAGE, mode: options.mode }, [
      channel.port2,
    ])
    if (!delivered) {
      options.onError("remote_desktop_viewer_failed")
      stop()
      return
    }
    options.onStatus("connected")
  }
  socket.onopen = onOpen
  socket.onmessage = (event: MessageEvent) => {
    const bytes = asBinary(event.data)
    if (!bytes || stopped) return
    local.postMessage(bytes, [bytes])
  }
  socket.onerror = () => {
    if (!stopped) options.onError("remote_desktop_connection_lost")
  }
  socket.onclose = () => stop()

  local.onmessage = (event: MessageEvent) => {
    if (stopped) return
    const bytes = asBinary(event.data)
    if (bytes) {
      if (bytes.byteLength > MAX_RELAY_FRAME_BYTES) {
        options.onError("remote_desktop_protocol_invalid")
        stop()
        return
      }
      if (!isOpen(socket)) return
      if (typeof options.connection === "string") {
        socket.send(bytes)
        return
      }
      // RFB is a byte stream, so a channel takes it in interoperable pieces.
      for (let offset = 0; offset < bytes.byteLength; offset += CHANNEL_CHUNK_BYTES) {
        socket.send(bytes.slice(offset, offset + CHANNEL_CHUNK_BYTES))
      }
      return
    }
    if ((event.data as { type?: unknown } | null)?.type === "close") stop()
  }
  local.start()
  // An attached channel is open already; it will not fire `open` again.
  if (typeof options.connection !== "string" && isOpen(socket)) onOpen()

  return stop
}
