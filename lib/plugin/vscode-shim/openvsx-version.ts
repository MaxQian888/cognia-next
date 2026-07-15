/**
 * Open VSX version selection.
 *
 * ## `versionAlias: ["latest"]` is not a stability signal
 *
 * The obvious implementation — "take the one aliased `latest`" — is wrong, and
 * the counter-example is the single most popular extension this feature exists
 * to install. Live, on 2026-07-15:
 *
 * ```
 * rust-lang.rust-analyzer -> versionAlias: ["latest", "pre-release"]
 *                            preRelease:   true
 * ```
 *
 * Open VSX's `latest` means *newest published*, not *newest stable*. A client
 * that trusts the alias silently installs a pre-release build on every user who
 * clicked "Install" on a stable-looking listing, and the user has no signal
 * that they opted into anything.
 *
 * So stability is read from the **`preRelease` boolean only**, never from the
 * alias. `versionAlias` is retained on the entry type because the UI may want
 * to *display* it, but it must not drive selection.
 *
 * If an extension publishes nothing but pre-releases, that is surfaced as an
 * explicit `prerelease_only` error rather than quietly installing one — the
 * caller can then re-ask with `allowPrerelease: true` on the user's behalf.
 */

import { compareVersions } from "@/lib/plugin/package/dependency-resolver"

/** The subset of a query entry that version selection needs. */
export interface VersionCandidate {
  version: string
  /** The authoritative stability signal. Absent means stable. */
  preRelease?: boolean
  /** Display-only. Deliberately unused by selection — see the module doc. */
  versionAlias?: string[]
}

export type OpenVsxVersionErrorReason =
  /** No candidates at all. */
  | "no_versions"
  /** Only pre-releases exist and the caller didn't opt in. */
  | "prerelease_only"
  /** An explicitly requested version isn't published. */
  | "version_not_found"

/** Named failure — selection never silently degrades. */
export class OpenVsxVersionError extends Error {
  constructor(
    readonly reason: OpenVsxVersionErrorReason,
    message: string
  ) {
    super(message)
    this.name = "OpenVsxVersionError"
  }
}

export interface ResolveVersionOptions {
  /**
   * Opt in to pre-release builds. This must originate from an explicit user
   * choice; defaulting it to `true` would recreate the exact trap this module
   * exists to prevent.
   */
  allowPrerelease?: boolean
  /** Pin an exact version. Bypasses stability filtering — the user asked. */
  requestedVersion?: string
}

/** Whether a candidate is a pre-release. Absent `preRelease` means stable. */
export function isPrerelease(candidate: VersionCandidate): boolean {
  return candidate.preRelease === true
}

/**
 * Newest-first. Ordering is by version number
 * (`lib/plugin/package/dependency-resolver.ts:compareVersions`), not by the
 * registry's array order — the API happens to return newest-first today, but
 * nothing in the contract promises it.
 */
function newestFirst<T extends VersionCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * Resolve which version to install.
 *
 * Order: explicit `requestedVersion` -> newest stable -> (only with
 * `allowPrerelease`) newest pre-release -> named error.
 *
 * @throws {OpenVsxVersionError}
 */
export function resolveVersion<T extends VersionCandidate>(
  candidates: readonly T[],
  options: ResolveVersionOptions = {}
): T {
  if (candidates.length === 0) {
    throw new OpenVsxVersionError("no_versions", "Open VSX returned no versions for this extension")
  }

  if (options.requestedVersion) {
    const exact = candidates.find((c) => c.version === options.requestedVersion)
    if (!exact) {
      throw new OpenVsxVersionError(
        "version_not_found",
        `Version ${options.requestedVersion} is not published on Open VSX for this extension`
      )
    }
    return exact
  }

  const ordered = newestFirst(candidates)

  const newestStable = ordered.find((c) => !isPrerelease(c))
  if (newestStable) return newestStable

  // Everything published is a pre-release.
  if (options.allowPrerelease) return ordered[0]

  throw new OpenVsxVersionError(
    "prerelease_only",
    `This extension has only pre-release versions on Open VSX (newest: ${ordered[0].version}). Installing it requires explicitly opting in to pre-releases.`
  )
}
