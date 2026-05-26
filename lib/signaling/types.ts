/**
 * Wire protocol shared between the cognia signaling server (Rust) and the
 * TypeScript clients (mobile + desktop transports). Mirror of
 * `signaling-server/src/proto.rs`. Keep the two files in sync — the
 * end-to-end tests in `tests/signaling-server` verify field names match.
 *
 * ADR-0021.
 */

export type PeerRole = "desktop" | "mobile"

// ---------------------------------------------------------------------------
// Server-visible envelope frames
// ---------------------------------------------------------------------------

export type ClientFrame =
  | { kind: "subscribe"; rendezvousId: string; role: PeerRole; clientNonce: string }
  | { kind: "unsubscribe"; rendezvousId: string }
  | { kind: "relay"; rendezvousId: string; payload: string }
  | { kind: "ping" }

export interface PeerSnapshot {
  role: PeerRole
  joinedAtMs: number
}

export type ServerFrame =
  | { kind: "subscribed"; rendezvousId: string; peers: PeerSnapshot[] }
  | { kind: "peerJoined"; rendezvousId: string; role: PeerRole }
  | { kind: "peerLeft"; rendezvousId: string; role: PeerRole }
  | { kind: "relay"; rendezvousId: string; fromRole: PeerRole; payload: string }
  | { kind: "pong" }
  | { kind: "error"; code: string; message: string }

// ---------------------------------------------------------------------------
// Application envelope (opaque to the signaling server)
// ---------------------------------------------------------------------------

export type EnvelopeKind = "hello" | "rtc:offer" | "rtc:answer" | "rtc:ice" | "rtc:close"

export interface Envelope {
  ver: 1
  ts: number
  nonce: string
  seq: number
  kind: EnvelopeKind
  body: unknown
  mac: string
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
export const SIGNALING_PING_INTERVAL_MS = 25_000

/** Default DataChannel label, matched on both sides. */
export const DATACHANNEL_LABEL = "cognia.v1"

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
  process.env.NEXT_PUBLIC_SIGNALING_URL ?? "wss://signaling.cognia.cn/v1/signaling"
