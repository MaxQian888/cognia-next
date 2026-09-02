// PII gate for the backup share link (ADR-0164).
//
// A backup package is the one shareable artifact that must reach the recipient
// byte-for-byte: a redacted backup does not restore faithfully (placeholders
// land in settings, sessions and credentials manifests as real values). So this
// gate never rewrites anything. It scans a plaintext package with
// `@cognia/redact`, groups the hits by the part of the package they live in,
// and hands the report to the UI, which asks the owner to confirm before the
// link is created. An encrypted envelope cannot be inspected at all, so it is
// passed through with a result kind the UI explains as such.
//
// Only string leaves are scanned. A backup is full of numeric timestamps and
// ids, and the redactor's digit-run detectors (bank card, phone) would flag a
// meaningful share of them. PII in a backup is text, and hasNoLeakingPiiDeep
// makes the same call for object-shaped payloads.

import { redactText, type PiiKind } from "@cognia/redact"
import type { BackupPackageV3, BackupPayloadV3, EncryptedEnvelopeV1 } from "@/lib/data/types"

/**
 * Coarse grouping the report is presented in. One entry per user-recognisable
 * area of the package rather than one per table, so the report reads as
 * "3 hits in your conversations" and not as forty Dexie table names.
 */
export type BackupShareDomain =
  | "settings"
  | "sessions"
  | "library"
  | "connectors"
  | "artifacts"
  | "plugins"
  | "twin"
  | "memories"
  | "retrieval"

export const BACKUP_SHARE_DOMAINS: readonly BackupShareDomain[] = [
  "settings",
  "sessions",
  "library",
  "connectors",
  "artifacts",
  "plugins",
  "twin",
  "memories",
  "retrieval",
]

/**
 * Every payload field maps to exactly one domain. Typed as a full record over
 * `keyof BackupPayloadV3` so a new backup field fails to compile until it is
 * placed: the report can never silently skip part of the package.
 */
export const BACKUP_PAYLOAD_DOMAIN: Record<keyof BackupPayloadV3, BackupShareDomain> = {
  settings: "settings",
  providerProfileStore: "settings",
  ttsProviderKeys: "settings",
  trustedWorkspaces: "settings",
  localStorageSnapshots: "settings",
  sessions: "sessions",
  messages: "sessions",
  sessionState: "sessions",
  characters: "library",
  skills: "library",
  skillResources: "library",
  teams: "library",
  promptPresets: "library",
  chatTemplates: "library",
  templateDefinitions: "library",
  templatePackages: "library",
  templateInstances: "library",
  mcpServers: "connectors",
  mcpCredentialManifest: "connectors",
  artifacts: "artifacts",
  artifactVersions: "artifacts",
  canvasDocuments: "artifacts",
  canvasVersions: "artifacts",
  canvasComments: "artifacts",
  contextComments: "artifacts",
  canvasSessions: "artifacts",
  a2uiApps: "artifacts",
  a2uiTemplates: "artifacts",
  a2uiEventHistory: "artifacts",
  plugins: "plugins",
  pluginPermissions: "plugins",
  pluginReviews: "plugins",
  pluginAnalytics: "plugins",
  twinSources: "twin",
  twinChunks: "twin",
  twinProfile: "twin",
  twinDrafts: "twin",
  twinJobs: "twin",
  memories: "memories",
  memoryEvidence: "memories",
  memoryJobs: "memories",
  memoryAuditEvents: "memories",
  retrievalProfiles: "retrieval",
  retrievalEncryptedContent: "retrieval",
  retrievalProfileDeks: "retrieval",
}

export interface BackupShareDomainHits {
  domain: BackupShareDomain
  /** Distinct PII values found in this domain. */
  hits: number
  /** Distinct values per detector kind, kinds with zero hits omitted. */
  byKind: Partial<Record<PiiKind, number>>
}

/** Plaintext package, nothing recognised. Safe to link without interrupting. */
export interface BackupShareScanClean {
  kind: "clean"
  scannedDomains: number
}

/** Plaintext package with recognised PII, grouped by domain, hits descending. */
export interface BackupShareScanHits {
  kind: "hits"
  total: number
  domains: BackupShareDomainHits[]
}

/** Encrypted envelope: the gate cannot look inside and says so. */
export interface BackupShareScanEncrypted {
  kind: "encrypted"
}

export type BackupShareScan = BackupShareScanClean | BackupShareScanHits | BackupShareScanEncrypted

export function isEncryptedBackupEnvelope(
  pkg: BackupPackageV3 | EncryptedEnvelopeV1
): pkg is EncryptedEnvelopeV1 {
  return pkg.version === "enc-v1"
}

/**
 * Collect every string leaf under `value`, one per line. Keys are skipped: a
 * field name is schema, not user data, and scanning it would report the
 * literal word "email" from `settings.email` shapes as nothing while doubling
 * the work.
 */
export function collectStringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.length > 0) out.push(value)
    return out
  }
  if (value === null || typeof value !== "object") return out
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out)
    return out
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectStringLeaves(item, out)
  }
  return out
}

function domainOf(field: string): BackupShareDomain | null {
  return Object.prototype.hasOwnProperty.call(BACKUP_PAYLOAD_DOMAIN, field)
    ? BACKUP_PAYLOAD_DOMAIN[field as keyof BackupPayloadV3]
    : null
}

/**
 * Scan a backup package the owner is about to publish as a share link.
 *
 * Never mutates or redacts the package. A field the type does not know about
 * (a newer writer's additive key read through an older type) is scanned under
 * `settings` rather than dropped, so an unknown field can widen the report but
 * never narrow it.
 */
export function scanBackupForShare(pkg: BackupPackageV3 | EncryptedEnvelopeV1): BackupShareScan {
  if (isEncryptedBackupEnvelope(pkg)) return { kind: "encrypted" }

  const leavesByDomain = new Map<BackupShareDomain, string[]>()
  const payload = (pkg.payload ?? {}) as Record<string, unknown>
  for (const [field, value] of Object.entries(payload)) {
    if (value === undefined) continue
    const domain = domainOf(field) ?? "settings"
    const bucket = leavesByDomain.get(domain) ?? []
    collectStringLeaves(value, bucket)
    if (bucket.length > 0) leavesByDomain.set(domain, bucket)
  }

  const domains: BackupShareDomainHits[] = []
  for (const domain of BACKUP_SHARE_DOMAINS) {
    const leaves = leavesByDomain.get(domain)
    if (!leaves) continue
    const { map } = redactText(leaves.join("\n"))
    const byKind: Partial<Record<PiiKind, number>> = {}
    let hits = 0
    for (const record of Object.values(map)) {
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1
      hits += 1
    }
    if (hits > 0) domains.push({ domain, hits, byKind })
  }

  if (domains.length === 0) return { kind: "clean", scannedDomains: leavesByDomain.size }
  domains.sort((a, b) => b.hits - a.hits)
  return {
    kind: "hits",
    total: domains.reduce((sum, entry) => sum + entry.hits, 0),
    domains,
  }
}
