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
  | "chat-quote"
  | "workflow-png"
  | "usage-card"
  | "backup"
  | "a2ui"
  | "discover-item"
  | "workflow-result"
  // A published template release (`lib/share/template-definition.ts`). The
  // receiver can prove the body with `verifyTemplateDefinitionHash`.
  | "template-definition"
  // A saved chat template (`lib/share/chat-template.ts`), launch spec demoted.
  | "chat-template"
  // Files and nothing else (ADR-0222): `data` is empty and `files` carries the
  // manifest. Chat kinds may carry `files` too.
  | "file-bundle"

export interface ShareProvenance {
  source: "digital-twin"
  sourceId: string
  disclosure: "ai-generated"
}

/**
 * One file a share carries (ADR-0222). The bytes travel separately as an
 * encrypted blob (`lib/share/blob-crypto.ts`); this manifest row rides inside
 * the envelope's ciphertext, so the server never learns a name, a path or a
 * plaintext size.
 */
export interface ShareFileEntry {
  /** Opaque per-share blob id: 16 random bytes, unpadded base64url. */
  blobId: string
  /** FileSpace path at share time, e.g. `/workspace/report.pdf`. */
  path: string
  name: string
  mime: string
  /** Plaintext bytes. */
  size: number
  /** Hex SHA-256 of the plaintext, verified after the chunks are reassembled. */
  sha256: string
  /** Plaintext bytes per chunk (the last may be shorter). */
  chunkSize: number
  /**
   * Number of encrypted chunks. Zero for an empty file, which has no blob: the
   * server refuses a chunk with nothing but a tag in it.
   */
  chunkCount: number
  /** Base64 of the 8 random bytes every chunk IV of this blob starts with. */
  ivPrefix: string
}

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
  /** Encrypted with the payload; the viewer must render its disclosure. */
  provenance?: ShareProvenance[]
  /** Files the share carries; inside the ciphertext like everything else. */
  files?: ShareFileEntry[]
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

/** Wire body for the owner-only `GET /v1/share/:code/stats`. */
export interface ShareStats {
  viewCount: number
  expiresAt?: number
  revoked: boolean
  maxViews?: number
}

/** Public, non-consuming GET /v1/share/:code/metadata. Contains no content or secrets. */
export interface SharePublicMetadata {
  passphrase: boolean
  burnAfterRead: boolean
  maxViews?: number
  expiresAt?: number
}
