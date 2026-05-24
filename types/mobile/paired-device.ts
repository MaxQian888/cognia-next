/**
 * Mobile-companion paired device record. One row per phone that has
 * completed the QR pairing flow (M2.3). The owner can revoke any row from
 * the desktop's "Mobile companion" settings tab (M2.8).
 */

export type DevicePlatform = "ios" | "android" | "web" | "unknown"

export interface PairedDeviceRow {
  /** UUIDv4, server-generated at pair time. Primary key. */
  deviceId: string

  /** User-supplied label ('Max's iPhone 15'). Capped at 64 chars by the pair API. */
  label: string

  /** Reported by the phone in the pair payload. */
  platform: DevicePlatform

  /**
   * Phone-generated public key (base64-encoded SPKI). Stored for future
   * request signing — V1 device JWT is bearer-only, the pubkey is plumbing
   * for an M2-or-later signed-request enhancement.
   */
  pubkey: string

  /** Epoch ms when the device JWT was issued. */
  pairedAt: number

  /**
   * Epoch ms of the most recent authenticated request from this device.
   * Updated best-effort by the JWT verifier middleware (M2.4) inside a
   * tokio::spawn so it stays off the request critical path.
   */
  lastSeenAt: number

  /**
   * Epoch ms when the owner revoked the device. Soft-delete: the row stays
   * for audit, the JWT verifier consults the deny-list cache to refuse
   * subsequent calls. `undefined` for active devices.
   */
  revokedAt?: number

  /**
   * Epoch ms when the owner *paused* (i.e. temporarily blocked) the device.
   * Unlike `revokedAt`, pause is reversible: the row stays unrevoked, but
   * the device is added to the Rust deny-list so its JWT is rejected.
   * Calling `resumePairedDevice` clears this field and removes the device
   * from the deny-list. Schema v46.
   */
  pausedAt?: number

  /**
   * APNs (iOS) or FCM (Android) push registration token. Populated lazily
   * by M4.6 (push notifications); undefined until the phone registers.
   */
  pushToken?: string

  /**
   * Remote Session Control capability gate. When `true`, this device may
   * issue *control* RPCs (claude_send / claude_interrupt / claude_approve,
   * goal_*, automation_consent_respond, session_attach/detach) — i.e. drive
   * and steer live agent sessions, not just read-only sync. Defaults to
   * absent/`false`: a freshly-paired device can observe + sync but cannot
   * control until the owner explicitly enables this from the desktop
   * paired-devices card (biometric-gated). The Rust `ControlAllowList`
   * mirrors this bit so the per-command gate in `rpc.rs` is an O(1) lookup
   * with no Dexie round-trip. Mirrors the deny-list pattern (ADR remote
   * session control).
   */
  allowRemoteControl?: boolean

  /**
   * Phone app version reported in the pair payload — surfaced in the
   * paired-devices table so the owner can spot stale clients.
   */
  appVersion: string

  /**
   * SHA-256 fingerprint (lower-case hex, 64 chars) of the desktop server's
   * TLS SubjectPublicKeyInfo at pair time. The mobile transport layer pins
   * this fingerprint and refuses to talk to a peer whose presented cert
   * doesn't match. Wave 1.4. Optional for backwards-compat with rows
   * paired before TLS landed.
   */
  serverFingerprint?: string

  /**
   * ADR-0021: public room id used by the WebRTC signaling service to route
   * SDP/ICE messages between this device and the desktop. UUIDv4. Optional
   * for backwards-compat with rows paired before WebRTC support landed —
   * absence disables the WebRTC transport tier for that device.
   */
  rendezvousId?: string

  /**
   * ADR-0021: 32-byte HMAC key (URL-safe base64, unpadded — 43 chars) shared
   * between desktop and this device, minted by the desktop pair handler.
   * Signaling envelopes are HMAC-SHA256-tagged with this secret so the
   * public signaling service can never impersonate either peer. Optional
   * mirror of `rendezvousId`.
   */
  rendezvousSecret?: string
}
