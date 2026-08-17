/**
 * Merge Pi's user and project package lists the way Pi itself does.
 *
 * This is a direct port of `DefaultPackageManager.dedupePackages` from Pi
 * 0.84.1, and the port matters because the obvious implementation is wrong in
 * two different ways:
 *
 *   1. **Do not read a "merged settings" view.** Pi's generic settings merge
 *      (`deepMergeObjects`) treats arrays as non-mergeable, so a merged view
 *      shows the project `packages` array *replacing* the user one. Package
 *      resolution never uses that view — it reads the two scopes separately.
 *      (The merged-view accessor `getPackages()` has zero callers in Pi's
 *      distribution; it is dead code that would mislead anyone porting from
 *      it.) Reading it would make Cognia report a user's 18 packages as gone
 *      the moment a repo declared one of its own.
 *   2. **Project-first ordering is load-bearing.** Pi pushes project entries
 *      before user entries "so cwd resources win collisions", and the dedupe
 *      then relies on that order. Feeding user entries first silently inverts
 *      precedence.
 *
 * The one non-obvious rule: a project entry with `autoload: false` is a
 * *delta* over the user entry rather than a replacement, so both survive, delta
 * first. That is how a repo narrows a globally-installed package without
 * having to redeclare it.
 *
 * Pure: no IO. Callers supply both scopes' arrays and the base dirs used to
 * resolve local paths.
 */

import { piPackageIdentity } from "./identity"
import {
  isPiPackageAutoloaded,
  piPackageSourceString,
  type PiPackageScope,
  type PiPackageSource,
  type ScopedPiPackage,
} from "./types"

export interface PiScopeBaseDirs {
  /** Pi's agent dir — `$PI_CODING_AGENT_DIR` or `<home>/.pi/agent`. */
  user?: string
  /** The project's Pi dir — always `<cwd>/.pi`. */
  project?: string
}

/** A resolved package, with the scope that won and its identity. */
export interface ResolvedPiPackage extends ScopedPiPackage {
  identity: string
  /** True when this entry is a project delta layered over a user entry. */
  isDelta: boolean
}

function baseDirFor(scope: PiPackageScope, baseDirs: PiScopeBaseDirs): string | undefined {
  return scope === "project" ? baseDirs.project : baseDirs.user
}

/**
 * Resolve the effective package list.
 *
 * @param userPackages    `packages` from the user `settings.json`
 * @param projectPackages `packages` from `<cwd>/.pi/settings.json`
 */
export function resolvePiPackages(
  userPackages: readonly PiPackageSource[],
  projectPackages: readonly PiPackageSource[],
  baseDirs: PiScopeBaseDirs = {}
): ResolvedPiPackage[] {
  // Project first — Pi's ordering, and the dedupe below depends on it.
  const all: ScopedPiPackage[] = [
    ...projectPackages.map((pkg) => ({ pkg, scope: "project" as const })),
    ...userPackages.map((pkg) => ({ pkg, scope: "user" as const })),
  ]

  const result: ResolvedPiPackage[] = []
  const seen = new Map<string, number>()

  for (const entry of all) {
    const identity = piPackageIdentity(
      piPackageSourceString(entry.pkg),
      baseDirFor(entry.scope, baseDirs)
    )
    const index = seen.get(identity)

    if (index === undefined) {
      seen.set(identity, result.length)
      result.push({ ...entry, identity, isDelta: false })
      continue
    }

    const existing = result[index]
    if (existing.scope === "project" && entry.scope === "user") {
      // A project entry that disables autoload is a delta over the user
      // entry, so the user entry is kept too (after the delta).
      if (!isPiPackageAutoloaded(existing.pkg)) {
        result.push({ ...entry, identity, isDelta: true })
      }
      continue
    }

    if (entry.scope === "project") result[index] = { ...entry, identity, isDelta: false }
  }

  return result
}

/**
 * Every distinct package identity across both scopes, whether or not it wins.
 * Used by the UI to show "declared in both scopes" without re-running the
 * precedence rules.
 */
export function piPackageScopesByIdentity(
  userPackages: readonly PiPackageSource[],
  projectPackages: readonly PiPackageSource[],
  baseDirs: PiScopeBaseDirs = {}
): Map<string, PiPackageScope[]> {
  const out = new Map<string, PiPackageScope[]>()
  const add = (pkg: PiPackageSource, scope: PiPackageScope) => {
    const identity = piPackageIdentity(piPackageSourceString(pkg), baseDirFor(scope, baseDirs))
    const scopes = out.get(identity) ?? []
    if (!scopes.includes(scope)) scopes.push(scope)
    out.set(identity, scopes)
  }
  for (const pkg of userPackages) add(pkg, "user")
  for (const pkg of projectPackages) add(pkg, "project")
  return out
}
