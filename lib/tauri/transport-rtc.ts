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
 * ordered/reliable DataChannel named `cognia.signaling`. Responses come back as
 * `{ id, ok, result | error }`. Events flow as `{ event, payload, seq }`
 * with the same EventBus `seq` semantics as the existing
 * `/ws/events` channel.
 *
 * Signaling authenticates each role with ECDSA P-256, derives directional
 * session keys with ephemeral P-256 ECDH + HKDF-SHA-256, and encrypts SDP/ICE
 * using AES-256-GCM. The relay sees only authenticated metadata and
 * ciphertext. DTLS then protects the negotiated DataChannel itself.
 */

// Import from the leaf modules directly. The signaling barrel
// (`@/lib/signaling`) re-exports `desktop-controller`, which itself imports
// from `lib/tauri/*` — pulling the barrel back here would close the
// `lib/tauri.ts → transport-instance → transport-companion → transport-rtc
// → @/lib/signaling → desktop-controller → @/lib/tauri/transport-*` cycle
// and trip TDZ on the `transport` binding.
import { SignalingClient } from "@/lib/signaling/client"
import type { RoomDescriptor } from "@/lib/signaling/crypto"
import {
  decodeRtcBinaryResourceChunk,
  encodeRtcChunkAck,
  encodeRtcChunkCancel,
  encodeRtcLogicalMessage,
  RtcChunkReassembler,
} from "@/lib/tauri/datachannel-framing"
import type { TransportBinaryResource, TransportBinaryResponse } from "@/lib/tauri/transport-types"
import { remoteEventResyncCoordinator } from "@/lib/tauri/resync-coordinator"
import {
  DATACHANNEL_LABEL,
  type Envelope,
  type HelloBody,
  type PeerRole,
  type RtcAnswerBody,
  type RtcCloseBody,
  type RtcIceBody,
  type RtcOfferBody,
} from "@/lib/signaling/types"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RtcState =
  | "idle"
  | "signaling-connecting"
  /**
   * WSS subscribed, but the opposite peer is not yet in the rendezvous room.
   * We hold here — WITHOUT arming the negotiation timeout — until a
   * `peerJoined` (or a `subscribed` that already lists the peer) arrives.
   * Before ADR-0021 F1 the mobile side sent its offer unconditionally on
   * `subscribed`, which the server silently dropped into an empty room and
   * stalled the whole cold-start until the 8 s negotiation timer expired.
   */
  | "awaiting-peer"
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
 * Mirrors `services/signaling-server/src/...` / `src-tauri/.../signaling/client.rs:46`
 * so the desktop and mobile retry at compatible cadences.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

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
  idempotencyKey?: string
  protocolVersion: 2
}

export interface RtcCallOptions {
  idempotencyKey?: string
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

/**
 * ADR-0127 §2: several consecutive same-channel events in one DataChannel
 * message. Every inner frame keeps the {@link RtcEvent} shape so it can go
 * through the single-frame path (resync queue + per-channel seq cursor).
 */
export interface RtcEventBatch {
  kind: "event-batch"
  event: string
  seq_from: number
  seq_to: number
  frames: RtcEvent[]
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TransportRtcOptions {
  /** Public signaling endpoint URL (e.g. `wss://signaling.cognia.cn/signaling`). */
  signalingUrl: string
  /** Rendezvous id minted at pair time, baked into CompanionConfig. */
  rendezvousId: string
  /** Self-certifying room descriptor returned by the pair exchange. */
  signalingRoomDescriptor: RoomDescriptor
  /** Non-extractable mobile role signing key loaded from secure storage. */
  signalingPrivateKey: CryptoKey
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
   * Hard timeout for the SDP exchange + ICE gathering, in ms. Armed only
   * once the opposite peer is present and we actually start negotiating
   * (offer sent) — NOT while we sit in `awaiting-peer`. If the DataChannel
   * hasn't opened by then we tear down and surface `failed` so the caller
   * can fall through to the cloudflared tunnel tier. Default 20000.
   */
  negotiationTimeoutMs?: number
  /**
   * How long (ms) to sit in `awaiting-peer` waiting for the opposite peer to
   * join the rendezvous before giving up. `0` disables this deadline, which
   * is the production default: an offline peer is an `awaiting-peer` state,
   * not a failed connection attempt.
   */
  peerWaitTimeoutMs?: number
  /**
   * Override for the reconnection backoff schedule (ms). Tests pass a
   * short schedule (e.g. `[5, 10]`) to exercise exhaustion without
   * sleeping. Production should leave this unset — the default mirrors
   * the Rust desktop-side schedule.
   */
  reconnectBackoffMs?: readonly number[]
  /**
   * How long (ms) to wait for ICE to re-converge after an ICE restart
   * before escalating to a full peer teardown + reconnect. Default 12000.
   */
  iceRestartTimeoutMs?: number
  /**
   * Maximum consecutive ICE restarts attempted on the live peer before
   * escalating to a full teardown reconnect. The counter resets whenever
   * ICE recovers or the DataChannel (re)opens. Default 2; set `0` to skip
   * ICE restart entirely (straight to full reconnect on ICE failure).
   */
  iceRestartMaxAttempts?: number
  /** Grace window for a transient ICE `disconnected`/`failed` state. Default 5000. */
  disconnectedGraceMs?: number
  /** Healthy-open duration before recovery counters reset. Default 60000. */
  healthyResetMs?: number
  /** Full-jitter source in [0, 1); injectable for deterministic tests. */
  reconnectRandom?: () => number
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

type PendingBinary = {
  resolve: (value: TransportBinaryResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  mediaType?: string
  totalBytes?: number
  totalChunks?: number
  receivedBytes: number
  chunks: Map<number, Uint8Array>
}

type EventHandler = (payload: unknown) => void

const RPC_TIMEOUT_MS = 30_000
const MAX_CONCURRENT_RPCS = 32
const MAX_CONCURRENT_BINARY_RESOURCES = 8
const MAX_BINARY_RESOURCE_BYTES = 10 * 1024 * 1024
const BUFFERED_AMOUNT_HIGH_WATER = 1024 * 1024
const BUFFERED_AMOUNT_LOW_WATER = 256 * 1024
const MAX_PENDING_REMOTE_ICE = 256
const PENDING_REMOTE_ICE_TTL_MS = 30_000
export const TERMINAL_DATACHANNEL_LABEL = "cognia.terminal"

export class TransportRtc {
  private readonly opts: Required<
    Omit<
      TransportRtcOptions,
      | "rtcConfiguration"
      | "peerConnectionFactory"
      | "signalingClientFactory"
      | "reconnectBackoffMs"
      | "reconnectRandom"
    >
  > &
    Pick<TransportRtcOptions, "rtcConfiguration"> & {
      peerConnectionFactory: NonNullable<TransportRtcOptions["peerConnectionFactory"]>
      signalingClientFactory: NonNullable<TransportRtcOptions["signalingClientFactory"]>
      reconnectBackoffMs: readonly number[]
      reconnectRandom: () => number
    }

  private signaling: SignalingClient | null = null
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private terminalDc: RTCDataChannel | null = null
  private state: RtcState = "idle"
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null
  /** Timer for the `awaiting-peer` phase (opposite peer not yet in room). */
  private peerWaitTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Detaches this connect() attempt's signaling listeners and clears the
   * peer-wait / negotiation timers. Set while a negotiation is in flight,
   * invoked exactly once on the first settle (open or fail). Null otherwise.
   */
  private negotiationCleanup: (() => void) | null = null
  /**
   * Synchronous guard so a `subscribed`-with-peer and a racing `peerJoined`
   * can't both kick off a negotiation before `this.pc` is assigned (the
   * assignment sits behind an `await` in `startNegotiation`).
   */
  private negotiationKickedOff = false
  private negotiationSettled = false
  private nextRpcId = 1
  private pending: Map<string, Pending> = new Map()
  private pendingBinary: Map<string, PendingBinary> = new Map()
  private readonly reassembler = new RtcChunkReassembler()
  private channels: Map<string, Set<EventHandler>> = new Map()
  private highestSeq: Map<string, number> = new Map()
  private eventCursor = 0
  private resyncInFlight: Promise<void> | null = null
  private pendingEventsDuringResync: RtcEvent[] = []
  private pendingRemoteIce: Array<{
    candidate: RTCIceCandidateInit
    receivedAt: number
  }> = []
  private stateListeners: Set<(s: RtcState) => void> = new Set()
  /** Index into [`RECONNECT_BACKOFF_MS`] for the next scheduled retry. */
  private reconnectAttempt = 0
  /** Pending timer for the next reconnect attempt; null when none scheduled. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** True while an ICE restart is in flight on the live peer. */
  private iceRestarting = false
  /** Consecutive ICE restarts since the last recovery / DataChannel open. */
  private iceRestartAttempt = 0
  /** Timer that escalates a stalled ICE restart to a full reconnect. */
  private iceRestartTimer: ReturnType<typeof setTimeout> | null = null
  /** Timer for the transient ICE-disconnected grace phase. */
  private disconnectedGraceTimer: ReturnType<typeof setTimeout> | null = null
  /** Resets recovery counters only after a genuinely healthy minute. */
  private healthyResetTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Wall-clock timestamp (ms) of the most recent `reconnectNow()` call.
   * Used by the throttle in `reconnectNow()` so XSS-driven floods are
   * rejected. Initialised to `0` so the first manual reconnect always
   * fires.
   */
  private lastManualReconnectMs = 0

  constructor(opts: TransportRtcOptions) {
    if (opts.signalingRoomDescriptor.roomId !== opts.rendezvousId) {
      throw new Error("TransportRtc: rendezvousId does not match the room descriptor")
    }
    this.opts = {
      signalingUrl: opts.signalingUrl,
      rendezvousId: opts.rendezvousId,
      signalingRoomDescriptor: opts.signalingRoomDescriptor,
      signalingPrivateKey: opts.signalingPrivateKey,
      deviceId: opts.deviceId,
      role: opts.role ?? "mobile",
      rtcConfiguration: opts.rtcConfiguration,
      negotiationTimeoutMs: opts.negotiationTimeoutMs ?? 20_000,
      peerWaitTimeoutMs: opts.peerWaitTimeoutMs ?? 0,
      reconnectBackoffMs: opts.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS,
      reconnectRandom: opts.reconnectRandom ?? Math.random,
      iceRestartTimeoutMs: opts.iceRestartTimeoutMs ?? 12_000,
      iceRestartMaxAttempts: opts.iceRestartMaxAttempts ?? 2,
      disconnectedGraceMs: opts.disconnectedGraceMs ?? 5_000,
      healthyResetMs: opts.healthyResetMs ?? 60_000,
      peerConnectionFactory:
        opts.peerConnectionFactory ??
        ((config) => new RTCPeerConnection(config as RTCConfiguration | undefined)),
      signalingClientFactory: opts.signalingClientFactory ?? ((o) => new SignalingClient(o)),
    }
    this.eventCursor = this.loadEventCursor()
  }

  // ── Public surface ─────────────────────────────────────────────────────

  getState(): RtcState {
    return this.state
  }

  /**
   * Return the terminal-only ordered channel negotiated with this peer.
   * Terminal framing and backpressure are owned by `TerminalHostConnection`;
   * the Companion RPC channel never inspects terminal bytes.
   */
  getTerminalDataChannel(): RTCDataChannel | null {
    return this.terminalDc
  }

  onStateChange(handler: (state: RtcState) => void): () => void {
    this.stateListeners.add(handler)
    return () => {
      this.stateListeners.delete(handler)
    }
  }

  /**
   * Apply refreshed STUN/TURN credentials to both this connection and future
   * rebuilds. `setConfiguration` does not itself restart ICE; the refreshed
   * servers are consumed by the next ICE restart or negotiation cycle.
   */
  updateRtcConfiguration(configuration: RTCConfiguration | undefined): void {
    this.opts.rtcConfiguration = configuration
    if (this.pc && configuration) {
      this.pc.setConfiguration(configuration)
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
    this.negotiationKickedOff = false
    this.setState("signaling-connecting")

    // Arm the peer-wait timer up front so the whole pre-negotiation phase —
    // WSS connect, subscribe, AND `awaiting-peer` — is bounded. Without this a
    // rendezvous whose server is unreachable (SignalingClient retries
    // forever) or that never gains the opposite peer would hang connect()
    // indefinitely; `beginNegotiation` swaps it for the negotiation timeout.
    if (this.opts.peerWaitTimeoutMs > 0) {
      this.peerWaitTimer = setTimeout(() => {
        this.peerWaitTimer = null
        this.settleNegotiationFailure(
          new Error("no peer joined the rendezvous within the wait window")
        )
      }, this.opts.peerWaitTimeoutMs)
    }

    const signaling = this.opts.signalingClientFactory({
      url: this.opts.signalingUrl,
      descriptor: this.opts.signalingRoomDescriptor,
      signingPrivateKey: this.opts.signalingPrivateKey,
      role: this.opts.role,
    })
    this.signaling = signaling

    const opened = new Promise<void>((resolve, reject) => {
      // ADR-0021 F1 — the room may already hold the opposite peer (it
      // subscribed first), or it may arrive later via `peerJoined`. Only kick
      // off the offer once the peer is actually present; otherwise sit in
      // `awaiting-peer` (see `enterAwaitingPeer`) rather than firing an offer
      // into an empty room that the server silently drops.
      const detachSubscribed = signaling.on("subscribed", ({ peers }) => {
        if (this.pc || this.negotiationKickedOff) return
        // Only act while still in the pre-negotiation phase. A `subscribed`
        // that lands after close()/fail() (e.g. a microtask queued by
        // signaling.connect() before teardown) must not revive the transport.
        if (this.state !== "signaling-connecting" && this.state !== "awaiting-peer") return
        if (peers.some((peer) => peer.proof.role === this.peerRole())) {
          void this.beginNegotiation()
        } else {
          this.enterAwaitingPeer()
        }
      })

      const detachJoined = signaling.on("peerJoined", (role) => {
        if (role !== this.peerRole()) return
        if (this.pc || this.negotiationKickedOff) return
        if (this.state !== "awaiting-peer" && this.state !== "signaling-connecting") return
        void this.beginNegotiation()
      })

      const detachLeft = signaling.on("peerLeft", (role) => {
        if (role !== this.peerRole()) return
        if (this.state === "open") {
          // Peer restarted mid-session — tear down + reconnect instead of
          // waiting out an ICE timeout (ADR-0021 F7).
          this.handleMidSessionDisconnect()
        } else {
          this.settleNegotiationFailure(
            new Error("peer left the rendezvous before the channel opened")
          )
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
        // Every server error code emitted during a relay — frame_too_large,
        // rate_limited, malformed_frame, binary_not_supported, not_subscribed
        // (see services/signaling-server/src/ws.rs) — means a critical handshake frame
        // (offer / answer / ICE) was dropped, so the negotiation cannot
        // complete. Fail fast instead of stalling until a timer fires; the
        // caller falls back to HTTPS+WS immediately and the mobile-controller
        // re-attempts the upgrade on the next network/resume trigger.
        this.settleNegotiationFailure(
          new Error(`signaling error during negotiation: ${code} ${message}`)
        )
      })

      // One-shot cleanup for this attempt: detach every listener and clear
      // both phase timers. Invoked by the resolvers below on first settle.
      this.negotiationCleanup = () => {
        detachSubscribed()
        detachJoined()
        detachLeft()
        detachEnv()
        detachErr()
        if (this.negotiationTimer) {
          clearTimeout(this.negotiationTimer)
          this.negotiationTimer = null
        }
        if (this.peerWaitTimer) {
          clearTimeout(this.peerWaitTimer)
          this.peerWaitTimer = null
        }
        this.negotiationCleanup = null
      }

      // Bridge: when the DataChannel opens, we resolve the connect promise.
      this.onDcOpenResolvers.push(() => {
        if (this.negotiationSettled) return
        this.negotiationSettled = true
        this.negotiationCleanup?.()
        resolve()
      })
      this.onDcFailResolvers.push((err) => {
        if (this.negotiationSettled) return
        this.negotiationSettled = true
        this.negotiationCleanup?.()
        reject(err)
      })
    })

    signaling.connect()
    return opened
  }

  /** The role we expect on the other end of the rendezvous. */
  private peerRole(): PeerRole {
    return this.opts.role === "mobile" ? "desktop" : "mobile"
  }

  /**
   * Enter the `awaiting-peer` hold: subscribed, but the opposite peer is not
   * yet in the room. The peer-wait timer armed in `connect()` already bounds
   * this phase, so this only flips the observable state (so the tier / UI can
   * reflect "waiting for the desktop" distinctly from "connecting").
   */
  private enterAwaitingPeer(): void {
    if (this.state === "awaiting-peer") return
    this.setState("awaiting-peer")
  }

  /**
   * Begin the SDP/ICE handshake now that the peer is present: swap the
   * peer-wait timer for the negotiation timeout and run `startNegotiation`.
   * Idempotent within one connect() attempt via `negotiationKickedOff`.
   */
  private async beginNegotiation(): Promise<void> {
    if (this.negotiationKickedOff) return
    if (this.state !== "signaling-connecting" && this.state !== "awaiting-peer") return
    this.negotiationKickedOff = true
    if (this.peerWaitTimer) {
      clearTimeout(this.peerWaitTimer)
      this.peerWaitTimer = null
    }
    if (!this.negotiationTimer) {
      this.negotiationTimer = setTimeout(() => {
        this.negotiationTimer = null
        this.settleNegotiationFailure(new Error("WebRTC negotiation timed out"))
      }, this.opts.negotiationTimeoutMs)
    }
    try {
      await this.startNegotiation()
    } catch (err) {
      this.settleNegotiationFailure(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /**
   * Fail the in-flight negotiation once. Routes through `fail()`, whose
   * `onDcFailResolvers` run the cleanup + reject the connect() promise. A
   * second call after settle is a no-op.
   */
  private settleNegotiationFailure(err: Error): void {
    if (this.negotiationSettled) return
    this.fail(err)
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
  reconnectNow(): "started" | "busy" | "throttled" {
    // An action already in flight can't be accelerated — report `busy`
    // WITHOUT consuming the throttle window, so this early return never
    // blocks a genuine reconnect the user attempts moments later. (Before
    // ADR-0021 F3 this returned `true` here, so the UI toasted "reconnect
    // started" for a no-op and burned the 5 s window on the way out.)
    if (
      this.state === "signaling-connecting" ||
      this.state === "awaiting-peer" ||
      this.state === "negotiating" ||
      this.state === "closing"
    ) {
      return "busy"
    }

    // Throttle: defend against XSS or runaway UI loops calling this in a
    // tight cycle. Genuine user double-taps land within ~300 ms so the
    // 5 s window doesn't block them on the first click; subsequent
    // accidental clicks are silently dropped.
    const now = Date.now()
    if (now - this.lastManualReconnectMs < RECONNECT_NOW_MIN_SPACING_MS) {
      return "throttled"
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
    }

    void this.connect().catch((err) => {
      // Surface via state transitions; nothing else to do here.
      console.warn("TransportRtc.reconnectNow: connect rejected", err)
    })
    return "started"
  }

  /** Send an RPC; resolves with the result payload. */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: RtcCallOptions = {}
  ): Promise<T> {
    if (this.state !== "open" || !this.dc || this.dc.readyState !== "open") {
      return Promise.reject(new Error("TransportRtc: DataChannel is not open"))
    }
    if (this.pending.size >= MAX_CONCURRENT_RPCS) {
      return Promise.reject(new Error("TransportRtc: too many concurrent RPCs"))
    }
    const id = `rpc-${this.nextRpcId++}`
    const message: RtcMessage = {
      id,
      method,
      params,
      idempotencyKey: options.idempotencyKey,
      protocolVersion: 2,
    }
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
      void this.sendLogicalMessage(JSON.stringify(message)).catch((error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Read one authenticated transcript media resource over raw binary frames. */
  readBinary(resource: TransportBinaryResource): Promise<TransportBinaryResponse> {
    if (this.state !== "open" || !this.dc || this.dc.readyState !== "open") {
      return Promise.reject(new Error("TransportRtc: DataChannel is not open"))
    }
    if (this.pendingBinary.size >= MAX_CONCURRENT_BINARY_RESOURCES) {
      return Promise.reject(new Error("TransportRtc: too many concurrent binary resources"))
    }
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBinary.delete(id)
        reject(new Error("TransportRtc: binary resource timed out"))
      }, RPC_TIMEOUT_MS)
      this.pendingBinary.set(id, {
        resolve,
        reject,
        timer,
        receivedBytes: 0,
        chunks: new Map(),
      })
      void this.sendLogicalMessage(
        JSON.stringify({ kind: "binary-resource", id, protocolVersion: 2, resource })
      ).catch((error) => {
        this.rejectPendingBinary(id, error)
      })
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
    this.cancelIceRestart()
    this.cancelRecoveryTimers()
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer)
      this.negotiationTimer = null
    }
    if (this.peerWaitTimer) {
      clearTimeout(this.peerWaitTimer)
      this.peerWaitTimer = null
    }
    this.negotiationCleanup = null
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
    if (this.terminalDc) {
      try {
        this.terminalDc.close()
      } catch {
        // ignored
      }
      this.terminalDc = null
    }
    if (this.pc) {
      try {
        this.pc.close()
      } catch {
        // ignored
      }
      this.pc = null
    }
    // Best-effort graceful shutdown: tell the peer before tearing the
    // signaling WS down so the desktop's `rtc:close` handler can release its
    // PeerSession + dispatcher immediately instead of waiting for ICE/state
    // failure. The signed frame is async (SubtleCrypto), so close the WS only
    // after the send settles. Failures (already-broken channel) are ignored.
    const sig = this.signaling
    this.signaling = null
    if (sig) {
      void sig
        .send("rtc:close", { reason: "client closing" } satisfies RtcCloseBody)
        .catch(() => {})
        .finally(() => {
          try {
            sig.close()
          } catch {
            // ignored
          }
        })
    }
    this.setState("closed")
  }

  // ── Negotiation state machine ──────────────────────────────────────────

  private onDcOpenResolvers: Array<() => void> = []
  private onDcFailResolvers: Array<(err: Error) => void> = []

  private async startNegotiation(): Promise<void> {
    this.setState("negotiating")
    this.pendingRemoteIce = []
    // Announce our identity before the offer (HelloBody.deviceId). The
    // desktop logs it (informational — it maps the peer by its per-device
    // signaling task), completing the documented handshake contract. Sent
    // once per signaling session, not on ICE restart.
    if (!this.signaling) {
      throw new Error("TransportRtc: signaling closed before negotiation")
    }
    const hello: HelloBody = { deviceId: this.opts.deviceId }
    await this.signaling.send("hello", hello)

    const pc = this.opts.peerConnectionFactory(this.opts.rtcConfiguration)
    this.pc = pc

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate || !this.signaling) return
      const body: RtcIceBody = { candidate: event.candidate.toJSON() }
      void this.signaling.send("rtc:ice", body).catch((error) => {
        console.warn("TransportRtc: failed to queue local ICE candidate", error)
      })
    }
    pc.oniceconnectionstatechange = () => {
      const ice = pc.iceConnectionState
      // ICE recovered (possibly via an in-flight restart) — stop the
      // watchdog and stay open. The attempt counter is NOT reset here: a
      // link that flaps connected↔failed must still escalate to a full
      // reconnect once the budget is spent. Only a healthy DataChannel
      // (re)open resets it (see attachDataChannel.onopen).
      if (ice === "connected" || ice === "completed") {
        this.cancelDisconnectedGrace()
        if (this.iceRestarting) this.cancelIceRestart()
        return
      }
      if (ice === "disconnected" || ice === "failed") {
        if (this.state !== "open") {
          if (ice === "failed") this.fail(new Error(`ICE state ${ice}`))
          return
        }
        this.scheduleIceRecovery(pc)
        return
      }
      if (ice !== "closed") return
      if (this.state !== "open") {
        // ICE collapse during initial negotiation is a hard failure.
        this.fail(new Error(`ICE state ${ice}`))
        return
      }
      this.handleMidSessionDisconnect()
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        const err = new Error("peer connection failed")
        if (this.state === "open") {
          this.scheduleIceRecovery(pc)
        } else {
          this.fail(err)
        }
      }
    }

    // Mobile is the offerer; desktop answers.
    const dc = pc.createDataChannel(DATACHANNEL_LABEL, { ordered: true })
    this.attachDataChannel(dc)
    this.terminalDc = pc.createDataChannel(TERMINAL_DATACHANNEL_LABEL, { ordered: true })

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
        await this.flushPendingRemoteIce(pc)
        break
      }
      case "rtc:ice": {
        const body = envelope.body as RtcIceBody
        if (!pc.remoteDescription) {
          const cutoff = Date.now() - PENDING_REMOTE_ICE_TTL_MS
          this.pendingRemoteIce = this.pendingRemoteIce.filter(
            (entry) => entry.receivedAt >= cutoff
          )
          if (this.pendingRemoteIce.length >= MAX_PENDING_REMOTE_ICE) {
            throw new Error("TransportRtc: pending remote ICE queue overflow")
          }
          this.pendingRemoteIce.push({
            candidate: body.candidate,
            receivedAt: Date.now(),
          })
          break
        }
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

  private async flushPendingRemoteIce(pc: RTCPeerConnection): Promise<void> {
    const pending = this.pendingRemoteIce
    this.pendingRemoteIce = []
    const cutoff = Date.now() - PENDING_REMOTE_ICE_TTL_MS
    for (const entry of pending) {
      if (entry.receivedAt < cutoff) continue
      try {
        await pc.addIceCandidate(entry.candidate)
      } catch (err) {
        console.warn("TransportRtc: queued addIceCandidate failed", err)
      }
    }
  }

  private attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc
    dc.binaryType = "arraybuffer"
    dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_WATER
    dc.onopen = () => {
      dc.send(JSON.stringify({ kind: "event-resume", since: this.eventCursor }))
      this.setState("open")
      this.armHealthyReset()
      this.cancelIceRestart()
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
      if (typeof event.data === "string") {
        this.handleDataChannelMessage(event.data)
      } else if (event.data instanceof ArrayBuffer) {
        this.handleBinaryDataChannelMessage(event.data)
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((data) => this.handleBinaryDataChannelMessage(data))
      }
    }
  }

  private async sendLogicalMessage(text: string): Promise<void> {
    const dc = this.dc
    if (!dc || dc.readyState !== "open") throw new Error("TransportRtc: DataChannel is not open")
    const frames = encodeRtcLogicalMessage(text)
    for (const frame of frames) {
      if (this.dc !== dc || dc.readyState !== "open") {
        throw new Error("TransportRtc: DataChannel changed during send")
      }
      if (dc.bufferedAmount > BUFFERED_AMOUNT_HIGH_WATER) {
        await this.waitForDataChannelCapacity(dc)
      }
      dc.send(frame)
    }
  }

  private async waitForDataChannelCapacity(dc: RTCDataChannel): Promise<void> {
    if (typeof dc.bufferedAmount !== "number" || dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH_WATER) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        dc.removeEventListener("bufferedamountlow", onLow)
        reject(new Error("TransportRtc: DataChannel backpressure timed out"))
      }, 15_000)
      const onLow = () => {
        clearTimeout(timeout)
        dc.removeEventListener("bufferedamountlow", onLow)
        resolve()
      }
      dc.addEventListener("bufferedamountlow", onLow)
    })
  }

  /**
   * Tear down the current peer/dc/signaling triple without flipping to
   * `failed`. Used by both auto-reconnect and `reconnectNow()` so the state
   * machine can re-enter `connect()` cleanly.
   */
  private teardownPeer(): void {
    this.cancelIceRestart()
    this.cancelRecoveryTimers()
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer)
      this.negotiationTimer = null
    }
    if (this.peerWaitTimer) {
      clearTimeout(this.peerWaitTimer)
      this.peerWaitTimer = null
    }
    // A fresh connect() installs a new cleanup + kickoff guard.
    this.negotiationCleanup = null
    this.negotiationKickedOff = false
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error("TransportRtc: connection reset"))
    }
    this.pending.clear()
    for (const pending of this.pendingBinary.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error("TransportRtc: connection reset"))
    }
    this.pendingBinary.clear()
    if (this.dc) {
      try {
        this.dc.close()
      } catch {
        /* ignored */
      }
      this.dc = null
    }
    if (this.terminalDc) {
      try {
        this.terminalDc.close()
      } catch {
        /* ignored */
      }
      this.terminalDc = null
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
   * Attempt a true ICE restart on the live peer connection. Reuses the
   * existing `RTCPeerConnection`, DataChannel, DTLS transport, and signaling
   * session — only ICE re-gathers. The desktop answerer reuses its existing
   * `PeerSession` when it sees `iceRestart: true` (see
   * `src-tauri/.../signaling/client.rs`), so the data channel survives.
   *
   * The new answer flows back through the existing `rtc:answer` handler and
   * fresh candidates through the existing `onicecandidate` relay — no new
   * wiring. A watchdog escalates to a full teardown reconnect if ICE doesn't
   * re-converge within `iceRestartTimeoutMs`.
   */
  private async attemptIceRestart(): Promise<void> {
    const pc = this.pc
    const signaling = this.signaling
    if (!pc || !signaling || this.state !== "open") return
    this.iceRestarting = true
    this.iceRestartAttempt += 1
    this.iceRestartTimer = setTimeout(() => {
      if (!this.iceRestarting) return
      this.cancelIceRestart()
      this.handleMidSessionDisconnect()
    }, this.opts.iceRestartTimeoutMs)
    try {
      const offer = await pc.createOffer({ iceRestart: true })
      await pc.setLocalDescription(offer)
      if (!this.signaling) throw new Error("signaling closed during ICE restart")
      const body: RtcOfferBody = { sdp: offer.sdp ?? "", iceRestart: true }
      await this.signaling.send("rtc:offer", body)
    } catch (err) {
      console.warn("TransportRtc: ICE restart failed to start", err)
      this.cancelIceRestart()
      if (this.state === "open") this.handleMidSessionDisconnect()
    }
  }

  private scheduleIceRecovery(pc: RTCPeerConnection): void {
    if (this.disconnectedGraceTimer || this.iceRestarting || this.state !== "open") return
    const recover = () => {
      this.disconnectedGraceTimer = null
      if (this.pc !== pc || this.state !== "open") return
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") return
      if (this.iceRestartAttempt < this.opts.iceRestartMaxAttempts) {
        void this.attemptIceRestart()
      } else {
        this.handleMidSessionDisconnect()
      }
    }
    if (this.opts.disconnectedGraceMs === 0) {
      recover()
      return
    }
    this.disconnectedGraceTimer = setTimeout(recover, this.opts.disconnectedGraceMs)
  }

  private cancelDisconnectedGrace(): void {
    if (this.disconnectedGraceTimer) {
      clearTimeout(this.disconnectedGraceTimer)
      this.disconnectedGraceTimer = null
    }
  }

  private armHealthyReset(): void {
    if (this.healthyResetTimer) clearTimeout(this.healthyResetTimer)
    if (this.opts.healthyResetMs === 0) {
      this.reconnectAttempt = 0
      this.iceRestartAttempt = 0
      return
    }
    this.healthyResetTimer = setTimeout(() => {
      this.healthyResetTimer = null
      if (this.state !== "open") return
      this.reconnectAttempt = 0
      this.iceRestartAttempt = 0
    }, this.opts.healthyResetMs)
  }

  private cancelRecoveryTimers(): void {
    this.cancelDisconnectedGrace()
    if (this.healthyResetTimer) {
      clearTimeout(this.healthyResetTimer)
      this.healthyResetTimer = null
    }
  }

  /** Clear ICE-restart bookkeeping (flag + watchdog timer). */
  private cancelIceRestart(): void {
    this.iceRestarting = false
    if (this.iceRestartTimer) {
      clearTimeout(this.iceRestartTimer)
      this.iceRestartTimer = null
    }
  }

  /**
   * Schedule a reconnection attempt after the DataChannel dropped post-open.
   * After exhausting [`RECONNECT_BACKOFF_MS`] we surface `failed` so the
   * outer `CompanionTransport` drops its RTC reference and the UI falls
   * back to HTTPS+WS.
   */
  private handleMidSessionDisconnect(): void {
    if (this.state !== "open") return
    // A full teardown (via teardownPeer below) supersedes any in-flight ICE
    // restart and cancels its watchdog.
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
    const jitter = Math.min(0.999_999, Math.max(0, this.opts.reconnectRandom()))
    const jitteredDelay = Math.floor(delay * jitter)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.state !== "reconnecting") return
      void this.connect().catch((err) => {
        console.warn("TransportRtc: scheduled reconnect rejected", err)
      })
    }, jitteredDelay)
  }

  private handleDataChannelMessage(raw: string): void {
    const reassembled = this.reassembler.accept(raw)
    if (reassembled.kind === "partial" || reassembled.kind === "ack") return
    if (reassembled.kind === "cancel") {
      if (reassembled.messageId && this.dc?.readyState === "open") {
        this.dc.send(encodeRtcChunkCancel(reassembled.messageId, reassembled.reason))
      }
      return
    }
    if (reassembled.messageId && this.dc?.readyState === "open") {
      this.dc.send(encodeRtcChunkAck(reassembled.messageId))
    }
    raw = this.reassembler.decode(reassembled)
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      console.warn("TransportRtc: dropped non-JSON DC frame")
      return
    }
    if (!frame || typeof frame !== "object") return

    if ("kind" in frame && (frame as { kind: string }).kind === "binary-resource-start") {
      const start = frame as {
        id?: unknown
        mediaType?: unknown
        totalBytes?: unknown
        totalChunks?: unknown
      }
      if (typeof start.id !== "string") return
      const pending = this.pendingBinary.get(start.id)
      if (!pending) return
      if (
        typeof start.mediaType !== "string" ||
        !Number.isSafeInteger(start.totalBytes) ||
        (start.totalBytes as number) < 0 ||
        (start.totalBytes as number) > MAX_BINARY_RESOURCE_BYTES ||
        !Number.isSafeInteger(start.totalChunks) ||
        (start.totalChunks as number) < 1 ||
        (start.totalChunks as number) > 512
      ) {
        this.rejectPendingBinary(start.id, new Error("invalid binary resource metadata"))
        return
      }
      pending.mediaType = start.mediaType
      pending.totalBytes = start.totalBytes as number
      pending.totalChunks = start.totalChunks as number
      return
    }

    if ("kind" in frame && (frame as { kind: string }).kind === "resync_required") {
      const notice = frame as {
        kind: "resync_required"
        domains?: string[]
        cursor?: number
      }
      this.startAuthoritativeResync(notice)
      return
    }

    if ("kind" in frame && (frame as { kind: string }).kind === "event") {
      this.acceptRtcEvent(frame as RtcEvent)
      return
    }

    if ("kind" in frame && (frame as { kind: string }).kind === "event-batch") {
      const batch = frame as RtcEventBatch
      if (!Array.isArray(batch.frames)) return
      for (const inner of batch.frames) {
        if (inner && typeof inner === "object" && inner.kind === "event") {
          this.acceptRtcEvent(inner)
        }
      }
      return
    }

    if ("id" in frame && typeof (frame as { id: unknown }).id === "string") {
      const resp = frame as RtcResponse
      const binary = this.pendingBinary.get(resp.id)
      if (binary) {
        if (resp.ok) {
          this.rejectPendingBinary(resp.id, new Error("unexpected binary resource response"))
        } else {
          this.rejectPendingBinary(
            resp.id,
            Object.assign(new Error(resp.error.message), { code: resp.error.code })
          )
        }
        return
      }
      const pending = this.pending.get(resp.id)
      if (!pending) return
      this.pending.delete(resp.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (resp.ok) pending.resolve(resp.result)
      else pending.reject(Object.assign(new Error(resp.error.message), { code: resp.error.code }))
    }
  }

  private handleBinaryDataChannelMessage(data: ArrayBuffer): void {
    let chunk: ReturnType<typeof decodeRtcBinaryResourceChunk>
    try {
      chunk = decodeRtcBinaryResourceChunk(data)
    } catch {
      return
    }
    const pending = this.pendingBinary.get(chunk.requestId)
    if (!pending || pending.totalBytes === undefined || pending.totalChunks === undefined) return
    if (chunk.totalChunks !== pending.totalChunks) {
      this.rejectPendingBinary(chunk.requestId, new Error("binary resource chunk count mismatch"))
      return
    }
    if (pending.chunks.has(chunk.index)) return
    pending.receivedBytes += chunk.bytes.byteLength
    if (pending.receivedBytes > pending.totalBytes) {
      this.rejectPendingBinary(chunk.requestId, new Error("binary resource length mismatch"))
      return
    }
    pending.chunks.set(chunk.index, chunk.bytes)
    if (pending.chunks.size !== pending.totalChunks) return

    const bytes = new Uint8Array(pending.totalBytes)
    let offset = 0
    for (let index = 0; index < pending.totalChunks; index += 1) {
      const part = pending.chunks.get(index)
      if (!part || offset + part.byteLength > bytes.byteLength) {
        this.rejectPendingBinary(chunk.requestId, new Error("binary resource length mismatch"))
        return
      }
      bytes.set(part, offset)
      offset += part.byteLength
    }
    if (offset !== bytes.byteLength || !pending.mediaType) {
      this.rejectPendingBinary(chunk.requestId, new Error("binary resource length mismatch"))
      return
    }
    this.pendingBinary.delete(chunk.requestId)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve({ bytes, mediaType: pending.mediaType })
  }

  private rejectPendingBinary(requestId: string, error: unknown): void {
    const pending = this.pendingBinary.get(requestId)
    if (!pending) return
    this.pendingBinary.delete(requestId)
    if (pending.timer) clearTimeout(pending.timer)
    pending.reject(error instanceof Error ? error : new Error(String(error)))
  }

  private startAuthoritativeResync(notice: { domains?: string[]; cursor?: number }): void {
    if (this.resyncInFlight) return
    const domains = notice.domains?.length ? notice.domains : ["*"]
    this.resyncInFlight = remoteEventResyncCoordinator
      .resolve(domains)
      .then(() => {
        if (!Number.isSafeInteger(notice.cursor) || (notice.cursor ?? -1) < 0) {
          throw new Error("resync notice omitted a valid cursor")
        }
        this.eventCursor = Math.max(this.eventCursor, notice.cursor!)
        this.highestSeq.clear()
        this.saveEventCursor()
        for (const handlers of this.channels.values()) {
          for (const handler of handlers) {
            try {
              handler({ type: "resync_required", domains })
            } catch (error) {
              console.warn("TransportRtc: resync handler threw", error)
            }
          }
        }
        const queued = this.pendingEventsDuringResync
          .splice(0)
          .sort((left, right) => left.seq - right.seq)
        for (const event of queued) this.deliverRtcEvent(event)
        if (this.dc?.readyState === "open") {
          this.dc.send(JSON.stringify({ kind: "event-ack", seq: this.eventCursor }))
        }
      })
      .catch((error) => {
        this.pendingEventsDuringResync = []
        this.fail(
          new Error(
            `TransportRtc: authoritative event resync failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        )
      })
      .finally(() => {
        this.resyncInFlight = null
      })
  }

  /** One plain event: queued while an authoritative resync is in flight, else delivered. */
  private acceptRtcEvent(ev: RtcEvent): void {
    if (this.resyncInFlight) {
      if (this.pendingEventsDuringResync.length >= 128) {
        this.fail(new Error("TransportRtc: event queue overflow during resync"))
        return
      }
      this.pendingEventsDuringResync.push(ev)
    } else {
      this.deliverRtcEvent(ev)
    }
  }

  private deliverRtcEvent(ev: RtcEvent): void {
    const prev = this.highestSeq.get(ev.event) ?? 0
    if (!Number.isSafeInteger(ev.seq) || ev.seq <= prev || ev.seq <= this.eventCursor) return
    this.highestSeq.set(ev.event, ev.seq)
    this.eventCursor = ev.seq
    this.saveEventCursor()
    const handlers = this.channels.get(ev.event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(ev.payload)
        } catch (error) {
          console.warn("TransportRtc: event handler threw", error)
        }
      }
    }
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify({ kind: "event-ack", seq: this.eventCursor }))
    }
  }

  private eventCursorStorageKey(): string {
    return `cognia:rtc-event-cursor:${this.opts.rendezvousId}`
  }

  private loadEventCursor(): number {
    try {
      if (typeof localStorage === "undefined") return 0
      const value = Number(localStorage.getItem(this.eventCursorStorageKey()))
      return Number.isSafeInteger(value) && value >= 0 ? value : 0
    } catch {
      return 0
    }
  }

  private saveEventCursor(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(this.eventCursorStorageKey(), String(this.eventCursor))
      }
    } catch {
      // Cursor persistence is best-effort; the live in-memory cursor remains valid.
    }
  }

  private fail(err: Error): void {
    if (this.state === "failed" || this.state === "closed") return
    this.setState("failed")
    this.cancelIceRestart()
    this.cancelRecoveryTimers()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    this.pendingRemoteIce = []
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
