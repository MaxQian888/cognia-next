/**
 * Typed selectors over the build-time evidence snapshot (ADR-0092 §6).
 *
 * `web/scripts/build-evidence.mjs` does the I/O and writes
 * `web/content/generated/evidence.json`. Everything that involves a judgement
 * — is there a release, which asset belongs to which platform, how do entries
 * group, is this figure stale — lives here so it can be unit-tested.
 */

export type Platform = "macos" | "windows" | "linux"

export type Bump = "major" | "minor" | "patch"

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface Release {
  tagName: string
  name: string
  prerelease: boolean
  publishedAt: string | null
  htmlUrl: string
  /**
   * The published release notes. Changesets writes `CHANGELOG.md` and the
   * release body carries the same aggregated text, so the changelog page reads
   * it from here rather than shipping a second Markdown parser for a file whose
   * content it would only duplicate.
   */
  body: string | null
  assets: ReleaseAsset[]
}

export interface ChangesetEntry {
  id: string
  bump: Bump
  summary: string
  date: string | null
}

/**
 * The figures the capability panorama shows, in display order. Each is a
 * directory listing or a file count over the checkout, taken at build time by
 * `web/scripts/build-inventory.mjs`, and each is reproducible with `ls`.
 */
export const INVENTORY_KEYS = [
  "plugins",
  "connectors",
  "workflowNodeKinds",
  "crates",
  "packages",
  "adrs",
  "testFiles",
] as const

export type InventoryKey = (typeof INVENTORY_KEYS)[number]

export type Inventory = Record<InventoryKey, number>

export interface Evidence {
  readAt: string
  lastGoodReadAt: string | null
  errors: string[]
  repo: { stars: number | null; license: string | null; description: string | null }
  contributors: number | null
  releases: Release[]
  changesets: ChangesetEntry[]
  inventory: Inventory
}

/**
 * A figure of zero means the count did not run, not that the repository holds
 * nothing of the kind, so the panorama shows a dash for it rather than a
 * confident `0`.
 */
export function inventoryFigure(inventory: Inventory, key: InventoryKey): number | null {
  const value = inventory[key]
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Extension patterns per platform, most specific first. `.app.tar.gz` is the
 * macOS updater bundle and must be matched before any generic archive rule, or
 * it reads as a Linux tarball.
 */
const PLATFORM_PATTERNS: Array<[Platform, RegExp]> = [
  ["macos", /(\.dmg|\.app\.tar\.gz|-darwin|_darwin|universal\.app)/i],
  ["windows", /(\.msi|\.exe|-windows|_windows|\.nupkg)/i],
  ["linux", /(\.appimage|\.deb|\.rpm|-linux|_linux)/i],
]

/** Which platform an asset installs, or null when the name does not say. */
export function assetPlatform(name: string): Platform | null {
  for (const [platform, pattern] of PLATFORM_PATTERNS) {
    if (pattern.test(name)) return platform
  }
  return null
}

/**
 * Signature files and update manifests ride along with every release but are
 * not something a person downloads.
 */
export function isInstallerAsset(name: string): boolean {
  return !/(\.sig$|^latest\.json$|\.sha256$|\.asc$)/i.test(name)
}

/** The newest non-prerelease release, or null when none has been published. */
export function latestRelease(evidence: Evidence): Release | null {
  const stable = evidence.releases.filter((release) => !release.prerelease)
  if (stable.length === 0) return null
  return [...stable].sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0
    return bt - at
  })[0]
}

export interface ReleaseState {
  hasRelease: boolean
  version: string | null
  publishedAt: string | null
  htmlUrl: string
  /** Installer assets grouped by the platform they target. */
  byPlatform: Record<Platform, ReleaseAsset[]>
}

const EMPTY_BY_PLATFORM: () => Record<Platform, ReleaseAsset[]> = () => ({
  macos: [],
  windows: [],
  linux: [],
})

/**
 * The download surface's entire input. With no published release this returns
 * `hasRelease: false`, which is what makes the CTA render "Build from source"
 * instead of a link to an empty page (ADR-0092 §7).
 */
export function releaseState(evidence: Evidence, releasesUrl: string): ReleaseState {
  const release = latestRelease(evidence)
  if (!release) {
    return {
      hasRelease: false,
      version: null,
      publishedAt: null,
      htmlUrl: releasesUrl,
      byPlatform: EMPTY_BY_PLATFORM(),
    }
  }

  const byPlatform = EMPTY_BY_PLATFORM()
  for (const asset of release.assets) {
    if (!isInstallerAsset(asset.name)) continue
    const platform = assetPlatform(asset.name)
    if (platform) byPlatform[platform].push(asset)
  }

  // A release with a tag but no recognisable installer cannot honestly offer a
  // download button, so it degrades the same way an absent release does.
  const hasInstaller = Object.values(byPlatform).some((assets) => assets.length > 0)

  return {
    hasRelease: hasInstaller,
    version: release.tagName,
    publishedAt: release.publishedAt,
    htmlUrl: release.htmlUrl || releasesUrl,
    byPlatform,
  }
}

export interface ChangelogGroup {
  /** `YYYY-MM`, or `undated` for entries git could not date. */
  key: string
  entries: ChangesetEntry[]
}

/**
 * How the pending changes divide across the three semver bumps.
 *
 * Every key is present even at zero, so the proportion bar it feeds renders a
 * stable three-segment shape rather than appearing and disappearing as the
 * changeset set shifts.
 */
export function bumpCounts(entries: ChangesetEntry[]): Record<Bump, number> {
  const counts: Record<Bump, number> = { major: 0, minor: 0, patch: 0 }
  for (const entry of entries) {
    // A changeset with an unrecognised bump is skipped rather than counted as a
    // patch: inventing a severity is worse than a bar that does not sum to the
    // entry count, and the count itself is stated separately.
    if (entry.bump in counts) counts[entry.bump] += 1
  }
  return counts
}

/**
 * Group unreleased entries by the month they landed, newest first. Undated
 * entries sort last rather than being dropped — an entry with no git history
 * still describes a real change.
 */
export function groupChangelog(entries: ChangesetEntry[]): ChangelogGroup[] {
  const groups = new Map<string, ChangesetEntry[]>()
  for (const entry of entries) {
    const key = entry.date ? entry.date.slice(0, 7) : "undated"
    const bucket = groups.get(key)
    if (bucket) bucket.push(entry)
    else groups.set(key, [entry])
  }

  for (const bucket of groups.values()) {
    bucket.sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date)
      if (a.date) return -1
      if (b.date) return 1
      return a.id.localeCompare(b.id)
    })
  }

  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === "undated") return 1
      if (b === "undated") return -1
      return b.localeCompare(a)
    })
    .map(([key, bucketEntries]) => ({ key, entries: bucketEntries }))
}

/** Anchor id for a month group, shared by the feed and the index that links to it. */
export function monthAnchor(key: string): string {
  return `month-${key}`
}

/** How many entries a month of the changelog shows before it asks. */
export const CHANGELOG_PAGE_SIZE = 20

export interface Freshness {
  /** The timestamp to show the reader. */
  date: string | null
  /** True when the last build could not reach every source. */
  stale: boolean
}

/**
 * What timestamp to put next to a figure. When the most recent build failed to
 * reach GitHub, the figures on screen came from an earlier read, and the label
 * has to say so rather than implying the number was just checked.
 */
export function freshness(evidence: Evidence): Freshness {
  const stale = evidence.errors.length > 0
  return { date: stale ? evidence.lastGoodReadAt : evidence.readAt, stale }
}

/** `2026-07-26` — stable across locales and timezones, which a reader can verify. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return "—"
  return parsed.toISOString().slice(0, 10)
}

/** `2026-07` → a locale-appropriate month label. */
export function formatMonth(key: string, locale: "en" | "zh"): string {
  if (key === "undated") return locale === "zh" ? "无日期" : "Undated"
  const [year, month] = key.split("-")
  if (!year || !month) return key
  if (locale === "zh") return `${year} 年 ${Number(month)} 月`
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1))
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
}
