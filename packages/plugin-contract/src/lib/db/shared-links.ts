/**
 * The plugin contract's share of `lib/db/shared-links.ts`, which re-exports these.
 */
import type { ShareKind } from "../share/types"

/**
 * What a share carried, kept beside the link so "what did I share from this
 * conversation" is answerable without decrypting anything (ADR-0222). Paths
 * are FileSpace paths at share time.
 */
export interface SharedLinkFileSummary {
  path: string
  size: number
  sha256: string
}

export interface SharedLinkSecretRefs {
  urlFragment?: string
  ownerToken?: string
}

export interface SharedLinkRow {
  /** Local row id. */
  id: string
  /** Short code assigned by the worker; unique. */
  code: string
  kind: ShareKind
  /** Human title carried from the payload, for the list view. */
  title?: string
  /** Non-secret local namespace used by the creating domain for revocation. */
  ownerScope?: string
  /**
   * Full shareable URL including the `#fragment` decryption key. Persisted so
   * the owner can re-copy without re-encrypting; never leaves this device.
   */
  url: string
  createdAt: number
  /** Epoch ms; undefined ⇒ never expires. */
  expiresAt?: number
  maxViews?: number
  burnAfterRead: boolean
  hasPassphrase: boolean
  /**
   * Per-share owner secret returned by the worker at create time. Required to
   * call stats/delete on a multi-tenant deployment. Stays on this device only
   * (never in the shareable URL). Undefined for rows created before this field
   * existed — those fall back to the worker's upload-secret gate.
   */
  ownerToken?: string
  /** References into the encrypted credential store; never sent to callers intentionally. */
  secretRefs?: SharedLinkSecretRefs
  /** Owner-side revoke flag; the worker DELETE is authoritative. */
  revoked: boolean
  /** Files the share carries; absent for a share without files. */
  files?: SharedLinkFileSummary[]
  /** The conversation the share was made from, when it was made from one. */
  sessionId?: string
}
