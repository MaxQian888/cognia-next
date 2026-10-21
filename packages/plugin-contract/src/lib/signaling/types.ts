/**
 * Wire protocol shared between the cognia signaling server (Rust) and the
 * TypeScript clients (mobile + desktop transports). Mirror of
 * `services/signaling-server/src/proto.rs`. Keep the two files in sync — the
 * end-to-end tests in `tests/signaling-server` verify field names match.
 *
 * ADR-0021.
 */

export type PeerRole = "desktop" | "mobile"

export const SIGNALING_PROTOCOL_VERSION = 2 as const

export type RelayLane = "signal" | "data"

export type ClientFrame =
  | { kind: "subscribe"; descriptor: RoomDescriptor; proof: SubscribeProof }
  | { kind: "unsubscribe"; rendezvousId: string }
  | { kind: "relay"; rendezvousId: string; payload: string; lane?: RelayLane }
  | { kind: "ping" }

export interface PeerSnapshot {
  proof: SubscribeProof
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
      lane?: RelayLane
    }
  | { kind: "pong" }
  | { kind: "error"; code: string; message: string }

export type EnvelopeKind = "hello" | "rtc:offer" | "rtc:answer" | "rtc:ice" | "rtc:close" | "data"

export function relayLaneFor(kind: EnvelopeKind): RelayLane {
  return kind === "data" ? "data" : "signal"
}

export interface Envelope {
  ver: typeof SIGNALING_PROTOCOL_VERSION
  roomId: string
  senderRole: PeerRole
  sessionId: string
  epoch: string
  seq: number
  issuedAt: number
  kind: EnvelopeKind
  body: unknown
}

export interface RoomDescriptor {
  v: typeof SIGNALING_PROTOCOL_VERSION
  roomId: string
  roomNonce: string
  desktopSigningKey: string
  mobileSigningKey: string
  notAfter: number
}

export interface SubscribeProof {
  v: typeof SIGNALING_PROTOCOL_VERSION
  roomId: string
  role: PeerRole
  sessionId: string
  epoch: string
  issuedAt: number
  challenge: string
  ecdhPublicKey: string
  signature: string
}

export interface HelloBody {
  deviceId: string
  /**
   * Optional list of ICE servers the sender prefers. Receivers may
   * combine, but the desktop is authoritative for the actual configuration
   * used in `RTCPeerConnection`.
   */
  iceServers?: RTCIceServer[]
  /**
   * ADR-0170: the sender can carry application frames over the rendezvous
   * (`data` envelopes) and is ready to do so now. A Host that agrees answers
   * with its own `hello` carrying the flag; one built before the relay never
   * answers, and the peer then waits for the DataChannel exactly as before.
   */
  relay?: boolean
}

export interface DataBody {
  text?: string
  b64?: string
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

export const REPLAY_CLOCK_SKEW_MS = 5 * 60 * 1000

export const REPLAY_LRU_CAPACITY = 256

export const SIGNALING_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000, 60000] as const

export const SIGNALING_PING_INTERVAL_MS = 20_000

export const DATACHANNEL_LABEL = "cognia.signaling"

export const DEFAULT_SIGNALING_URL =
  process.env.NEXT_PUBLIC_SIGNALING_URL ?? "wss://signaling.cognia.cn/signaling"

export const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
]
