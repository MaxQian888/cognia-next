/**
 * Wire shapes for the signed update catalog.
 *
 * The trust model follows TUF's role split rather than treating one
 * `latest.json` as the whole security boundary:
 *
 *  - `root`   pins the public keys and the threshold for every other role.
 *  - `targets` lists the actual release entries, one delegation per channel,
 *    so a leaked beta key cannot sign a stable release.
 *  - `snapshot` pins which targets version is current, which stops an
 *    attacker from serving a stale-but-validly-signed targets file.
 *  - `timestamp` is short-lived and proves the feed is live, which is what
 *    closes the freeze attack.
 *
 * Every role carries `expires` and a monotonically increasing `version`. A
 * client that has seen version N refuses N-1 forever after, which is the
 * rollback defence.
 */

import type {
  UpdateAssetKind,
  UpdateChannel,
  UpdateCompatibility,
  UpdateCriticality,
  UpdateExecutor,
  UpdateRollout,
} from "@cognia/agent-config-types"

export type CatalogRole = "root" | "targets" | "snapshot" | "timestamp"

export interface CatalogKey {
  keyid: string
  /** Only ed25519 is accepted. Anything else is rejected, not ignored. */
  keytype: "ed25519"
  /** Lowercase hex of the 32-byte raw public key. */
  publicKey: string
}

export interface CatalogRoleSpec {
  keyids: string[]
  threshold: number
}

export interface CatalogSignature {
  keyid: string
  /** Lowercase hex of the 64-byte ed25519 signature over canonical `signed`. */
  sig: string
}

export interface SignedDocument<T> {
  signed: T
  signatures: CatalogSignature[]
}

export interface CatalogRootPayload {
  _type: "root"
  version: number
  expires: string
  keys: Record<string, CatalogKey>
  roles: Record<CatalogRole, CatalogRoleSpec>
  /** Key ids that must never verify anything again, even if still listed. */
  revokedKeyIds?: string[]
}

export interface CatalogTimestampPayload {
  _type: "timestamp"
  version: number
  expires: string
  /** Version of the snapshot document this timestamp vouches for. */
  snapshotVersion: number
}

export interface CatalogSnapshotPayload {
  _type: "snapshot"
  version: number
  expires: string
  /** Version of the targets document this snapshot pins. */
  targetsVersion: number
}

/** One published release for one asset on one channel. */
export interface CatalogEntry {
  assetId: string
  kind: UpdateAssetKind
  executor: UpdateExecutor
  version: string
  channel: UpdateChannel
  criticality: UpdateCriticality
  releasedAt: string
  releaseNotes?: string
  compatibility?: UpdateCompatibility
  rollout?: UpdateRollout
  sizeBytes?: number
  permissionsExpanded?: boolean
  /** Store or registry landing page for executors Cognia does not drive. */
  externalUrl?: string
  /** Platform triple this entry applies to, for example "darwin-aarch64". */
  target?: string
  /** Download URL for `tauri` executor entries only. */
  url?: string
  /** Detached minisign signature the Tauri updater verifies. */
  signature?: string
  /** Explicitly pulled. Overrides rollout, including a manual check. */
  revoked?: boolean
}

export interface CatalogTargetsPayload {
  _type: "targets"
  version: number
  expires: string
  entries: CatalogEntry[]
}

export interface SignedCatalog {
  root: SignedDocument<CatalogRootPayload>
  timestamp: SignedDocument<CatalogTimestampPayload>
  snapshot: SignedDocument<CatalogSnapshotPayload>
  targets: SignedDocument<CatalogTargetsPayload>
}

/** Client-side trust state carried across checks. */
export interface CatalogTrustState {
  /** Trusted root, seeded from the compiled-in bundle and updated in place. */
  root: CatalogRootPayload
  /** Highest version seen per role. Refusing a lower one is the rollback gate. */
  seenVersions: Partial<Record<CatalogRole, number>>
}

export type CatalogRejectionReason =
  | "signature"
  | "threshold"
  | "expired"
  | "rollback"
  | "revoked-key"
  | "unknown-key"
  | "role-mismatch"
  | "snapshot-mismatch"
  | "malformed"

export class CatalogVerificationError extends Error {
  readonly reason: CatalogRejectionReason
  readonly role: CatalogRole

  constructor(reason: CatalogRejectionReason, role: CatalogRole, message: string) {
    super(message)
    this.name = "CatalogVerificationError"
    this.reason = reason
    this.role = role
  }
}
