// Shared types for the Cloudflare-hosted public share-link feature.
//
// A share is a single artifact (a chat export, a workflow image, an A2UI app,
// or a backup package) encrypted client-side and stored as opaque ciphertext
// behind a short code. The decryption key never leaves the client — it lives
// in the URL `#fragment` and the viewer decrypts in the recipient's browser.

export type {
  ShareFileEntry,
  ShareKind,
  SharePayload,
  ShareProvenance,
  ShareStats,
} from "@cognia/plugin-contract/lib/share/types"

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
  /** Seconds until auto-expiry. Omitted ⇒ server maximum (30 days by default).
   * The server clamps requests to its configured maximum; its response is authoritative. */
  ttlSeconds?: number
  /** Max successful views before the link self-destructs. Omitted ⇒ unlimited. */
  maxViews?: number
  /** Delete on first successful view (equivalent to `maxViews: 1`, surfaced separately for UX). */
  burnAfterRead?: boolean
}

/** Wire body for `POST /v1/share`. */
export interface CreateShareRequest extends ShareLifecycle {
  envelope: ShareEnvelopeV1
  /** Non-secret hint; servers derive the authoritative flag from envelope.pp. */
  passphrase?: boolean
}

/** Wire body for the create response. */
export interface CreateShareResponse {
  code: string
  /**
   * Per-share owner secret minted by the worker. Required (via the
   * `X-Owner-Token` header) to call stats/delete on a multi-tenant deployment.
   * Stored locally; never embedded in the shareable URL.
   */
  ownerToken?: string
  expiresAt?: number
}

/** Wire body for `GET /v1/share/:code`. */
export interface ReadShareResponse {
  envelope: ShareEnvelopeV1
  /**
   * Presents to the blob download endpoint (`X-Read-Ticket`) so fetching a
   * share's files does not spend views — and outlives a burn-after-read
   * share's single view by one ticket lifetime. Absent from servers that
   * predate file blobs, or a Worker with no `SHARE_TICKET_KEY`.
   */
  readTicket?: string
  /** Epoch ms after which the ticket stops working. */
  readTicketExpiresAt?: number
}

/** Public, non-consuming GET /v1/share/:code/metadata. Contains no content or secrets. */
export interface SharePublicMetadata {
  passphrase: boolean
  burnAfterRead: boolean
  maxViews?: number
  expiresAt?: number
}
