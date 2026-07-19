export interface RemoteBrowserFrame {
  version: 1
  codec: "jpeg"
  sequence: number
  width: number
  height: number
  timestamp: number
  jpeg: Uint8Array
}

export interface RemoteBrowserLease {
  epoch: number
  controller: { kind: "agent" | "human"; id: string }
  expiresAt?: number
}

export type RemoteBrowserConnectionState =
  "connecting" | "connected" | "reconnecting" | "offline" | "failed"

const FRAME_HEADER_BYTES = 24

export function decodeRemoteBrowserFrame(buffer: ArrayBuffer): RemoteBrowserFrame {
  if (buffer.byteLength < FRAME_HEADER_BYTES) throw new Error("remote browser frame is truncated")
  const view = new DataView(buffer)
  if (view.getUint8(0) !== 1) throw new Error("unsupported remote browser frame version")
  if (view.getUint8(1) !== 1) throw new Error("unsupported remote browser frame codec")
  const headerBytes = view.getUint16(2)
  const payloadBytes = view.getUint32(20)
  if (headerBytes !== FRAME_HEADER_BYTES || buffer.byteLength !== headerBytes + payloadBytes) {
    throw new Error("invalid remote browser frame length")
  }
  return {
    version: 1,
    codec: "jpeg",
    sequence: view.getUint32(4),
    width: view.getUint16(8),
    height: view.getUint16(10),
    timestamp: Number(view.getBigUint64(12)),
    jpeg: new Uint8Array(buffer, headerBytes, payloadBytes),
  }
}

export function remoteBrowserWebSocketUrl(
  serverBaseUrl: string,
  sessionId: string,
  ticket: string
): string {
  const base = new URL(serverBaseUrl)
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:"
  base.pathname = `/ws/v1/browser/${encodeURIComponent(sessionId)}`
  base.search = new URLSearchParams({ ticket }).toString()
  base.hash = ""
  return base.toString()
}

type BrowserInput =
  | { kind: "mouse"; payload: Record<string, unknown> }
  | { kind: "key"; payload: Record<string, unknown> }

export interface RemoteBrowserStreamOptions {
  sessionId: string
  serverBaseUrl: string
  issueTicket(): Promise<{ ticket: string; expiresAt: number }>
  createSocket?: (url: string) => WebSocket
  onFrame?: (frame: RemoteBrowserFrame) => void
  onLease?: (lease: RemoteBrowserLease | null) => void
  onEvent?: (event: Record<string, unknown>) => void
  onState?: (state: RemoteBrowserConnectionState) => void
  onError?: (code: string) => void
}

/** Ticket-authenticated media/control stream. No account JWT enters the URL. */
export class RemoteBrowserStream {
  private socket: WebSocket | null = null
  private lease: RemoteBrowserLease | null = null
  private readonly createSocket: (url: string) => WebSocket

  constructor(private readonly options: RemoteBrowserStreamOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
  }

  async connect(): Promise<void> {
    this.options.onState?.("connecting")
    const { ticket } = await this.options.issueTicket()
    const socket = this.createSocket(
      remoteBrowserWebSocketUrl(this.options.serverBaseUrl, this.options.sessionId, ticket)
    )
    socket.binaryType = "arraybuffer"
    this.socket = socket
    socket.onopen = () => this.options.onState?.("connected")
    socket.onerror = () => this.options.onState?.("failed")
    socket.onclose = () => {
      if (this.socket === socket) this.options.onState?.("offline")
    }
    socket.onmessage = (event) => this.handleMessage(event.data)
  }

  takeover(): void {
    this.sendEnvelope("control.takeover", {})
  }

  sendInput(input: BrowserInput): boolean {
    if (!this.lease || this.lease.controller.kind !== "human") return false
    this.sendEnvelope("input", { epoch: this.lease.epoch, input })
    return true
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.lease = null
  }

  private handleMessage(data: string | ArrayBuffer | Blob): void {
    if (data instanceof ArrayBuffer) {
      try {
        const frame = decodeRemoteBrowserFrame(data)
        this.options.onFrame?.(frame)
        this.sendEnvelope("frame.ack", { sequence: frame.sequence })
      } catch {
        this.options.onError?.("browser_media_invalid")
      }
      return
    }
    if (typeof data !== "string") {
      void data.arrayBuffer().then((buffer) => this.handleMessage(buffer))
      return
    }
    try {
      const envelope = JSON.parse(data) as {
        version?: number
        type?: string
        payload?: { code?: string; lease?: RemoteBrowserLease }
      }
      if (envelope.version !== 1) return
      if (envelope.type === "result" && envelope.payload?.lease) {
        this.lease = envelope.payload.lease
        this.options.onLease?.(this.lease)
      } else if (envelope.type === "event") {
        this.options.onEvent?.(envelope.payload as Record<string, unknown>)
      } else if (envelope.type === "error") {
        if (envelope.payload?.code === "browser_stale_lease") {
          this.lease = null
          this.options.onLease?.(null)
        }
        this.options.onError?.(envelope.payload?.code ?? "browser_stream_error")
      }
    } catch {
      this.options.onError?.("browser_message_invalid")
    }
  }

  private sendEnvelope(type: string, payload: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify({ version: 1, type, payload }))
  }
}
