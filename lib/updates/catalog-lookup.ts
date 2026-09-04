/**
 * Turning verified catalog entries into candidates.
 *
 * Shared by every adapter so channel, revocation, compatibility and version
 * comparison are decided once. An adapter that hand-rolled this would be the
 * place a revoked release quietly came back.
 */

import type {
  UpdateAssetKind,
  UpdateCandidate,
  UpdateChannel,
  UpdateExecutor,
} from "@cognia/agent-config-types"

import type { CatalogEntry } from "./catalog-types"

/** Channels a device on `channel` is allowed to see, most stable first. */
export function visibleChannels(channel: UpdateChannel): UpdateChannel[] {
  if (channel === "canary") return ["stable", "beta", "canary"]
  if (channel === "beta") return ["stable", "beta"]
  return ["stable"]
}

/** Numeric semver compare that tolerates prerelease suffixes and a `v` prefix. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.replace(/^v/i, "").split("-", 2)
    const parts = core.split(".").map((n) => Number.parseInt(n, 10) || 0)
    while (parts.length < 3) parts.push(0)
    return { parts, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1
  }
  // A release outranks any prerelease of the same core version.
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

export function isNewerVersion(candidate: string, current: string | null): boolean {
  if (!current) return true
  return compareVersions(candidate, current) > 0
}

export interface LookupOptions {
  kind: UpdateAssetKind
  assetId: string
  executor: UpdateExecutor
  currentVersion: string | null
  channel: UpdateChannel
  /** Platform triple filter, matched against `entry.target` when both exist. */
  target?: string
  /** Host app version, checked against `compatibility.minAppVersion`. */
  appVersion?: string
}

/**
 * Best candidate for one asset, or null when the catalog offers nothing this
 * device may install. Revoked entries are dropped before any comparison so a
 * pulled release cannot win on version number alone.
 */
export function bestCandidate(
  entries: readonly CatalogEntry[] | null,
  options: LookupOptions
): UpdateCandidate | null {
  if (!entries || entries.length === 0) return null
  const allowed = new Set(visibleChannels(options.channel))

  const matches = entries.filter((entry) => {
    if (entry.revoked) return false
    if (entry.kind !== options.kind) return false
    if (entry.assetId !== options.assetId) return false
    if (!allowed.has(entry.channel)) return false
    if (options.target && entry.target && entry.target !== options.target) return false
    if (!isNewerVersion(entry.version, options.currentVersion)) return false
    const min = entry.compatibility?.minAppVersion
    if (min && options.appVersion && compareVersions(options.appVersion, min) < 0) return false
    const max = entry.compatibility?.maxAppVersion
    if (max && options.appVersion && compareVersions(options.appVersion, max) > 0) return false
    return true
  })

  if (matches.length === 0) return null
  const best = matches.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a))

  return {
    assetId: options.assetId,
    kind: options.kind,
    executor: options.executor,
    currentVersion: options.currentVersion,
    targetVersion: best.version,
    channel: best.channel,
    criticality: best.criticality,
    compatibility: best.compatibility,
    releaseNotes: best.releaseNotes,
    releasedAt: best.releasedAt,
    rollout: best.rollout,
    source: "catalog",
    provenance: "verified",
    sizeBytes: best.sizeBytes,
    permissionsExpanded: best.permissionsExpanded,
    externalUrl: best.externalUrl,
  }
}

/**
 * Whether the catalog has explicitly pulled a specific asset version.
 *
 * Applied by the plugin and skill adapters before they offer a marketplace
 * update, so a revoked publisher or a blocklisted build cannot come back in
 * through a registry that has not caught up yet.
 */
export function isRevokedRelease(
  entries: readonly CatalogEntry[] | null,
  kind: UpdateAssetKind,
  assetId: string,
  version: string
): boolean {
  if (!entries) return false
  return entries.some(
    (entry) =>
      entry.revoked === true &&
      entry.kind === kind &&
      entry.assetId === assetId &&
      (entry.version === version || entry.version === "*")
  )
}

/** Publisher and signature facts the catalog knows about one asset version. */
export function releaseProvenance(
  entries: readonly CatalogEntry[] | null,
  kind: UpdateAssetKind,
  assetId: string,
  version: string
): "verified" | "unsigned" | "revoked" {
  if (isRevokedRelease(entries, kind, assetId, version)) return "revoked"
  if (!entries) return "unsigned"
  const match = entries.find(
    (entry) => entry.kind === kind && entry.assetId === assetId && entry.version === version
  )
  return match ? "verified" : "unsigned"
}
