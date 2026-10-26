/**
 * The plugin contract's share of `lib/share/types.ts`, which re-exports these.
 */
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

/** Wire body for the owner-only `GET /v1/share/:code/stats`. */
export interface ShareStats {
  viewCount: number
  expiresAt?: number
  revoked: boolean
  maxViews?: number
}
