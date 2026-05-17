"use client"

/**
 * WebRTC DataChannel transport tier. ADR-0021.
 *
 * Wraps an `RTCPeerConnection` with the matching `SignalingClient` and
 * exposes a request/response surface mirroring `Transport.call` + a
 * subscription surface mirroring `Transport.subscribe`. The
 * `CompanionTransport` delegates to this class **after** the existing
 * HTTPS+WS path has been ruled out as the preferred candidate (e.g. on
 * WAN where mDNS LAN is unreachable).
 *
 * Both peers exchange `{ id, method, params }` envelopes over a single
 * ordered/reliable DataChannel named `cognia.v1`. Responses come back as
 * `{ id, ok, result | error }`. Events flow as `{ event, payload, seq }`
 * with the same EventBus `seq` semantics as the existing
 * `/ws/v1/events` channel.
 *
 * Authentication: HMAC-signed via the rendezvous secret minted at pair
 * time (see `lib/signaling/envelope.ts`). After the DTLS handshake binds
 * the data channel to the SDP fingerprint exchanged over signaling, no
 * additional JWT is replayed on the data channel itself.
 */

import {
  DATACHANNEL_LABEL,
  SignalingClient,
  type Envelope,
  type PeerRole,
  type RtcAnswerBody,
  type RtcIceBody,
  type RtcOfferBody,
} from "@/lib/signaling"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RtcState =
  | "idle"
  | "signaling-connecting"
  | "negotiating"
  | "open"
  | "reconnecting"
  | "closing"
  | "failed"
  | "closed"

/**
 * Outer negotiation-level reconnect schedule. Triggered when the DataChannel
 * (or its enclosing peer/ICE) drops *after* it had already opened — i.e. a
 * mid-session disconnect. The inner `SignalingClient` runs its own WSS-level
 * reconnect; this schedule applies to the SDP/ICE handshake on top of it.
 *
 * Mirrors `signaling-server/src/...` / `src-tauri/.../signaling/client.rs:46`
 * so the desktop and mobile retry at compatible cadences.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000,
]

/**
 * Minimum spacing between two manual `reconnectNow()` invocations from
 * the same `TransportRtc` instance. Defends against an XSS in the mobile
 * webview spamming the public surface in a tight loop — each manual
 * reconnect tears down + reopens the peer connection, which is cheap on
 * paper but burns mobile battery, signaling-server quota, and the home
 * desktop's `webrtc-rs` resources at scale. Mirrors the desktop's
 * `RECONNECT_DEVICE_MIN_SPACING` in
 * `src-tauri/src/companion_api/signaling/mod.rs`.
 */
export const RECONNECT_NOW_MIN_SPACING_MS = 5_000

export interface RtcMessage {
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface RtcResponseOk {
  id: string
  ok: true
  result: unknown
}
export interface RtcResponseErr {
  id: string
  ok: false
  error: { code: string; message: string }
}
export type RtcResponse = RtcResponseOk | RtcResponseErr

export interface RtcEvent {
  /** Always `"event"`. Discriminates the envelope from a response. */
  kind: "event"
  /** Channel name, e.g. `"claude://session-event"`. */
  event: string
  seq: number
  payload: unknown
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TransportRtcOptions {
  /** Public signaling endpoint URL (`wss://signaling.cognia.app/v1/signaling`). */
  signalingUrl: string
  /** Rendezvous id minted at pair time, baked into CompanionConfig. */
  rendezvousId: string
  /** 32-byte HMAC secret (URL-safe base64, unpadded). */
  rendezvousSecret: string
  /** Stable device identifier — sent in the `hello` envelope. */
  deviceId: string
  /** Optional override of the local peer role. Defaults to `"mobile"`. */
  role?: PeerRole
  /**
   * `RTCConfiguration` passed to the peer connection. Caller composes from
   * `AppSettings.iceServers` and `AppSettings.turnServers`.
   */
  rtcConfiguration?: RTCConfiguration
  /**
   * Hard timeout for the SDP exchange + ICE gathering, in ms. If the
   * DataChannel hasn't opened by then we tear down and surface `failed`
   * so the caller can fall through to the cloudflared tunnel tier.
   * Default 8000.
   */
  negotiationTimeoutMs?: number
  /**
   * Override for the reconnection backoff schedule (ms). Tests pass a
   * short schedule (e.g. `[5, 10]`) to exercise exhaustion without
   * sleeping. Production should leave this unset — the default mirrors
   * the Rust desktop-side schedule.
   */
  reconnectBackoffMs?: readonly number[]
  /**
   * Optional override for the global `RTCPeerConnection` constructor.
   * Tests inject a polyfill / mock.
   */
  peerConnectionFactory?: (config: RTCConfiguration | undefined) => RTCPeerConnection
  /** Optional override of the SignalingClient factory (for tests). */
  signalingClientFactory?: (
    opts: ConstructorParameters<typeof SignalingClient>[0]
  ) => SignalingClient
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

type EventHandler = (payload: unknown) => void

const RPC_TIMEOUT_MS = 30_000

export class TransportRtc {
  private readonly opts: Required<
    Omit<
      TransportRtcOptions,
      "rtcConfiguration" | "peerConnectionFactory" | "signalingClientFactory" | "reconnectBackoffMs"
    >
  > &
    Pick<TransportRtcOptions, "rtcConfiguration"> & {
      peerConnectionFactory: NonNullable<TransportRtcOptions["peerConnectionFactory"]>
      signalingClientFactory: NonNullable<TransportRtcOptions["signalingClientFactory"]>
      reconnectBackoffMs: readonly number[]
    }

  private signaling: SignalingClient | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private state: RtcState = "idle"
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null
  private negotiationSettled = false
  private nextRpcId = 1
  private pending: Map<string, Pending> = new Map()
  private channels: Map<string, Set<EventHandler>> = new Map()
  private highestSeq: Map<string, number> = new Map()
  private stateListeners: Set<(s: RtcState) => void> = new Set()
  /** Index into [`RECONNECT_BACKOFF_MS`] for the next scheduled retry. */
  private reconnectAttempt = 0
  /** Pending timer for the next reconnect attempt; null when none scheduled. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Wall-clock timestamp (ms) of the most recent `reconnectNow()` call.
   * Used by the throttle in `reconnectNow()` so XSS-driven floods are
   * rejected. Initialised to `0` so the first manual reconnect always
   * fires.
   */
  private lastManualReconnectMs = 0

  constructor(opts: TransportRtcOptions) {
    this.opts = {
      signalingUrl: opts.signalingUrl,
      rendezvousId: opts.rendezvousId,
      rendezvousSecret: opts.rendezvousSecret,
      deviceId: opts.deviceId,
      role: opts.role ?? "mobile",
      rtcConfiguration: opts.rtcConfiguration,
      negotiationTimeoutMs: opts.negotiationTimeoutMs ?? 8000,
      reconnectBackoffMs: opts.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS,
      peerConnectionFactory:
        opts.peerConnectionFactory ??
        ((config) => new RTCPeerConnection(config as RTCConfiguration | undefined)),
      signalingClientFactory: opts.signalingClientFactory ?? ((o) => new SignalingClient(o)),
    }
  }

  // ── Public surface ─────────────────────────────────────────────────────

  getState(): RtcState {
    return this.state
  }

  onStateChange(handler: (state: RtcState) => void): () => void {
    this.stateListeners.add(handler)
    return () => {
      this.stateListeners.delete(handler)
    }
  }

  /**
   * Connect to the signaling rendezvous, negotiate SDP/ICE, and resolve once
   * the DataChannel is open. Rejects on timeout or peer-connection failure.
   */
  async connect(): Promise<void> {
    if (this.state === "open") return
    if (
      this.state !== "idle" &&
      this.state !== "closed" &&
      this.state !== "failed" &&
      this.state !== "reconnecting"
    ) {
      throw new Error(`TransportRtc.connect: already in state ${this.state}`)
    }
    // Entry from reconnect timer leaves resources cleared by
    // `teardownPeer()`; from idle/closed/failed they're already null.
    this.negotiationSettled = false
    this.setState("signaling-connecting")

    const signaling = this.opts.signalingClientFactory({
      url: this.opts.signalingUrl,
      rendezvousId: this.opts.rendezvousId,
      rendezvousSecret: this.opts.rendezvousSecret,
      role: this.opts.role,
    })
    this.signaling = signaling

    const opened = new Promise<void>((resolve, reject) => {
      const detachState = signaling.on("state", async (next) => {
        if (next === "subscribed" && !this.pc) {
          try {
            await this.startNegotiation()
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        }
      })

      const detachEnv = signaling.on("envelope", async ({ envelope }) => {
        try {
          await this.handleSignalingEnvelope(envelope)
        } catch (err) {
          console.warn("TransportRtc: signaling envelope handler threw", err)
        }
      })

      const detachErr = signaling.on("error", ({ code, message }) => {
        // Signaling-side errors (rate_limited / bad MAC / replay) are
        // non-fatal to the in-flight negotiation; we surface them but only
        // give up when the negotiation timer fires.
        console.warn(`TransportRtc: signaling error ${code}: ${message}`)
      })

      this.negotiationTimer = setTimeout(() => {
        if (this.negotiationSettled) return
        this.negotiationSettled = true
        detachState()
        detachEnv()
        detachErr()
        this.fail(new Error("WebRTC negotiation timed out"))
        reject(new Error("WebRTC negotiation timed out"))
      }, this.opts.negotiationTimeoutMs)

      // Bridge: when the DataChannel opens, we resolve the connect promise.
      this.onDcOpenResolvers.push(() => {
        if (this.negotiationSettled) return
        this.negotiationSettled = true
        if (this.negotiationTimer) {
          clearTimeout(this.negotiationTimer)
          this.negotiationTimer = null
        }
        detachState()
        detachEnv()
        detachErr()
        resolve()
      })
      this.onDcFailResolvers.push((err) => {
        if (this.negotiationSettled) return
        this.negotiationSettled = true
        if (this.negotiationTimer) {
          clearTimeout(this.negotiationTimer)
          this.negotiationTimer = null
        }
        detachState()
        detachEnv()
        detachErr()
        reject(err)
      })
    })

    signaling.connect()
    return opened
  }

  /**
   * Force a fresh handshake immediately, regardless of current state. Wired
   * to the "Reconnect WebRTC" button on the mobile settings panel and the
   * desktop WebRTC card.
   *
   * - From `open`: tears down the current peer/data channel and starts a
   *   new negotiation (treated as a mid-session disconnect with a zero-
   *   length backoff because the user explicitly asked).
   * - From `reconnecting`: cancels the pending backoff timer and tries
   *   immediately; resets the attempt counter so subsequent automatic
   *   retries start at the smallest delay again.
   * - From `idle` / `closed` / `failed`: equivalent to calling `connect()`.
   * - From `signaling-connecting` / `negotiating` / `closing`: no-op; an
   *   action is already in flight.
   */
  reconnectNow(): boolean {
    // Throttle: defend against XSS or runaway UI loops calling this in a
    // tight cycle. Genuine user double-taps land within ~300 ms so the
    // 5 s window doesn't block them on the first click; subsequent
    // accidental clicks are silently dropped.
    const now = Date.now()
    if (now - this.lastManualReconnectMs < RECONNECT_NOW_MIN_SPACING_MS) {
      return false
    }
    this.lastManualReconnectMs = now

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0

    if (this.state === "open") {
      this.teardownPeer()
      this.setState("reconnecting")
      // Fall through to the connect() below.
    } else if (
      this.state === "signaling-connecting" ||
      this.state === "negotiating" ||
      this.state === "closing"
    ) {
      return true
    }

    void this.connect().catch((err) => {
      // Surface via state transitions; nothing else to do here.
      console.warn("TransportRtc.reconnectNow: connect rejected", err)
    })
    return true
  }

  /** Send an RPC; resolves with the result payload. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.state !== "open" || !this.dc || this.dc.readyState !== "open") {
      return Promise.reject(new Error("TransportRtc: DataChannel is not open"))
    }
    const id = `rpc-${this.nextRpcId++}`
    const message: RtcMessage = { id, method, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`TransportRtc: RPC '${method}' timed out`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.dc!.send(JSON.stringify(message))
    })
  }

  /** Subscribe to an event channel sent over the data channel. */
  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    if (!this.channels.has(event)) {
      this.channels.set(event, new Set())
    }
    this.channels.get(event)!.add(handler as EventHandler)
    return () => {
      const set = this.channels.get(event)
      if (!set) return
      set.delete(handler as EventHandler)
      if (set.size === 0) this.channels.delete(event)
    }
  }

  /** Highest seq observed on each subscribed channel — used during reconnect. */
  getSeqCursor(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, seq] of this.highestSeq) out[name] = seq
    return out
  }

  /**
   * Inspect the currently-selected ICE candidate pair and return the local
   * candidate's type. This is how the renderer distinguishes a direct
   * WebRTC connection (`host` / `srflx` / `prflx`) from one that fell
   * through to a TURN relay (`relay`) for UI labeling. Returns
   * `"unknown"` when the data channel isn't open, when stats aren't
   * available, or when no nominated pair has been chosen yet.
   *
   * The result is intentionally not cached on `TransportRtc` itself —
   * callers (e.g. `CompanionTransport.computeTier`) cache at their own
   * cadence so different consumers can choose their own staleness budget.
   */
  async getSelectedCandidateKind(): Promise<"host" | "srflx" | "prflx" | "relay" | "unknown"> {
    if (this.state !== "open" || !this.pc) return "unknown"
    let report: RTCStatsReport
    try {
      report = await this.pc.getStats()
    } catch (err) {
      console.warn("TransportRtc.getSelectedCandidateKind: getStats failed", err)
      return "unknown"
    }
    let selectedPair:
      | { localCandidateId?: string; selected?: boolean; nominated?: boolean; state?: string }
      | undefined
    const localCandidates = new Map<string, { candidateType?: string }>()
    report.forEach((entry: { type?: string; id?: string } & Record<string, unknown>) => {
      if (entry.type === "candidate-pair") {
        const pair = entry as typeof selectedPair
        // Prefer an explicitly-`selected` pair (Chrome) but accept any
        // `nominated && state === "succeeded"` pair (Firefox/Safari).
        if (pair?.selected || (pair?.nominated && pair?.state === "succeeded")) {
          selectedPair = pair
        }
      } else if (entry.type === "local-candidate" && entry.id) {
        localCandidates.set(entry.id, entry as { candidateType?: string })
      }
    })
    if (!selectedPair?.localCandidateId) return "unknown"
    const local = localCandidates.get(selectedPair.localCandidateId)
    const kind = local?.candidateType
    if (kind === "host" || kind === "srflx" || kind === "prflx" || kind === "relay") {
      return kind
    }
    return "unknown"
  }

  close(): void {
    if (this.state === "closed") return
    this.setState("closing")
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer)
      this.negotiationTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error("TransportRtc: connection closing"))
    }
    this.pending.clear()
    if (this.dc) {
      try {
        this.dc.close()
      } catch {
        // ignored
      }
      this.dc = null
    }
    if (this.pc) {
      try {
        this.pc.close()
      } catch {
        // ignored
      }
      this.pc = null
    }
    if (this.signaling) {
      this.signaling.close()
      this.signaling = null
    }
    this.setState("closed")
  }

  // ── Negotiation state machine ──────────────────────────────────────────

  private onDcOpenResolvers: Array<() => void> = []
  private onDcFailResolvers: Array<(err: Error) => void> = []

  private async startNegotiation(): Promise<void> {
    this.setState("negotiating")
    const pc = this.opts.peerConnectionFactory(this.opts.rtcConfiguration)
    this.pc = pc

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate || !this.signaling) return
      const body: RtcIceBody = { candidate: event.candidate.toJSON() }
      void this.signaling.send("rtc:ice", body)
    }
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        const err = new Error(`ICE state ${pc.iceConnectionState}`)
        if (this.state === "open") {
          this.handleMidSessionDisconnect()
        } else {
          this.fail(err)
        }
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        const err = new Error("peer connection failed")
        if (this.state === "open") {
          this.handleMidSessionDisconnect()
        } else {
          this.fail(err)
        }
      }
    }

    // Mobile is the offerer; desktop answers.
    const dc = pc.createDataChannel(DATACHANNEL_LABEL, { ordered: true })
    this.attachDataChannel(dc)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    if (!this.signaling) {
      throw new Error("TransportRtc: signaling closed during negotiation")
    }
    const body: RtcOfferBody = { sdp: offer.sdp ?? "" }
    await this.signaling.send("rtc:offer", body)
  }

  private async handleSignalingEnvelope(envelope: Envelope): Promise<void> {
    const pc = this.pc
    if (!pc) return
    switch (envelope.kind) {
      case "rtc:answer": {
        const body = envelope.body as RtcAnswerBody
        await pc.setRemoteDescription({ type: "answer", sdp: body.sdp })
        break
      }
      case "rtc:ice": {
        const body = envelope.body as RtcIceBody
        try {
          await pc.addIceCandidate(body.candidate)
        } catch (err) {
          // Late candidates after ICE is complete throw; non-fatal.
          console.warn("TransportRtc: addIceCandidate failed", err)
        }
        break
      }
      case "rtc:close":
        this.fail(new Error("peer closed the connection"))
        break
      case "hello":
        // Desktop's hello acknowledges identity; informational.
        break
      case "rtc:offer":
        // We initiate offers; desktop should never re-offer for now.
        console.warn("TransportRtc: unexpected rtc:offer from peer")
        break
    }
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc
    dc.onopen = () => {
      this.setState("open")
      // Successful (re)open clears the backoff so the next mid-session
      // disconnect starts from the smallest delay again.
      this.reconnectAttempt = 0
      const resolvers = this.onDcOpenResolvers
      this.onDcOpenResolvers = []
      for (const r of resolvers) r()
    }
    dc.onclose = () => {
      if (this.state === "open") {
        this.handleMidSessionDisconnect()
      }
    }
    dc.onerror = () => {
      if (this.state === "open") {
        this.handleMidSessionDisconnect()
      } else {
        this.fail(new Error("DataChannel error"))
      }
    }
    dc.onmessage = (event: MessageEvent) => {
      this.handleDataChannelMessage(String(event.data))
    }
  }

  /**
   * Tear down the current peer/dc/signaling triple without flipping to
   * `failed`. Used by both auto-reconnect and `reconnectNow()` so the state
   * machine can re-enter `connect()` cleanly.
   */
  private teardownPeer(): void {
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer)
      this.negotiationTimer = null
    }
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error("TransportRtc: connection reset"))
    }
    this.pending.clear()
    if (this.dc) {
      try {
        this.dc.close()
      } catch {
        /* ignored */
      }
      this.dc = null
    }
    if (this.pc) {
      try {
        this.pc.close()
      } catch {
        /* ignored */
      }
      this.pc = null
    }
    if (this.signaling) {
      try {
        this.signaling.close()
      } catch {
        /* ignored */
      }
      this.signaling = null
    }
    // Stale resolvers from any previous connect() call must not fire
    // against a future cycle — clear them so each connect() gets fresh
    // open/fail bridges.
    this.onDcOpenResolvers = []
    this.onDcFailResolvers = []
  }

  /**
   * Schedule a reconnection attempt after the DataChannel dropped post-open.
   * After exhausting [`RECONNECT_BACKOFF_MS`] we surface `failed` so the
   * outer `CompanionTransport` drops its RTC reference and the UI falls
   * back to HTTPS+WS.
   */
  private handleMidSessionDisconnect(): void {
    if (this.state !== "open") return

    const schedule = this.opts.reconnectBackoffMs
    const willExhaust = this.reconnectAttempt >= schedule.length

    // Set state BEFORE teardown so the synchronous `dc.close()` /
    // `pc.close()` reentrancy through onclose/onicestatechange handlers
    // hits the `if (this.state !== "open")` guard and bails out.
    this.setState(willExhaust ? "failed" : "reconnecting")
    this.teardownPeer()

    if (willExhaust) return

    const delay = schedule[this.reconnectAttempt]
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.state !== "reconnecting") return
      void this.connect().catch((err) => {
        console.warn("TransportRtc: scheduled reconnect rejected", err)
      })
    }, delay)
  }

  private handleDataChannelMessage(raw: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      console.warn("TransportRtc: dropped non-JSON DC frame")
      return
    }
    if (!frame || typeof frame !== "object") return

    if ("kind" in frame && (frame as { kind: string }).kind === "event") {
      const ev = frame as RtcEvent
      const prev = this.highestSeq.get(ev.event) ?? 0
      if (ev.seq > prev) this.highestSeq.set(ev.event, ev.seq)
      const handlers = this.channels.get(ev.event)
      if (handlers) {
        for (const h of handlers) {
          try {
            h(ev.payload)
          } catch (err) {
            console.warn("TransportRtc: event handler threw", err)
          }
        }
      }
      return
    }

    if ("id" in frame && typeof (frame as { id: unknown }).id === "string") {
      const resp = frame as RtcResponse
      const pending = this.pending.get(resp.id)
      if (!pending) return
      this.pending.delete(resp.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (resp.ok) pending.resolve(resp.result)
      else pending.reject(Object.assign(new Error(resp.error.message), { code: resp.error.code }))
    }
  }

  private fail(err: Error): void {
    if (this.state === "failed" || this.state === "closed") return
    this.setState("failed")
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    const resolvers = this.onDcFailResolvers
    this.onDcFailResolvers = []
    for (const r of resolvers) r(err)
    if (this.dc) {
      try {
        this.dc.close()
      } catch {
        /* ignored */
      }
      this.dc = null
    }
    if (this.pc) {
      try {
        this.pc.close()
      } catch {
        /* ignored */
      }
      this.pc = null
    }
    if (this.signaling) {
      this.signaling.close()
      this.signaling = null
    }
  }

  private setState(next: RtcState): void {
    if (this.state === next) return
    this.state = next
    for (const l of this.stateListeners) {
      try {
        l(next)
      } catch (err) {
        console.warn("TransportRtc: state listener threw", err)
      }
    }
  }
}
