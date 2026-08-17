/**
 * Overlap detection for installed Pi packages.
 *
 * Pi has no package sandbox and no dependency resolver — nothing stops two
 * footers, two MCP adapters, or two permission layers from being installed at
 * once. When that happens they compete for the same hooks and tool names,
 * duplicate prompts, and enlarge the schema surface without adding independent
 * capability. Pi will not warn; this is the only place a user finds out.
 *
 * Pure: the caller supplies the resolved package list. Anything not in the
 * curated catalog is reported as `unknown` rather than assumed safe — a
 * package we have never reviewed is exactly the one most likely to collide.
 */

import { PI_PACKAGE_CATALOG, type PiCatalogEntry, type PiOverlapGroup } from "./catalog"
import { piPackageIdentity } from "./identity"
import { piPackageSourceString, type PiPackageSource } from "./types"

/** One group occupied by more than one installed package. */
export interface PiOverlapConflict {
  group: PiOverlapGroup
  /** Catalog entries involved, in catalog order. */
  entries: PiCatalogEntry[]
}

/** Catalog lookup keyed by Pi's identity rule, so pins do not matter. */
const CATALOG_BY_IDENTITY = new Map<string, PiCatalogEntry>(
  PI_PACKAGE_CATALOG.map((entry) => [piPackageIdentity(entry.spec), entry])
)

/** Resolve installed specs to catalog entries, keeping the unmatched ones. */
export function matchPiCatalog(installed: readonly PiPackageSource[]): {
  known: PiCatalogEntry[]
  unknown: string[]
} {
  const known: PiCatalogEntry[] = []
  const unknown: string[] = []
  const seen = new Set<string>()

  for (const pkg of installed) {
    const spec = piPackageSourceString(pkg)
    const identity = piPackageIdentity(spec)
    if (seen.has(identity)) continue
    seen.add(identity)

    const entry = CATALOG_BY_IDENTITY.get(identity)
    if (entry) known.push(entry)
    else unknown.push(spec)
  }

  // Catalog order is a recommendation ranking; preserve it.
  known.sort((a, b) => PI_PACKAGE_CATALOG.indexOf(a) - PI_PACKAGE_CATALOG.indexOf(b))
  return { known, unknown }
}

/** Groups occupied by two or more installed packages. */
export function detectPiOverlaps(installed: readonly PiPackageSource[]): PiOverlapConflict[] {
  const { known } = matchPiCatalog(installed)
  const byGroup = new Map<PiOverlapGroup, PiCatalogEntry[]>()

  for (const entry of known) {
    for (const group of entry.overlapGroups) {
      const list = byGroup.get(group) ?? []
      list.push(entry)
      byGroup.set(group, list)
    }
  }

  const conflicts: PiOverlapConflict[] = []
  for (const [group, entries] of byGroup) {
    if (entries.length > 1) conflicts.push({ group, entries })
  }
  // Stable output so the graph does not reshuffle between renders.
  conflicts.sort((a, b) => a.group.localeCompare(b.group))
  return conflicts
}

/**
 * Would adding `spec` collide with something already installed? Drives the
 * pre-install gate, which is the only moment the user can act cheaply.
 */
export function piOverlapsForCandidate(
  candidateSpec: string,
  installed: readonly PiPackageSource[]
): PiOverlapConflict[] {
  const candidate = CATALOG_BY_IDENTITY.get(piPackageIdentity(candidateSpec))
  if (!candidate || candidate.overlapGroups.length === 0) return []

  const identity = piPackageIdentity(candidateSpec)
  const others = matchPiCatalog(installed).known.filter(
    (entry) => piPackageIdentity(entry.spec) !== identity
  )

  const conflicts: PiOverlapConflict[] = []
  for (const group of candidate.overlapGroups) {
    const clashing = others.filter((entry) => entry.overlapGroups.includes(group))
    if (clashing.length > 0) conflicts.push({ group, entries: [candidate, ...clashing] })
  }
  conflicts.sort((a, b) => a.group.localeCompare(b.group))
  return conflicts
}

/** Installed packages the research explicitly says not to install. */
export function piDiscouragedPackages(installed: readonly PiPackageSource[]): PiCatalogEntry[] {
  return matchPiCatalog(installed).known.filter((entry) => entry.tier === "avoid")
}
