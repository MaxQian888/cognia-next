/**
 * Public surface of `lib/signaling/`. ADR-0021.
 *
 * Consumers:
 *   - `lib/tauri/transport-rtc.ts` (mobile WebRTC driver)
 *   - `src-tauri/src/companion_api/signaling/` (desktop counterpart — Rust)
 */

export {
  buildRoomDescriptor,
  buildSubscribeProof,
  buildEnvelope,
  deriveDirectionKey,
  exportPublicKey,
  generatePersistableSigningIdentity,
  generateEcdhKeyPair,
  generateSigningKeyPair,
  importEcdhPublicKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  StrictReplayWindow,
  verifyAndDecryptEnvelope,
  verifyPeerSessionProof,
  verifySubscribeProof,
} from "./crypto"
export type { PersistableSigningIdentity, SignalingEnvelope, SignalingKeyPair } from "./crypto"

export { SignalingClient } from "./client"
export type {
  SignalingClientOptions,
  SignalingEventMap,
  SignalingListener,
  SignalingState,
} from "./client"

export {
  REPLAY_CLOCK_SKEW_MS,
  REPLAY_LRU_CAPACITY,
  SIGNALING_BACKOFF_MS,
  SIGNALING_PING_INTERVAL_MS,
  DATACHANNEL_LABEL,
} from "./types"

export { installDesktopSignalingController, normalizeServers } from "./desktop-controller"
export type { DesktopSignalingControllerOptions } from "./desktop-controller"
export { installCompanionSignalingController } from "./mobile-controller"
export type { MobileSignalingControllerOptions } from "./mobile-controller"
export type {
  ClientFrame,
  ServerFrame,
  PeerRole,
  PeerSnapshot,
  Envelope,
  EnvelopeKind,
  HelloBody,
  RtcOfferBody,
  RtcAnswerBody,
  RtcIceBody,
  RtcCloseBody,
} from "./types"
