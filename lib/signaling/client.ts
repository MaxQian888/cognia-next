/**
 * Browser-side signaling v2 client.
 *
 * The rendezvous service authenticates a challenge-bound role proof and only
 * relays ECDSA-signed AES-256-GCM envelopes. SDP and ICE never appear in
 * server-readable fields.
 */

import {
  StrictReplayWindowV2,
  buildSubscribeProofV2,
  buildV2Envelope,
  deriveV2DirectionKey,
  generateV2EcdhKeyPair,
  importV2EcdhPublicKey,
  importV2SigningPublicKey,
  verifyAndDecryptV2Envelope,
  verifyPeerSessionProofV2,
  type RoomDescriptorV2,
  type SignalingEnvelopeV2,
  type SubscribeProofV2,
  type V2KeyPair,
} from "./v2-crypto"
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

const CONNECT_DEADLINE_MS = 8_000
const SUBSCRIBE_DEADLINE_MS = 5_000
const PONG_DEADLINE_MS = 10_000
const HEALTHY_RESET_MS = 60_000
const OUTBOUND_QUEUE_CAPACITY = 64

export type SignalingState =
  "idle" | "connecting" | "subscribed" | "awaiting-peer" | "reconnecting" | "rejected" | "closed"

const TERMINAL_ERROR_CODES = new Set(["auth_failed", "session_replaced"])

export interface SignalingEventMap {
  state: SignalingState
  subscribed: { peers: PeerSnapshot[] }
  envelope: { fromRole: PeerRole; envelope: Envelope }
  peerJoined: PeerRole
  peerLeft: PeerRole
  error: { code: string; message: string }
}

export type SignalingListener<K extends keyof SignalingEventMap> = (
  payload: SignalingEventMap[K]
) => void

export interface SignalingClientOptions {
  url: string
  descriptor: RoomDescriptorV2
  signingPrivateKey: CryptoKey
  role: PeerRole
  webSocketFactory?: (url: string) => WebSocket
  generateEcdhKeyPair?: typeof generateV2EcdhKeyPair
  buildEnvelope?: typeof buildV2Envelope
  scheduler?: {
    setTimeout: typeof globalThis.setTimeout
    clearTimeout: typeof globalThis.clearTimeout
  }
}

interface PeerCrypto {
  proof: SubscribeProofV2
  outboundKey: CryptoKey
  inboundKey: CryptoKey
}

interface OutboundSession {
  socket: WebSocket
  tail: Promise<void>
  pending: number
}

export class SignalingClient {
  private readonly opts: Required<
    Omit<
      SignalingClientOptions,
      "webSocketFactory" | "generateEcdhKeyPair" | "buildEnvelope" | "scheduler"
    >
  > & {
    webSocketFactory: (url: string) => WebSocket
    generateEcdhKeyPair: typeof generateV2EcdhKeyPair
    buildEnvelope: typeof buildV2Envelope
    scheduler: {
      setTimeout: typeof globalThis.setTimeout
      clearTimeout: typeof globalThis.clearTimeout
    }
  }
  private ws: WebSocket | null = null
  private state: SignalingState = "idle"
  private outboundSeq = 1
  private replay = new StrictReplayWindowV2()
  private ephemeral: V2KeyPair | null = null
  private ownProof: SubscribeProofV2 | null = null
  private peerCrypto: PeerCrypto | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null
  private healthyTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private destroyed = false
  private rejected = false
  private outboundSession: OutboundSession | null = null
  private inboundTail: Promise<void> = Promise.resolve()

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
    if (opts.descriptor.v !== 2) {
      throw new Error("signaling: only protocol v2 is supported")
    }
    this.opts = {
      url: opts.url,
      descriptor: opts.descriptor,
      signingPrivateKey: opts.signingPrivateKey,
      role: opts.role,
      webSocketFactory: opts.webSocketFactory ?? ((url) => new WebSocket(url)),
      generateEcdhKeyPair: opts.generateEcdhKeyPair ?? generateV2EcdhKeyPair,
      buildEnvelope: opts.buildEnvelope ?? buildV2Envelope,
      scheduler: opts.scheduler ?? {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      },
    }
  }

  getState(): SignalingState {
    return this.state
  }

  on<K extends keyof SignalingEventMap>(event: K, listener: SignalingListener<K>): () => void {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }

  connect(): void {
    if (this.destroyed || this.state === "connecting" || this.isConnectedState()) return
    this.rejected = false
    this.openSocket()
  }

  async send(kind: EnvelopeKind, body: unknown): Promise<void> {
    const socket = this.ws
    const session = this.outboundSession
    const proof = this.ownProof
    const peer = this.peerCrypto
    if (
      !socket ||
      !session ||
      session.socket !== socket ||
      socket.readyState !== WebSocket.OPEN ||
      !proof ||
      !peer ||
      !this.isConnectedState()
    ) {
      throw new Error("signaling: authenticated peer is not connected")
    }
    if (session.pending >= OUTBOUND_QUEUE_CAPACITY) {
      this.failSocket("outbound_queue_overflow")
      throw new Error("signaling: outbound signaling queue is full")
    }
    session.pending++
    const seq = this.outboundSeq++
    const operation = session.tail.then(async () => {
      if (this.destroyed || this.ws !== socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("signaling: connection changed before send")
      }
      const envelope = await this.opts.buildEnvelope({
        roomId: this.opts.descriptor.roomId,
        senderRole: this.opts.role,
        sessionId: proof.sessionId,
        epoch: proof.epoch,
        seq,
        kind,
        body,
        signingPrivateKey: this.opts.signingPrivateKey,
        encryptionKey: peer.outboundKey,
      })
      if (this.destroyed || this.ws !== socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("signaling: connection changed before send")
      }
      const frame: ClientFrame = {
        kind: "relay",
        rendezvousId: this.opts.descriptor.roomId,
        payload: JSON.stringify(envelope),
      }
      socket.send(JSON.stringify(frame))
    })
    const tracked = operation.finally(() => {
      session.pending--
    })
    session.tail = tracked.catch(() => undefined)
    return tracked
  }

  close(): void {
    this.destroyed = true
    this.clearTimers()
    this.closeSocket()
    this.setState("closed")
  }

  private isConnectedState(): boolean {
    return this.state === "subscribed" || this.state === "awaiting-peer"
  }

  private connectUrl(): string {
    const separator = this.opts.url.includes("?") ? "&" : "?"
    return `${this.opts.url}${separator}rid=${encodeURIComponent(this.opts.descriptor.roomId)}`
  }

  private openSocket(): void {
    if (this.destroyed) return
    this.resetSessionCrypto()
    this.inboundTail = Promise.resolve()
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting")
    const socket = this.opts.webSocketFactory(this.connectUrl())
    this.ws = socket
    this.outboundSession = { socket, tail: Promise.resolve(), pending: 0 }
    this.armDeadline(CONNECT_DEADLINE_MS, "connect_timeout")

    socket.onopen = () => {
      if (this.ws !== socket) return
      this.armDeadline(SUBSCRIBE_DEADLINE_MS, "challenge_timeout")
    }
    socket.onmessage = (event: MessageEvent) => {
      if (this.ws !== socket) return
      const text = String(event.data)
      this.inboundTail = this.inboundTail
        .then(async () => {
          if (this.ws === socket) await this.handleRaw(text)
        })
        .catch((error) => {
          this.emit("error", {
            code: "frame_processing",
            message: error instanceof Error ? error.message : String(error),
          })
        })
    }
    socket.onerror = () => {
      // onclose owns recovery.
    }
    socket.onclose = () => {
      if (this.ws !== socket) return
      this.ws = null
      if (this.outboundSession?.socket === socket) this.outboundSession = null
      this.clearConnectionTimers()
      this.resetSessionCrypto()
      if (!this.destroyed && !this.rejected) this.scheduleReconnect()
    }
  }

  private async handleRaw(text: string): Promise<void> {
    let frame: ServerFrame
    try {
      frame = JSON.parse(text) as ServerFrame
    } catch {
      this.emit("error", { code: "malformed_frame", message: "server frame is not JSON" })
      return
    }
    switch (frame.kind) {
      case "challenge":
        await this.handleChallenge(frame)
        break
      case "subscribed":
        await this.handleSubscribed(frame.peers ?? [])
        break
      case "peerJoined":
        await this.acceptPeer(frame.peer)
        this.emit("peerJoined", frame.peer.proof.role)
        break
      case "peerLeft":
        if (this.peerCrypto?.proof.sessionId === frame.sessionId) {
          this.peerCrypto = null
          this.replay = new StrictReplayWindowV2()
          this.setState("awaiting-peer")
          this.emit("peerLeft", frame.role)
        }
        break
      case "relay":
        await this.handleRelay(frame)
        break
      case "pong":
        this.clearPongDeadline()
        break
      case "error":
        this.emit("error", { code: frame.code, message: frame.message })
        if (TERMINAL_ERROR_CODES.has(frame.code)) this.reject()
        break
    }
  }

  private async handleChallenge(frame: Extract<ServerFrame, { kind: "challenge" }>): Promise<void> {
    const socket = this.ws
    if (!socket || socket.readyState !== WebSocket.OPEN || Date.now() > frame.expiresAt) {
      this.failSocket("challenge_expired")
      return
    }
    try {
      const ephemeral = await this.opts.generateEcdhKeyPair()
      if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return
      const proof = await buildSubscribeProofV2({
        roomId: this.opts.descriptor.roomId,
        role: this.opts.role,
        sessionId: cryptoRandomBase64Url(16),
        epoch: cryptoRandomBase64Url(16),
        challenge: frame.challenge,
        ecdhPublicKey: ephemeral.encodedPublicKey,
        signingPrivateKey: this.opts.signingPrivateKey,
      })
      if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return
      this.ephemeral = ephemeral
      this.ownProof = proof
      const subscribe: ClientFrame = {
        kind: "subscribe",
        descriptor: this.opts.descriptor,
        proof,
      }
      socket.send(JSON.stringify(subscribe))
      this.armDeadline(SUBSCRIBE_DEADLINE_MS, "subscribe_timeout")
    } catch (error) {
      this.emit("error", {
        code: "subscribe_crypto",
        message: error instanceof Error ? error.message : String(error),
      })
      this.failSocket("subscribe_crypto")
    }
  }

  private async handleSubscribed(peers: PeerSnapshot[]): Promise<void> {
    this.clearDeadline()
    this.startPing()
    this.armHealthyReset()
    const opposite = peers.find((peer) => peer.proof.role !== this.opts.role)
    if (opposite) await this.acceptPeer(opposite)
    this.setState(this.peerCrypto ? "subscribed" : "awaiting-peer")
    this.emit("subscribed", { peers })
  }

  private async acceptPeer(peer: PeerSnapshot): Promise<void> {
    if (peer.proof.role === this.opts.role) {
      this.emit("error", {
        code: "peer_role",
        message: "relay returned a peer with our own role",
      })
      return
    }
    const ephemeral = this.ephemeral
    const ownProof = this.ownProof
    if (!ephemeral || !ownProof) return
    try {
      await verifyPeerSessionProofV2(this.opts.descriptor, peer.proof)
      const peerPublicKey = await importV2EcdhPublicKey(peer.proof.ecdhPublicKey)
      const [outboundKey, inboundKey] = await Promise.all([
        deriveV2DirectionKey({
          privateKey: ephemeral.privateKey,
          peerPublicKey,
          roomId: this.opts.descriptor.roomId,
          senderRole: this.opts.role,
          epoch: ownProof.epoch,
        }),
        deriveV2DirectionKey({
          privateKey: ephemeral.privateKey,
          peerPublicKey,
          roomId: this.opts.descriptor.roomId,
          senderRole: peer.proof.role,
          epoch: peer.proof.epoch,
        }),
      ])
      this.peerCrypto = { proof: peer.proof, outboundKey, inboundKey }
      this.replay = new StrictReplayWindowV2()
      this.setState("subscribed")
    } catch (error) {
      this.emit("error", {
        code: "peer_auth_failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleRelay(frame: Extract<ServerFrame, { kind: "relay" }>): Promise<void> {
    const peer = this.peerCrypto
    if (
      !peer ||
      frame.fromRole !== peer.proof.role ||
      frame.fromSessionId !== peer.proof.sessionId
    ) {
      this.emit("error", { code: "relay_session", message: "relay sender session mismatch" })
      return
    }
    let raw: SignalingEnvelopeV2
    try {
      raw = JSON.parse(frame.payload) as SignalingEnvelopeV2
    } catch {
      this.emit("error", { code: "relay_parse", message: "relay payload is not JSON" })
      return
    }
    if (raw.sessionId !== peer.proof.sessionId || raw.epoch !== peer.proof.epoch) {
      this.emit("error", { code: "relay_session", message: "relay epoch mismatch" })
      return
    }
    try {
      const decrypted = await verifyAndDecryptV2Envelope(raw, {
        expectedRoomId: this.opts.descriptor.roomId,
        expectedSenderRole: peer.proof.role,
        signingPublicKey: await this.peerSigningPublicKey(peer.proof.role),
        encryptionKey: peer.inboundKey,
      })
      if (!this.replay.observe(raw.epoch, raw.seq)) {
        this.emit("error", {
          code: "replayed",
          message: "duplicate or retired signaling epoch",
        })
        return
      }
      this.emit("envelope", {
        fromRole: peer.proof.role,
        envelope: {
          ver: 2,
          roomId: raw.roomId,
          senderRole: raw.senderRole,
          sessionId: raw.sessionId,
          epoch: raw.epoch,
          seq: raw.seq,
          issuedAt: raw.issuedAt,
          kind: decrypted.kind,
          body: decrypted.body,
        },
      })
    } catch (error) {
      this.emit("error", {
        code: "relay_auth_failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async peerSigningPublicKey(role: PeerRole): Promise<CryptoKey> {
    return importV2SigningPublicKey(
      role === "desktop"
        ? this.opts.descriptor.desktopSigningKey
        : this.opts.descriptor.mobileSigningKey
    )
  }

  private reject(): void {
    this.rejected = true
    this.clearTimers()
    this.closeSocket()
    this.setState("rejected")
  }

  private failSocket(code: string): void {
    this.emit("error", { code, message: code })
    const socket = this.ws
    if (!socket) {
      this.scheduleReconnect()
      return
    }
    try {
      socket.close()
    } catch {
      if (this.ws === socket) this.ws = null
      this.scheduleReconnect()
    }
  }

  private closeSocket(): void {
    const socket = this.ws
    this.ws = null
    if (this.outboundSession?.socket === socket) this.outboundSession = null
    if (socket) {
      try {
        socket.close()
      } catch {
        // Closing is best effort.
      }
    }
  }

  private resetSessionCrypto(): void {
    this.ephemeral = null
    this.ownProof = null
    this.peerCrypto = null
    this.outboundSeq = 1
    this.replay = new StrictReplayWindowV2()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed || this.rejected) return
    const index = Math.min(this.reconnectAttempt, SIGNALING_BACKOFF_MS.length - 1)
    const base = SIGNALING_BACKOFF_MS[index]
    const delay = Math.floor(Math.random() * base)
    this.reconnectAttempt++
    this.setState("reconnecting")
    this.reconnectTimer = this.opts.scheduler.setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  private startPing(): void {
    this.cancelPing()
    const ping = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      this.ws.send(JSON.stringify({ kind: "ping" } satisfies ClientFrame))
      this.clearPongDeadline()
      this.pongTimer = this.opts.scheduler.setTimeout(() => {
        this.pongTimer = null
        this.failSocket("pong_timeout")
      }, PONG_DEADLINE_MS)
      this.pingTimer = this.opts.scheduler.setTimeout(ping, SIGNALING_PING_INTERVAL_MS)
    }
    this.pingTimer = this.opts.scheduler.setTimeout(ping, SIGNALING_PING_INTERVAL_MS)
  }

  private armHealthyReset(): void {
    if (this.healthyTimer) this.opts.scheduler.clearTimeout(this.healthyTimer)
    this.healthyTimer = this.opts.scheduler.setTimeout(() => {
      this.healthyTimer = null
      this.reconnectAttempt = 0
    }, HEALTHY_RESET_MS)
  }

  private armDeadline(delay: number, code: string): void {
    this.clearDeadline()
    this.deadlineTimer = this.opts.scheduler.setTimeout(() => {
      this.deadlineTimer = null
      this.failSocket(code)
    }, delay)
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) {
      this.opts.scheduler.clearTimeout(this.deadlineTimer)
      this.deadlineTimer = null
    }
  }

  private clearPongDeadline(): void {
    if (this.pongTimer) {
      this.opts.scheduler.clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private cancelPing(): void {
    if (this.pingTimer) {
      this.opts.scheduler.clearTimeout(this.pingTimer)
      this.pingTimer = null
    }
    this.clearPongDeadline()
  }

  private clearConnectionTimers(): void {
    this.cancelPing()
    this.clearDeadline()
    if (this.healthyTimer) {
      this.opts.scheduler.clearTimeout(this.healthyTimer)
      this.healthyTimer = null
    }
  }

  private clearTimers(): void {
    this.clearConnectionTimers()
    if (this.reconnectTimer) {
      this.opts.scheduler.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setState(next: SignalingState): void {
    if (this.state === next) return
    this.state = next
    this.emit("state", next)
  }

  private emit<K extends keyof SignalingEventMap>(event: K, payload: SignalingEventMap[K]): void {
    for (const listener of this.listeners[event]) {
      try {
        listener(payload)
      } catch (error) {
        console.warn(`signaling: listener for ${event} threw`, error)
      }
    }
  }
}

function cryptoRandomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}
