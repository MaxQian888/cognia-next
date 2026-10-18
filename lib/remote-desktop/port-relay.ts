/**
 * The byte relay for third-party remote desktop viewers (ADR-0234 §3).
 *
 * A third-party viewer is a sandboxed, opaque-origin webview page. It never
 * learns the bridge URL or its one-shot ticket: the app's own document opens
 * the loopback WebSocket and hands the page one end of a `MessageChannel`.
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

import type { RemoteDesktopSessionMode } from "./types"

export const REMOTE_DESKTOP_PORT_MESSAGE = "cognia.remote-desktop.port"
export const MAX_RELAY_FRAME_BYTES = 1024 * 1024

export type RelayStatus = "connecting" | "connected" | "disconnected"

export interface RemoteDesktopRelayOptions {
  url: string
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

/** Start relaying; returns a stop function that closes both ends. */
export function startRemoteDesktopRelay(options: RemoteDesktopRelayOptions): () => void {
  // The loopback bridge never goes through a proxy (network-egress allowlist).
  const createSocket =
    options.createSocket ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols))
  const channel = (options.createChannel ?? (() => new MessageChannel()))()
  const local = channel.port1
  let stopped = false
  let delivered = false
  const socket = createSocket(options.url, ["binary"])
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
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close()
    }
    options.onStatus("disconnected")
  }

  socket.onopen = () => {
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
      if (socket.readyState === WebSocket.OPEN) socket.send(bytes)
      return
    }
    if ((event.data as { type?: unknown } | null)?.type === "close") stop()
  }
  local.start()

  return stop
}
