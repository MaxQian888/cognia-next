/**
 * Browser-side signaling rendezvous client. ADR-0021.
 *
 * Maintains a long-lived WSS connection to the public signaling server,
 * subscribes to a single rendezvous room, and forwards application-level
 * `Envelope`s to the desktop peer (or receives them from the desktop).
 *
 * Authentication is **end-to-end**, not channel-level: the signaling
 * server only sees opaque base64. Every outbound envelope is HMAC-signed
 * with the `rendezvousSecret` from {@link CompanionConfig}; every inbound
 * envelope is HMAC-verified and run through a {@link ReplayWindow} before
 * being surfaced to the consumer.
 *
 * Lifecycle:
 *   ┌── new SignalingClient(...) ──► connect() ──► subscribed(role) ──┐
 *   │            ▲                                  │                  │
 *   │            └──── full-jitter exp backoff ─────┤                  │
 *   │                                               ▼                  │
 *   │                                          relay loop              │
 *   │                                               │                  │
 *   └─── close() ──────────────────────────────── disconnected ◄───────┘
 */

import { ReplayWindow, buildSignedEnvelope, verifySignedEnvelope } from "./envelope"
import {
  SIGNALING_BACKOFF_MS,
  SIGNALING_PING_INTERVAL_MS,
  type ClientFrame,
  type Envelope,
  type EnvelopeKind,
  type PeerRole,
  type PeerSnapshot,
  type ServerFrame,
} from "./types"

export type SignalingState =
  "idle" | "connecting" | "subscribed" | "reconnecting" | "rejected" | "closed"

/**
 * Server error codes that are terminal for this connection: the room rejected
 * the subscription (full, or a desktop already owns it). The server keeps the
 * socket open, so the client must stop itself — reconnecting would just be
 * rejected again in a tight loop.
 */
const TERMINAL_ERROR_CODES = new Set(["room_full", "role_taken"])

export interface SignalingEventMap {
  state: SignalingState
  /**
   * Fired on every `Subscribed` server frame, carrying the peers that were
   * ALREADY in the room at subscribe time. Distinct from the `state` event so
   * consumers can learn whether the opposite peer is present without racing a
   * separate `peerJoined` — the room may already hold it (ADR-0021 F1). On a
   * mid-session WSS reconnect this fires again with the current occupancy.
   */
  subscribed: { peers: PeerSnapshot[] }
  envelope: {
    fromRole: PeerRole
    envelope: Envelope
  }
  peerJoined: PeerRole
  peerLeft: PeerRole
  error: { code: string; message: string }
}

export type SignalingListener<K extends keyof SignalingEventMap> = (
  payload: SignalingEventMap[K]
) => void

export interface SignalingClientOptions {
  /** wss:// URL of the rendezvous server's signaling endpoint. */
  url: string
  /** Public room id minted at pair time. */
  rendezvousId: string
  /** 32-byte HMAC key (URL-safe base64, unpadded) shared with the peer. */
  rendezvousSecret: string
  /** Our own role in the room. */
  role: PeerRole
  /** Optional WebSocket factory — tests inject a mock. */
  webSocketFactory?: (url: string) => WebSocket
  /** Optional setTimeout shim — tests use fake timers. */
  scheduler?: {
    setTimeout: typeof globalThis.setTimeout
    clearTimeout: typeof globalThis.clearTimeout
  }
}

/**
 * One signaling round-trip — both sides keep an independent monotonic
 * `seq` counter so a peer's signature can be tied to the order it sent
 * envelopes in.
 */
export class SignalingClient {
  private readonly opts: Required<
    Omit<SignalingClientOptions, "webSocketFactory" | "scheduler">
  > & {
    webSocketFactory: (url: string) => WebSocket
    scheduler: {
      setTimeout: typeof globalThis.setTimeout
      clearTimeout: typeof globalThis.clearTimeout
    }
  }
  private ws: WebSocket | null = null
  private state: SignalingState = "idle"
  private outboundSeq = 1
  private readonly replay = new ReplayWindow()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private destroyed = false
  private rejected = false

  private readonly listeners: {
    [K in keyof SignalingEventMap]: Set<SignalingListener<K>>
  } = {
    state: new Set(),
    subscribed: new Set(),
    envelope: new Set(),
    peerJoined: new Set(),
    peerLeft: new Set(),
    error: new Set(),
  }

  constructor(opts: SignalingClientOptions) {
    this.opts = {
      url: opts.url,
      rendezvousId: opts.rendezvousId,
      rendezvousSecret: opts.rendezvousSecret,
      role: opts.role,
      webSocketFactory: opts.webSocketFactory ?? ((u) => new WebSocket(u)),
      scheduler: opts.scheduler ?? {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
    }
  }

  // ── public surface ─────────────────────────────────────────────────────

  getState(): SignalingState {
    return this.state
  }

  on<K extends keyof SignalingEventMap>(event: K, listener: SignalingListener<K>): () => void {
    this.listeners[event].add(listener)
    return () => {
      this.listeners[event].delete(listener)
    }
  }

  connect(): void {
    if (this.destroyed) return
    if (this.state === "connecting" || this.state === "subscribed") return
    // An explicit connect() after a terminal rejection is an intentional
    // retry — clear the flag so the socket can reopen.
    this.rejected = false
    this.openSocket()
  }

  /** Send a fresh-seq envelope of the given kind. Resolves once enqueued. */
  async send(kind: EnvelopeKind, body: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("signaling: not connected")
    }
    const seq = this.outboundSeq++
    const envelope = await buildSignedEnvelope({
      seq,
      kind,
      body,
      rendezvousSecret: this.opts.rendezvousSecret,
    })
    const payload = b64UrlEncodeString(JSON.stringify(envelope))
    const frame: ClientFrame = {
      kind: "relay",
      rendezvousId: this.opts.rendezvousId,
      payload,
    }
    this.ws.send(JSON.stringify(frame))
  }

  close(): void {
    this.destroyed = true
    this.cancelReconnect()
    this.cancelPing()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignored
      }
      this.ws = null
    }
    this.setState("closed")
  }

  // ── socket lifecycle ───────────────────────────────────────────────────

  /**
   * Connect URL with the room id appended as `?rid=`. The Cloudflare Worker
   * deployment needs the room before the WebSocket is accepted (it routes the
   * upgrade to a per-room Durable Object via `idFromName(rid)`), so the id can
   * no longer wait for the first `Subscribe` frame. The axum server ignores
   * the query param, so the same client works against either backend.
   */
  private connectUrl(): string {
    const sep = this.opts.url.includes("?") ? "&" : "?"
    return `${this.opts.url}${sep}rid=${encodeURIComponent(this.opts.rendezvousId)}`
  }

  private openSocket(): void {
    if (this.destroyed) return
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting")
    const ws = this.opts.webSocketFactory(this.connectUrl())
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      // Subscribe immediately. Server replies with `subscribed`.
      const subscribe: ClientFrame = {
        kind: "subscribe",
        rendezvousId: this.opts.rendezvousId,
        role: this.opts.role,
        clientNonce: cryptoRandomBase64Url(16),
      }
      ws.send(JSON.stringify(subscribe))
      this.startPing()
    }
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return
      void this.handleRaw(String(event.data))
    }
    ws.onerror = () => {
      // Recorded; let onclose drive reconnect.
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.cancelPing()
      if (!this.destroyed) this.scheduleReconnect()
    }
  }

  private async handleRaw(text: string): Promise<void> {
    let frame: ServerFrame
    try {
      frame = JSON.parse(text) as ServerFrame
    } catch {
      return
    }
    switch (frame.kind) {
      case "subscribed":
        this.reconnectAttempt = 0
        this.setState("subscribed")
        // Surface the room occupancy AFTER the state flip so a consumer that
        // reacts to `subscribed` (peers) sees a client already in the
        // `subscribed` state. `peers ?? []` guards against an older server
        // build that omits the field.
        this.emit("subscribed", { peers: frame.peers ?? [] })
        break
      case "peerJoined":
        this.emit("peerJoined", frame.role)
        break
      case "peerLeft":
        this.emit("peerLeft", frame.role)
        break
      case "relay": {
        await this.handleRelay(frame.fromRole, frame.payload)
        break
      }
      case "pong":
        break
      case "error":
        this.emit("error", { code: frame.code, message: frame.message })
        if (TERMINAL_ERROR_CODES.has(frame.code)) this.reject()
        break
    }
  }

  /**
   * Enter the terminal `rejected` state: stop pinging, close the socket, and
   * suppress auto-reconnect. Unlike {@link close} this leaves `destroyed`
   * false, so a later explicit {@link connect} can retry.
   */
  private reject(): void {
    this.rejected = true
    this.cancelReconnect()
    this.cancelPing()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignored
      }
      this.ws = null
    }
    this.setState("rejected")
  }

  private async handleRelay(fromRole: PeerRole, payloadB64: string): Promise<void> {
    let envelope: unknown
    try {
      envelope = JSON.parse(b64UrlDecodeToString(payloadB64))
    } catch {
      this.emit("error", { code: "relay_parse", message: "payload not JSON" })
      return
    }
    const verify = await verifySignedEnvelope(envelope, {
      rendezvousSecret: this.opts.rendezvousSecret,
    })
    if (!verify.ok) {
      this.emit("error", { code: `relay_${verify.reason}`, message: verify.reason })
      return
    }
    if (!this.replay.observe(fromRole, verify.envelope.seq, verify.envelope.nonce)) {
      this.emit("error", { code: "replayed", message: "duplicate seq/nonce" })
      return
    }
    this.emit("envelope", { fromRole, envelope: verify.envelope })
  }

  // ── reconnect & keepalive ──────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed || this.rejected) return
    const idx = Math.min(this.reconnectAttempt, SIGNALING_BACKOFF_MS.length - 1)
    const base = SIGNALING_BACKOFF_MS[idx]
    const jitter = Math.floor(Math.random() * base)
    const delay = jitter // full-jitter exponential: [0, base)
    this.reconnectAttempt++
    this.setState("reconnecting")
    this.reconnectTimer = this.opts.scheduler.setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      this.opts.scheduler.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private startPing(): void {
    this.cancelPing()
    const send = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      const ping: ClientFrame = { kind: "ping" }
      this.ws.send(JSON.stringify(ping))
      this.pingTimer = this.opts.scheduler.setTimeout(send, SIGNALING_PING_INTERVAL_MS)
    }
    this.pingTimer = this.opts.scheduler.setTimeout(send, SIGNALING_PING_INTERVAL_MS)
  }

  private cancelPing(): void {
    if (this.pingTimer) {
      this.opts.scheduler.clearTimeout(this.pingTimer)
      this.pingTimer = null
    }
  }

  // ── event emitter helpers ──────────────────────────────────────────────

  private setState(next: SignalingState): void {
    if (this.state === next) return
    this.state = next
    this.emit("state", next)
  }

  private emit<K extends keyof SignalingEventMap>(event: K, payload: SignalingEventMap[K]): void {
    for (const l of this.listeners[event]) {
      try {
        l(payload)
      } catch (err) {
        console.warn(`signaling: listener for ${event} threw`, err)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Local base64url helpers
// ---------------------------------------------------------------------------

function b64UrlEncodeString(input: string): string {
  // btoa handles only Latin-1; UTF-8 strings are pre-encoded for safety.
  const utf8 = new TextEncoder().encode(input)
  let bin = ""
  for (const b of utf8) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function b64UrlDecodeToString(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4)
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function cryptoRandomBase64Url(byteLen: number): string {
  const buf = new Uint8Array(byteLen)
  globalThis.crypto.getRandomValues(buf)
  let bin = ""
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}
