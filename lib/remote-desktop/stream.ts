/**
 * What a remote desktop viewer connects to for one open session (ADR-0234
 * Phase 3).
 *
 * * The desktop's own Host: the loopback WebSocket URL the session carries.
 * * A remote Host on a connected HTTPS+WS tier (`ws-lan` / `ws-tunnel`): a
 *   ticketed `/ws/remote-desktop/{sessionId}` URL.
 * * A remote Host on a WebRTC tier (`rtc-direct` / `rtc-relay`): a fresh
 *   `cognia.rfb` datachannel, attached to the session before it is handed
 *   over. The Host answers the attach in text, then sends the RFB banner
 *   straight away; the viewer is created later (after a React render), so the
 *   channel is wrapped in a {@link BufferedRfbChannel} that holds bytes until
 *   the viewer installs its handler.
 *
 * noVNC (and the third-party port relay) accept a URL or a raw channel with
 * the `RTCDataChannel` surface, so the viewer never learns which it got.
 */

import { acquireManagementChannel } from "@/lib/remote-host/management-channel"
import type { Transport } from "@/lib/tauri/transport-types"

import { RemoteDesktopError } from "./host-client"
import type { RemoteDesktopHostRef, RemoteDesktopSessionOpened } from "./types"
import type {
  RemoteDesktopConnection,
  RemoteDesktopRawChannel,
} from "@cognia/plugin-contract/lib/remote-desktop/stream"
export type {
  RemoteDesktopConnection,
  RemoteDesktopRawChannel,
} from "@cognia/plugin-contract/lib/remote-desktop/stream"

export interface RemoteDesktopStream {
  connection: RemoteDesktopConnection
  /** Release what the stream holds (the channel, the management lease). */
  close: () => void
}

/** How long the Host has to answer an attach. */
export const RFB_ATTACH_TIMEOUT_MS = 15_000
/** Largest message sent on a `cognia.rfb` channel (the Host's own cap too). */
export const RFB_CHUNK_BYTES = 16 * 1024

interface StreamCapableTransport {
  getActiveTier?: () => string
  remoteDesktopSocketUrl?: (sessionId: string) => Promise<string>
  openRfbDataChannel?: () => RTCDataChannel | null
}

export interface RemoteDesktopStreamDeps {
  acquire?: (hostRef: string) => Promise<{ transport: Transport; release: () => void }>
  attachTimeoutMs?: number
}

/**
 * An attached `cognia.rfb` channel in the shape noVNC attaches to. Messages
 * that arrive before the viewer sets `onmessage` are queued and delivered, in
 * order, on the next task after it does, so noVNC has finished attaching.
 */
export class BufferedRfbChannel implements RemoteDesktopRawChannel {
  private handler: ((event: MessageEvent) => void) | null = null
  private readonly queue: MessageEvent[] = []
  private flushing = false
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(private readonly channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer"
    channel.onmessage = (event) => {
      if (this.handler && !this.flushing && this.queue.length === 0) this.handler(event)
      else this.queue.push(event)
    }
    channel.onclose = (event) => this.onclose?.(event)
    channel.onerror = (event) => this.onerror?.(event)
    channel.onopen = (event) => this.onopen?.(event)
  }

  get binaryType(): string {
    return this.channel.binaryType
  }

  set binaryType(value: string) {
    this.channel.binaryType = value as BinaryType
  }

  get protocol(): string {
    return this.channel.protocol
  }

  get readyState(): string {
    return this.channel.readyState
  }

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.handler
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    this.handler = handler
    if (!handler || this.queue.length === 0 || this.flushing) return
    this.flushing = true
    setTimeout(() => {
      while (this.queue.length > 0 && this.handler) this.handler(this.queue.shift()!)
      this.flushing = false
    }, 0)
  }

  /** RFB is a byte stream, so large writes go out in interoperable pieces. */
  send(data: ArrayBuffer | ArrayBufferView): void {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    for (let offset = 0; offset < bytes.byteLength; offset += RFB_CHUNK_BYTES) {
      this.channel.send(bytes.slice(offset, offset + RFB_CHUNK_BYTES))
    }
  }

  close(): void {
    this.channel.close()
  }
}

/**
 * Attach a freshly created channel to `sessionId`: wait for it to open, send
 * the attach, and wait for the Host's answer. The Host's refusal comes back
 * as its own code.
 */
export function attachRfbChannel(
  channel: RTCDataChannel,
  sessionId: string,
  timeoutMs = RFB_ATTACH_TIMEOUT_MS
): Promise<BufferedRfbChannel> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: RemoteDesktopError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.onopen = null
      channel.onclose = null
      channel.onerror = null
      if (error) {
        channel.onmessage = null
        try {
          channel.close()
        } catch {
          // Already closing.
        }
        reject(error)
        return
      }
      // Wrapping replaces `onmessage` synchronously, inside this message
      // event: the RFB banner that follows cannot slip past it.
      resolve(new BufferedRfbChannel(channel))
    }
    const timer = setTimeout(
      () => finish(new RemoteDesktopError("remote_desktop_ticket_expired")),
      timeoutMs
    )
    const sendAttach = () => channel.send(JSON.stringify({ type: "attach", sessionId }))
    channel.binaryType = "arraybuffer"
    channel.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        finish(new RemoteDesktopError("remote_desktop_protocol_invalid"))
        return
      }
      let reply: { type?: unknown; code?: unknown }
      try {
        reply = JSON.parse(event.data) as { type?: unknown; code?: unknown }
      } catch {
        finish(new RemoteDesktopError("remote_desktop_protocol_invalid"))
        return
      }
      if (reply.type === "attached") finish()
      else if (reply.type === "error" && typeof reply.code === "string")
        finish(new RemoteDesktopError(reply.code))
      else finish(new RemoteDesktopError("remote_desktop_protocol_invalid"))
    }
    channel.onclose = () => finish(new RemoteDesktopError("remote_desktop_connection_lost"))
    channel.onerror = () => finish(new RemoteDesktopError("remote_desktop_connection_lost"))
    if (channel.readyState === "open") sendAttach()
    else channel.onopen = sendAttach
  })
}

/** Open what the session's viewer connects to. */
export async function openRemoteDesktopStream(
  host: RemoteDesktopHostRef,
  session: RemoteDesktopSessionOpened,
  deps: RemoteDesktopStreamDeps = {}
): Promise<RemoteDesktopStream> {
  if (session.transport === "loopback") {
    if (host.kind !== "local" || !session.url) {
      throw new RemoteDesktopError("remote_desktop_protocol_invalid")
    }
    return { connection: session.url, close: () => undefined }
  }
  if (host.kind !== "remote") throw new RemoteDesktopError("remote_desktop_protocol_invalid")
  const lease = await (deps.acquire ?? acquireManagementChannel)(host.hostRef)
  try {
    const transport = lease.transport as Transport & StreamCapableTransport
    const tier = transport.getActiveTier?.()
    if ((tier === "ws-lan" || tier === "ws-tunnel") && transport.remoteDesktopSocketUrl) {
      const url = await transport.remoteDesktopSocketUrl(session.sessionId)
      return { connection: url, close: lease.release }
    }
    if ((tier === "rtc-direct" || tier === "rtc-relay") && transport.openRfbDataChannel) {
      const raw = transport.openRfbDataChannel()
      if (!raw) throw new RemoteDesktopError("remote_desktop_transport_unavailable")
      const channel = await attachRfbChannel(raw, session.sessionId, deps.attachTimeoutMs)
      return {
        connection: channel,
        close: () => {
          channel.close()
          lease.release()
        },
      }
    }
    // Offline, or only the relay's data lane: neither carries a byte stream.
    throw new RemoteDesktopError("remote_desktop_transport_unavailable")
  } catch (error) {
    lease.release()
    throw error
  }
}
