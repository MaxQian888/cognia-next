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
   * APNs (iOS) or FCM (Android) push registration token. Populated lazily
   * by M4.6 (push notifications); undefined until the phone registers.
   */
  pushToken?: string

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
}
