/**
 * In-memory stand-in for the signaling relay, implementing `ProbeTransport`.
 *
 * It follows the real protocol closely enough to exercise every phase:
 * challenge on connect, proof verification bound to that challenge, room
 * snapshots, `peerJoined`, fan-out of `relay` frames to subscribed peers only
 * (with `fromRole` / `fromSessionId` / `lane`), `ping` → `pong`, and
 * `unsubscribe` → `peerLeft`. Hooks inject the faults the tests need.
 * Test support only; never bundled.
 */

import {
  ProbeTransportError,
  type HttpProbeResponse,
  type ProbeSocket,
  type ProbeTransport,
} from "../core/types"
import {
  randomBase64Url,
  verifyProof,
  type RoomDescriptor,
  type SubscribeProof,
} from "../../../../signaling-server/worker/tests/synthetic-room.mjs"

type Frame = Record<string, unknown>

export class FakeSocket implements ProbeSocket {
  private readonly inbox: string[] = []
  private readonly waiters: Array<{
    resolve: (text: string) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  private resolveClosed!: () => void
  readonly closed: Promise<void>
  isClosed = false
  closeCalls = 0
  readonly sent: Frame[] = []

  constructor(
    private readonly onClientFrame: (socket: FakeSocket, frame: Frame) => void,
    private readonly closeCompletes = true
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
  }

  /** Server → client. */
  deliver(frame: Frame | string): void {
    if (this.isClosed) return
    const text = typeof frame === "string" ? frame : JSON.stringify(frame)
    const waiter = this.waiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(text)
    } else {
      this.inbox.push(text)
    }
  }

  /** Server-initiated close. */
  serverClose(): void {
    if (this.isClosed) return
    this.isClosed = true
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new ProbeTransportError("ws_closed"))
    }
    this.resolveClosed()
  }

  send(text: string): void {
    if (this.isClosed) throw new ProbeTransportError("ws_closed")
    const frame = JSON.parse(text) as Frame
    this.sent.push(frame)
    queueMicrotask(() => this.onClientFrame(this, frame))
  }

  next(timeoutMs: number): Promise<string> {
    const buffered = this.inbox.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.isClosed) return Promise.reject(new ProbeTransportError("ws_closed"))
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new ProbeTransportError("timeout"))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  close(): void {
    this.closeCalls += 1
    if (!this.closeCompletes) return
    this.serverClose()
  }
}

interface Session {
  socket: FakeSocket
  challenge: string
  role: "desktop" | "mobile" | null
  proof: SubscribeProof | null
  roomId: string
}

export interface FakeRelayOptions {
  health?: () => Promise<HttpProbeResponse>
  /** Origins accepted on upgrade; a non-null Origin outside it gets 403. */
  allowedOrigins?: string[]
  /** Fail the upgrade outright. */
  upgradeError?: () => Error
  /** Never settle `openSocket`, or settle it after a delay. */
  openDelayMs?: number
  hangOpen?: boolean
  /** Answer a subscribe for these roles with `error auth_failed`. */
  rejectRoles?: Array<"desktop" | "mobile">
  /** Never answer subscribe. */
  silentSubscribe?: boolean
  suppressPeerJoined?: boolean
  /** Rewrite (or drop with null) a relayed frame before delivery. */
  onRelay?: (frame: Frame, ctx: { lane: "signal" | "data"; step: string }) => Frame | Frame[] | null
  /** Called for a relay frame before fan-out; return an error frame to send the sender instead. */
  refuseRelay?: (ctx: { lane: "signal" | "data"; step: string }) => Frame | null
  noPong?: boolean
  /** Close the receiving socket instead of delivering this step. */
  closeOnStep?: string
  /** `close()` never completes (the adapter's force-close is not modelled). */
  closeNeverCompletes?: boolean
  /** Snapshot sent to the joining peer omits/changes existing proofs. */
  tamperSnapshot?: boolean
}

export class FakeRelay implements ProbeTransport {
  readonly sockets: FakeSocket[] = []
  readonly origins: Array<string | null> = []
  readonly unsubscribes: string[] = []
  relayPayloadBytes = 0
  private readonly sessions = new Map<FakeSocket, Session>()
  private lateSocket: FakeSocket | null = null

  constructor(private readonly options: FakeRelayOptions = {}) {}

  get lateOpenedSocket(): FakeSocket | null {
    return this.lateSocket
  }

  async getJson(): Promise<HttpProbeResponse> {
    if (this.options.health) return this.options.health()
    return {
      status: 200,
      parseError: false,
      body: {
        backend: "worker",
        capabilities: { lanes: ["signal", "data"], protocol: 2, relayDataLane: true },
        ok: true,
        version: "0.1.0",
      },
    }
  }

  async openSocket(
    url: string,
    opts: { origin: string | null; timeoutMs: number; signal: AbortSignal }
  ): Promise<ProbeSocket> {
    this.origins.push(opts.origin)
    if (this.options.upgradeError) throw this.options.upgradeError()
    const allowed = this.options.allowedOrigins
    if (opts.origin !== null && allowed && !allowed.includes(opts.origin)) {
      throw new ProbeTransportError("ws_upgrade", "upgrade refused", 403)
    }
    const roomId = new URL(url).searchParams.get("rid") ?? ""
    const socket = new FakeSocket(
      (from, frame) => this.handle(from, frame),
      !this.options.closeNeverCompletes
    )
    if (this.options.hangOpen) {
      // Resolve long after the caller's deadline to prove the late socket is closed.
      return new Promise((resolve) =>
        setTimeout(() => {
          this.lateSocket = socket
          resolve(socket)
        }, opts.timeoutMs + 200)
      )
    }
    if (this.options.openDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.openDelayMs))
    }
    const challenge = randomBase64Url(32)
    this.sockets.push(socket)
    this.sessions.set(socket, { socket, challenge, role: null, proof: null, roomId })
    socket.deliver({
      kind: "challenge",
      challenge,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    })
    return socket
  }

  private subscribedOthers(session: Session): Session[] {
    return [...this.sessions.values()].filter(
      (other) =>
        other !== session &&
        other.proof &&
        other.roomId === session.roomId &&
        !other.socket.isClosed
    )
  }

  private handle(socket: FakeSocket, frame: Frame): void {
    // Frames sent before a close are still delivered, as on a real socket.
    const session = this.sessions.get(socket)
    if (!session) return
    switch (frame.kind) {
      case "subscribe":
        void this.subscribe(session, frame)
        return
      case "relay":
        this.relay(session, frame)
        return
      case "ping":
        if (!this.options.noPong) socket.deliver({ kind: "pong" })
        return
      case "unsubscribe":
        this.unsubscribes.push(String(frame.rendezvousId))
        for (const other of this.subscribedOthers(session)) {
          other.socket.deliver({
            kind: "peerLeft",
            rendezvousId: session.roomId,
            role: session.role,
            sessionId: session.proof?.sessionId,
          })
        }
        session.proof = null
        return
      default:
        socket.deliver({ kind: "error", code: "malformed_frame", message: "unknown frame" })
    }
  }

  private async subscribe(session: Session, frame: Frame): Promise<void> {
    if (this.options.silentSubscribe) return
    const descriptor = frame.descriptor as RoomDescriptor
    const proof = frame.proof as SubscribeProof
    const role = proof.role
    const valid =
      descriptor.roomId === session.roomId &&
      proof.challenge === session.challenge &&
      (await verifyProof(descriptor, proof))
    if (!valid || this.options.rejectRoles?.includes(role)) {
      session.socket.deliver({
        kind: "error",
        code: "auth_failed",
        message: "subscription signature verification failed",
      })
      return
    }
    const others = this.subscribedOthers(session)
    session.role = role
    session.proof = proof
    const peers = others.map((other) => ({
      proof: this.options.tamperSnapshot ? { ...other.proof, signature: "tampered" } : other.proof,
      joinedAtMs: Date.now(),
    }))
    session.socket.deliver({ kind: "subscribed", rendezvousId: session.roomId, peers })
    if (!this.options.suppressPeerJoined) {
      for (const other of others) {
        other.socket.deliver({
          kind: "peerJoined",
          rendezvousId: session.roomId,
          peer: { proof, joinedAtMs: Date.now() },
        })
      }
    }
  }

  private relay(session: Session, frame: Frame): void {
    if (!session.proof || !session.role) {
      session.socket.deliver({ kind: "error", code: "not_subscribed", message: "subscribe first" })
      return
    }
    const lane = frame.lane === "data" ? "data" : "signal"
    const payload = String(frame.payload)
    let step = ""
    try {
      step = String((JSON.parse(payload) as { step?: unknown }).step ?? "")
    } catch {
      step = ""
    }
    const refusal = this.options.refuseRelay?.({ lane, step })
    if (refusal) {
      session.socket.deliver(refusal)
      return
    }
    const others = this.subscribedOthers(session)
    this.relayPayloadBytes += new TextEncoder().encode(payload).byteLength * others.length
    for (const other of others) {
      if (this.options.closeOnStep === step) {
        other.socket.serverClose()
        continue
      }
      const out: Frame = {
        kind: "relay",
        rendezvousId: session.roomId,
        fromRole: session.role,
        fromSessionId: session.proof.sessionId,
        payload,
        ...(lane === "data" ? { lane: "data" } : {}),
      }
      const rewritten = this.options.onRelay ? this.options.onRelay(out, { lane, step }) : out
      if (rewritten === null) continue
      for (const item of Array.isArray(rewritten) ? rewritten : [rewritten])
        other.socket.deliver(item)
    }
  }
}
