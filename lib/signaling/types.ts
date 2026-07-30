/**
 * Wire protocol shared between the cognia signaling server (Rust) and the
 * TypeScript clients (mobile + desktop transports). Mirror of
 * `services/signaling-server/src/proto.rs`. Keep the two files in sync — the
 * end-to-end tests in `tests/signaling-server` verify field names match.
 *
 * ADR-0021.
 */

export type PeerRole = "desktop" | "mobile"

// ---------------------------------------------------------------------------
// Server-visible envelope frames
// ---------------------------------------------------------------------------

export type ClientFrame =
  | { kind: "subscribe"; descriptor: RoomDescriptorV2; proof: SubscribeProofV2 }
  | { kind: "unsubscribe"; rendezvousId: string }
  | { kind: "relay"; rendezvousId: string; payload: string }
  | { kind: "ping" }

export interface PeerSnapshot {
  proof: SubscribeProofV2
  joinedAtMs: number
}

export type ServerFrame =
  | { kind: "challenge"; challenge: string; issuedAt: number; expiresAt: number }
  | { kind: "subscribed"; rendezvousId: string; peers: PeerSnapshot[] }
  | { kind: "peerJoined"; rendezvousId: string; peer: PeerSnapshot }
  | { kind: "peerLeft"; rendezvousId: string; role: PeerRole; sessionId: string }
  | {
      kind: "relay"
      rendezvousId: string
      fromRole: PeerRole
      fromSessionId: string
      payload: string
    }
  | { kind: "pong" }
  | { kind: "error"; code: string; message: string }

// ---------------------------------------------------------------------------
// Application envelope (opaque to the signaling server)
// ---------------------------------------------------------------------------

export type EnvelopeKind = "hello" | "rtc:offer" | "rtc:answer" | "rtc:ice" | "rtc:close"

export interface Envelope {
  ver: 2
  roomId: string
  senderRole: PeerRole
  sessionId: string
  epoch: string
  seq: number
  issuedAt: number
  kind: EnvelopeKind
  body: unknown
}

export interface RoomDescriptorV2 {
  v: 2
  roomId: string
  roomNonce: string
  desktopSigningKey: string
  mobileSigningKey: string
  notAfter: number
}

export interface SubscribeProofV2 {
  v: 2
  roomId: string
  role: PeerRole
  sessionId: string
  epoch: string
  issuedAt: number
  challenge: string
  ecdhPublicKey: string
  signature: string
}

// Specific body shapes (helpers, not enforced by the envelope type itself).

export interface HelloBody {
  deviceId: string
  /**
   * Optional list of ICE servers the sender prefers. Receivers may
   * combine, but the desktop is authoritative for the actual configuration
   * used in `RTCPeerConnection`.
   */
  iceServers?: RTCIceServer[]
}

export interface RtcOfferBody {
  sdp: string
  iceRestart?: boolean
}

export interface RtcAnswerBody {
  sdp: string
}

export interface RtcIceBody {
  candidate: RTCIceCandidateInit
}

export interface RtcCloseBody {
  reason?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum acceptable clock skew between sender and receiver, in ms. */
export const REPLAY_CLOCK_SKEW_MS = 5 * 60 * 1000

/** Per-room replay protection LRU capacity (entries). */
export const REPLAY_LRU_CAPACITY = 256

/** Outbound WSS reconnect backoff (ms), full-jitter exponential. */
export const SIGNALING_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000, 60000] as const

/** Application-level ping cadence sent over the signaling WS (ms). */
export const SIGNALING_PING_INTERVAL_MS = 20_000

/** Default DataChannel label, matched on both sides. */
export const DATACHANNEL_LABEL = "cognia.v2"

/**
 * Default public signaling rendezvous endpoint. Customizable on three levels:
 *  1. Build time — set `NEXT_PUBLIC_SIGNALING_URL` (inlined into the static
 *     export, so it applies to the browser, Tauri, and Capacitor shells alike).
 *  2. Runtime, per install — `AppSettings.signalingUrl` (Settings → Companion →
 *     WebRTC) overrides this default.
 *  3. The code fallback below is the only hard-coded value — change it (and the
 *     Worker's `wrangler.toml` route) if you operate a different domain.
 */
export const DEFAULT_SIGNALING_URL =
  process.env.NEXT_PUBLIC_SIGNALING_URL ?? "wss://signaling.cognia.cn/v2/signaling"
