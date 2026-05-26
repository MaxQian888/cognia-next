// Shared types for the Cloudflare-hosted public share-link feature.
//
// A share is a single artifact (a chat export, a workflow image, an A2UI app,
// or a backup package) encrypted client-side and stored as opaque ciphertext
// behind a short code. The decryption key never leaves the client — it lives
// in the URL `#fragment` and the viewer decrypts in the recipient's browser.

/** Discriminates how the viewer renders a decrypted payload. */
export type ShareKind =
  | "chat-html"
  | "chat-animated"
  | "chat-md"
  | "chat-json"
  | "chat-text"
  | "workflow-png"
  | "backup"
  | "a2ui"

/**
 * The decrypted artifact. `data` is the artifact bytes: literal UTF-8 text when
 * `encoding === "utf8"`, or base64 of the raw bytes when `encoding === "base64"`
 * (used for binary kinds like `workflow-png`). `kind` + `mime` live *inside* the
 * ciphertext so the storage server learns nothing about the content type.
 */
export interface SharePayload {
  kind: ShareKind
  /** MIME of the artifact before base64, e.g. `text/html`, `image/png`. */
  mime: string
  data: string
  encoding: "utf8" | "base64"
  /** Optional human title shown in the viewer header / document title. */
  title?: string
}

/**
 * The encrypted, server-stored shape. AES-GCM ciphertext + IV + an integrity
 * checksum of the plaintext. `pp` is present only when an extra passphrase is
 * required to derive the key (passphrase is shared out-of-band, never in the URL).
 */
export interface ShareEnvelopeV1 {
  v: 1
  alg: "AES-GCM"
  /** Present iff the AES key is derived from (rawKey ‖ passphrase). */
  pp?: {
    kdf: "PBKDF2"
    hash: "SHA-256"
    iterations: number
    /** Base64 — 16 bytes. */
    salt: string
  }
  /** Base64 — 12 bytes. */
  iv: string
  /** Base64 — AES-GCM ciphertext including the auth tag. */
  ciphertext: string
  /** Hex SHA-256 of the plaintext payload JSON. */
  checksum: string
}

/** Lifecycle controls chosen at creation time. All optional / additive. */
export interface ShareLifecycle {
  /** Seconds until auto-expiry. Omitted ⇒ never expires. */
  ttlSeconds?: number
  /** Max successful views before the link self-destructs. Omitted ⇒ unlimited. */
  maxViews?: number
  /** Delete on first successful view (equivalent to `maxViews: 1`, surfaced separately for UX). */
  burnAfterRead?: boolean
}

/** Wire body for `POST /v1/share`. */
export interface CreateShareRequest extends ShareLifecycle {
  envelope: ShareEnvelopeV1
}

/** Wire body for the create response. */
export interface CreateShareResponse {
  code: string
  expiresAt?: number
}

/** Wire body for `GET /v1/share/:code`. */
export interface ReadShareResponse {
  envelope: ShareEnvelopeV1
}

/** Wire body for the owner-only `GET /v1/share/:code/stats`. */
export interface ShareStats {
  viewCount: number
  expiresAt?: number
  revoked: boolean
  maxViews?: number
}
