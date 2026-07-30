/**
 * Public surface of `lib/signaling/`. ADR-0021.
 *
 * Consumers:
 *   - `lib/tauri/transport-rtc.ts` (mobile WebRTC driver)
 *   - `src-tauri/src/companion_api/signaling/` (desktop counterpart — Rust)
 */

export {
  buildRoomDescriptorV2,
  buildSubscribeProofV2,
  buildV2Envelope,
  deriveV2DirectionKey,
  exportV2PublicKey,
  generatePersistableV2SigningIdentity,
  generateV2EcdhKeyPair,
  generateV2SigningKeyPair,
  importV2EcdhPublicKey,
  importV2SigningPrivateKey,
  importV2SigningPublicKey,
  StrictReplayWindowV2,
  verifyAndDecryptV2Envelope,
  verifyPeerSessionProofV2,
  verifySubscribeProofV2,
} from "./v2-crypto"
export type { PersistableV2SigningIdentity, SignalingEnvelopeV2, V2KeyPair } from "./v2-crypto"

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
